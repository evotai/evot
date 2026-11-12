//! Anthropic SSE stream decoding.
//!
//! Parses Anthropic Messages API SSE events and translates them into
//! internal [`StreamEvent`]s while accumulating the final [`Message`].

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use tracing::warn;

use super::types::*;
use crate::provider::error::classify_sse_error_event;
use crate::provider::error::ProviderError;
use crate::provider::stream::http::SseEvent;
use crate::provider::stream::sink::StreamSink;
use crate::provider::stream::sse::SseReader;
use crate::provider::traits::StreamConfig;
use crate::provider::traits::StreamEvent;
use crate::provider::traits::StreamOutcome;
use crate::time::now_ms;
use crate::types::*;

/// Drive an Anthropic SSE stream from a raw HTTP response.
///
/// Parses SSE frames, translates Anthropic event types into [`StreamEvent`]s,
/// and returns the final assembled [`Message::Assistant`].
pub(crate) async fn decode_sse_stream(
    response: reqwest::Response,
    tx: StreamSink,
    cancel: CancellationToken,
    config: &StreamConfig,
) -> Result<StreamOutcome, ProviderError> {
    let mut reader = SseReader::new(response);

    let mut state = AnthropicSseState::default();

    let _ = tx.send(StreamEvent::Start).await;

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                return Err(ProviderError::Cancelled);
            }
            event = reader.next(&cancel) => {
                match event.map_err(ProviderError::Network)? {
                    None => break,
                    Some(sse) => {
                        if process_sse_event(&sse, &tx, &mut state).await? {
                            break;
                        }
                    }
                }
            }
        }
    }

    // Match pi/Anthropic semantics: an SSE response is only complete after
    // message_stop. A clean socket EOF without it is still an interrupted
    // protocol stream, even if the proxy emitted only heartbeat comments and
    // never reached message_start. Using partial content would persist
    // half-written assistant markdown as a normal `stop` response, while
    // treating a heartbeat-only response as empty would enter outage probing.
    if !state.saw_message_stop {
        let reason = if state.saw_message_start {
            "Anthropic stream ended before message_stop"
        } else {
            "Anthropic stream ended before message_start/message_stop"
        };
        return Err(ProviderError::ProtocolIncomplete(reason.into()));
    }

    // Usage does not make an empty completion valid. Some compatible proxies
    // report input/output accounting (even output_tokens=1) while returning no
    // content blocks. Accepting that response persists content=[] and poisons
    // later prompts, so classify it as retryable regardless of token counts.
    if !has_effective_content(&state.content) && state.stop_reason != StopReason::Error {
        return Err(ProviderError::Api(
            "Empty response from provider (no content)".into(),
        ));
    }

    let has_tool_calls = state
        .content
        .iter()
        .any(|c| matches!(c, Content::ToolCall { .. }));
    // Never mask a provider-terminal error (e.g. refusal) as a normal
    // tool_use stop — the error must surface to the caller.
    if has_tool_calls && state.stop_reason != StopReason::Error {
        state.stop_reason = StopReason::ToolUse;
    }

    let served_model = state.fallback_model;
    let message = Message::Assistant {
        content: state.content,
        stop_reason: state.stop_reason,
        model: config.model.clone(),
        provider: config
            .model_config
            .as_ref()
            .map(|model| model.provider().to_string())
            .unwrap_or_else(|| "anthropic".into()),
        usage: state.usage,
        timestamp: now_ms(),
        error_message: state.error_message,
        response_id: state.response_id,
    };

    let _ = tx
        .send(StreamEvent::Done {
            message: message.clone(),
        })
        .await;

    Ok(StreamOutcome::complete(message).served_by(served_model))
}

fn has_effective_content(content: &[Content]) -> bool {
    content.iter().any(|block| match block {
        Content::Text { text } => !text.trim().is_empty(),
        Content::Thinking { thinking, .. } => !thinking.trim().is_empty(),
        Content::Image { .. } | Content::ToolCall { .. } => true,
    })
}

struct AnthropicSseState {
    content: Vec<Content>,
    tool_input_buffers: HashMap<usize, String>,
    usage: Usage,
    stop_reason: StopReason,
    response_id: Option<String>,
    saw_message_start: bool,
    saw_message_stop: bool,
    /// Human-readable reason when the stream terminated with
    /// `StopReason::Error` (e.g. a safety refusal), so the caller sees the
    /// actual cause instead of a generic "Unknown error".
    error_message: Option<String>,
    /// Substitute model from a server-side `fallback` block, if any.
    fallback_model: Option<String>,
}

impl Default for AnthropicSseState {
    fn default() -> Self {
        Self {
            content: Vec::new(),
            tool_input_buffers: HashMap::new(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            response_id: None,
            saw_message_start: false,
            saw_message_stop: false,
            error_message: None,
            fallback_model: None,
        }
    }
}

fn parse_event_data<T: DeserializeOwned>(sse: &SseEvent) -> Result<T, ProviderError> {
    serde_json::from_str::<T>(&sse.data).map_err(|e| {
        ProviderError::Api(format!(
            "Could not parse Anthropic SSE event {}: {}; data={}",
            sse.event, e, sse.data
        ))
    })
}

fn map_stop_reason(reason: &str) -> Result<StopReason, ProviderError> {
    match reason {
        "end_turn" => Ok(StopReason::Stop),
        "max_tokens" => Ok(StopReason::Length),
        "tool_use" => Ok(StopReason::ToolUse),
        // Mirrors pi: pause_turn/stop_sequence are safe stop-like terminal
        // reasons here. We do not configure stop sequences, so seeing one is
        // unusual but still provider-terminal rather than stream-corrupt.
        "pause_turn" | "stop_sequence" => Ok(StopReason::Stop),
        // Safety/refusal terminal reasons should not be silently reported as a
        // successful stop.
        "refusal" | "sensitive" => Ok(StopReason::Error),
        other => Err(ProviderError::Api(format!(
            "Unhandled Anthropic stop reason: {other}"
        ))),
    }
}

async fn process_sse_event(
    sse: &SseEvent,
    tx: &StreamSink,
    state: &mut AnthropicSseState,
) -> Result<bool, ProviderError> {
    match sse.event.as_str() {
        "message_start" => {
            state.saw_message_start = true;
            let data = parse_event_data::<AnthropicMessageStart>(sse)?;
            state.usage.input = data.message.usage.input_tokens.unwrap_or(0);
            state.usage.output = data.message.usage.output_tokens.unwrap_or(0);
            state.usage.cache_read = data.message.usage.cache_read_input_tokens.unwrap_or(0);
            state.usage.cache_write = data.message.usage.cache_creation_input_tokens.unwrap_or(0);
            state.usage.reasoning_output = data
                .message
                .usage
                .output_tokens_details
                .as_ref()
                .map(|details| details.thinking_tokens)
                .unwrap_or(0);
            state.usage.refresh_total_tokens();
            if let Some(id) = data.message.id {
                if !id.is_empty() {
                    state.response_id = Some(id);
                }
            }
        }
        "content_block_start" => {
            let data = parse_event_data::<AnthropicContentBlockStart>(sse)?;
            let idx = data.index as usize;
            // Fill index gaps (from unknown blocks) with empty text
            // placeholders — never clones of the current block, which would
            // duplicate tool_use ids and get every later request rejected.
            while state.content.len() < idx {
                state.content.push(Content::Text {
                    text: String::new(),
                });
            }
            let block = match data.content_block {
                AnthropicContentBlock::Text { .. } => Content::Text {
                    text: String::new(),
                },
                AnthropicContentBlock::Thinking { .. } => Content::Thinking {
                    thinking: String::new(),
                    metadata: None,
                },
                AnthropicContentBlock::ToolUse { id, name, .. } => {
                    let _ = tx
                        .send(StreamEvent::ToolCallStart {
                            content_index: idx,
                            id: id.clone(),
                            name: name.clone(),
                        })
                        .await;
                    Content::ToolCall {
                        id,
                        name,
                        arguments: serde_json::Value::Object(Default::default()),
                        metadata: None,
                    }
                }
                AnthropicContentBlock::Fallback { to } => {
                    if let Some(model) = to.and_then(|t| t.model) {
                        if !model.is_empty() {
                            state.fallback_model = Some(model);
                        }
                    }
                    Content::Text {
                        text: String::new(),
                    }
                }
                AnthropicContentBlock::Other => Content::Text {
                    text: String::new(),
                },
            };
            if state.content.len() == idx {
                state.content.push(block);
            } else if let Some(slot) = state.content.get_mut(idx) {
                *slot = block;
            }
        }
        "content_block_delta" => {
            let data = parse_event_data::<AnthropicContentBlockDelta>(sse)?;
            let idx = data.index as usize;
            match data.delta {
                AnthropicDelta::TextDelta { text } => {
                    if let Some(Content::Text { text: ref mut t }) = state.content.get_mut(idx) {
                        t.push_str(&text);
                    }
                    let _ = tx
                        .send(StreamEvent::TextDelta {
                            content_index: idx,
                            delta: text,
                        })
                        .await;
                }
                AnthropicDelta::ThinkingDelta { thinking } => {
                    if let Some(Content::Thinking {
                        thinking: ref mut t,
                        ..
                    }) = state.content.get_mut(idx)
                    {
                        t.push_str(&thinking);
                    }
                    let _ = tx
                        .send(StreamEvent::ThinkingDelta {
                            content_index: idx,
                            delta: thinking,
                        })
                        .await;
                }
                AnthropicDelta::InputJsonDelta { partial_json } => {
                    let input = state.tool_input_buffers.entry(idx).or_default();
                    input.push_str(&partial_json);
                    if let Some(Content::ToolCall { id, name, .. }) = state.content.get(idx) {
                        let _ = tx
                            .send(StreamEvent::ToolCallDelta {
                                content_index: idx,
                                id: id.clone(),
                                name: name.clone(),
                                delta: partial_json,
                            })
                            .await;
                    }
                }
                AnthropicDelta::SignatureDelta { signature } => {
                    if let Some(Content::Thinking {
                        metadata: ref mut value,
                        ..
                    }) = state.content.get_mut(idx)
                    {
                        *value = Some(ThinkingMetadata::Anthropic { signature });
                    }
                }
                // Unknown delta type: ignore for forward compatibility.
                AnthropicDelta::Other => {}
            }
        }
        "content_block_stop" => {
            let data = parse_event_data::<serde_json::Value>(sse)?;
            let idx = data["index"].as_u64().unwrap_or(0) as usize;
            let input = state.tool_input_buffers.remove(&idx).unwrap_or_default();
            let mut finalized = None;
            if let Some(Content::ToolCall {
                id,
                name,
                arguments,
                ..
            }) = state.content.get_mut(idx)
            {
                if !input.is_empty() {
                    match crate::provider::json_repair::try_repair_json(&input) {
                        Ok(parsed) => *arguments = parsed,
                        Err(e) => debug!("Failed to parse tool call JSON: {} ({})", input, e),
                    }
                }
                finalized = Some((id.clone(), name.clone(), arguments.clone()));
            }
            if let Some((id, name, arguments)) = finalized {
                let _ = tx
                    .send(StreamEvent::ToolCallEnd {
                        content_index: idx,
                        id,
                        name,
                        arguments,
                    })
                    .await;
            }
        }
        "message_delta" => {
            let data = parse_event_data::<AnthropicMessageDelta>(sse)?;
            if let Some(reason) = data.delta.stop_reason.as_deref() {
                state.stop_reason = map_stop_reason(reason)?;
                if state.stop_reason == StopReason::Error {
                    let category = data
                        .delta
                        .stop_details
                        .as_ref()
                        .and_then(|details| details.category.as_deref());
                    state.error_message = Some(
                        crate::provider::error::refusal_message_with_category(reason, category),
                    );
                }
            }
            // Preserve message_start values for fields omitted by message_delta.
            if let Some(input) = data.usage.input_tokens {
                state.usage.input = input;
            }
            if let Some(output) = data.usage.output_tokens {
                state.usage.output = output;
            }
            if let Some(cache_read) = data.usage.cache_read_input_tokens {
                state.usage.cache_read = cache_read;
            }
            if let Some(cache_write) = data.usage.cache_creation_input_tokens {
                state.usage.cache_write = cache_write;
            }
            if let Some(details) = data.usage.output_tokens_details {
                state.usage.reasoning_output = details.thinking_tokens;
            }
            state.usage.refresh_total_tokens();
        }
        "message_stop" => {
            let _ = parse_event_data::<serde_json::Value>(sse)?;
            state.saw_message_stop = true;
            return Ok(true);
        }
        "ping" | "message" => {}
        "error" => {
            // Surface the exact malformed model output when the gateway rejects a
            // tool call. Two sources, in priority order:
            //   1. The `raw` field the gateway attaches to the error payload —
            //      the model's original text when it couldn't assemble a valid
            //      tool_use block at all (nothing was streamed to us).
            //   2. Any tool-call JSON we buffered from streamed deltas before the
            //      error arrived.
            // Either way this is our only window into the bad format, since the
            // error path discards the partial content.
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&sse.data) {
                if let Some(raw) = payload
                    .get("error")
                    .and_then(|e| e.get("raw"))
                    .and_then(|r| r.as_str())
                {
                    warn!(
                        raw_tool_json = raw,
                        "provider error with raw tool-call JSON from gateway"
                    );
                }
            }
            if !state.tool_input_buffers.is_empty() {
                for (idx, raw) in &state.tool_input_buffers {
                    warn!(
                        block_index = idx,
                        raw_tool_json = raw.as_str(),
                        "provider error with buffered tool-call JSON"
                    );
                }
            }
            return Err(classify_sse_error_event(&sse.data));
        }
        other => {
            debug!("Unknown Anthropic event: {}", other);
        }
    }
    Ok(false)
}
