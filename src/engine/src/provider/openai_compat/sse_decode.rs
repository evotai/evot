//! OpenAI-compatible SSE stream decoding.
//!
//! Parses OpenAI Chat Completions streaming chunks and translates them
//! into internal [`StreamEvent`]s while accumulating the final [`Message`].

use tokio_util::sync::CancellationToken;
use tracing::debug;

use super::reasoning_details;
use super::request::ToolCallBuffer;
use super::types::*;
use crate::context::now_ms;
use crate::provider::error::classify_stream_error;
use crate::provider::error::ProviderError;
use crate::provider::route::OpenAiCompat;
use crate::provider::route::ThinkingFormat;
use crate::provider::stream::http::SseEvent;
use crate::provider::stream::sink::StreamSink;
use crate::provider::stream::sse::SseReader;
use crate::provider::traits::StreamConfig;
use crate::provider::traits::StreamEvent;
use crate::provider::traits::StreamOutcome;
use crate::types::*;

/// Drive an OpenAI-compatible SSE stream from a raw HTTP response.
pub(crate) async fn decode_sse_stream(
    response: reqwest::Response,
    tx: StreamSink,
    cancel: CancellationToken,
    config: &StreamConfig,
    compat: &OpenAiCompat,
) -> Result<StreamOutcome, ProviderError> {
    let mut reader = SseReader::new(response);

    let mut content: Vec<Content> = Vec::new();
    let mut usage = Usage::default();
    let mut stop_reason = StopReason::Stop;
    let mut tool_call_buffers: Vec<ToolCallBuffer> = Vec::new();
    let mut response_id: Option<String> = None;
    let mut response_model: Option<String> = None;
    let mut incomplete_reason: Option<String> = None;

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
                        if sse.data == "[DONE]" {
                            break;
                        }
                        process_sse_chunk(
                            &sse,
                            &tx,
                            &mut content,
                            &mut usage,
                            &mut stop_reason,
                            &mut tool_call_buffers,
                            compat,
                            &mut response_id,
                            &mut response_model,
                            &mut incomplete_reason,
                        ).await?;
                    }
                }
            }
        }
    }

    // `finish_reason: content_filter` means the output was stopped by the
    // safety filter: surface it as an error so refusal recovery can compact,
    // never as a normal completion or a tool call.
    let refused = incomplete_reason
        .as_deref()
        .is_some_and(crate::provider::error::is_content_filter_reason);

    // Detect empty response: no content and no usage from provider
    if !refused
        && content.is_empty()
        && tool_call_buffers.is_empty()
        && usage.input == 0
        && usage.output == 0
    {
        return Err(ProviderError::Api(
            "Empty response from provider (no content, no usage)".into(),
        ));
    }

    // Finalize tool calls
    finalize_tool_calls(&tx, &mut content, &tool_call_buffers).await;

    if refused {
        stop_reason = StopReason::Error;
    } else if !tool_call_buffers.is_empty()
        || content
            .iter()
            .any(|c| matches!(c, Content::ToolCall { .. }))
    {
        stop_reason = StopReason::ToolUse;
    }

    let message = Message::Assistant {
        content,
        stop_reason,
        model: config.model.clone(),
        provider: config
            .model_config
            .as_ref()
            .map(|mc| mc.provider().to_string())
            .unwrap_or_else(|| "openai".into()),
        usage,
        timestamp: now_ms(),
        error_message: incomplete_reason
            .as_deref()
            .map(crate::provider::error::incomplete_message),
        response_id,
    };

    let _ = tx
        .send(StreamEvent::Done {
            message: message.clone(),
        })
        .await;
    Ok(StreamOutcome::complete(message).served_by(response_model))
}

#[allow(clippy::too_many_arguments)]
async fn process_sse_chunk(
    sse: &SseEvent,
    tx: &StreamSink,
    content: &mut Vec<Content>,
    usage: &mut Usage,
    stop_reason: &mut StopReason,
    tool_call_buffers: &mut Vec<ToolCallBuffer>,
    compat: &OpenAiCompat,
    response_id: &mut Option<String>,
    response_model: &mut Option<String>,
    incomplete_reason: &mut Option<String>,
) -> Result<(), ProviderError> {
    let chunk: OpenAiChunk = match serde_json::from_str(&sse.data) {
        Ok(c) => c,
        Err(e) => {
            debug!("Failed to parse OpenAI chunk: {} data={}", e, &sse.data);
            return Ok(());
        }
    };

    if let Some(details) = &chunk.incomplete_details {
        if !details.reason.is_empty() {
            *incomplete_reason = Some(details.reason.clone());
        }
    }

    // Check for inline error (non-standard but used by some proxies)
    if let Some(err) = &chunk.error {
        let msg = if err.message.is_empty() {
            sse.data.clone()
        } else {
            err.message.clone()
        };
        debug!("OpenAI stream error: {}", msg);
        // Classify with the full chunk JSON so a structured `error.type`
        // is honoured even when only the message is surfaced to the user.
        let value = serde_json::from_str::<serde_json::Value>(&sse.data).ok();
        return Err(classify_stream_error(&msg, value.as_ref()));
    }

    // Capture response id and model from the first chunk
    if response_id.is_none() {
        if let Some(id) = &chunk.id {
            if !id.is_empty() {
                *response_id = Some(id.clone());
            }
        }
    }
    if response_model.is_none() {
        if let Some(m) = &chunk.model {
            if !m.is_empty() {
                *response_model = Some(m.clone());
            }
        }
    }

    // OpenAI includes cached tokens in prompt_tokens.
    if let Some(u) = &chunk.usage {
        let cache_read = u
            .prompt_tokens_details
            .as_ref()
            .map(|details| details.cached_tokens)
            .unwrap_or(u.prompt_cache_hit_tokens);
        let cache_write = u
            .prompt_tokens_details
            .as_ref()
            .map(|details| details.cache_write_tokens)
            .unwrap_or(0);
        usage.input = u
            .prompt_tokens
            .saturating_sub(cache_read)
            .saturating_sub(cache_write);
        usage.output = u.completion_tokens;
        usage.total_tokens = usage
            .input
            .saturating_add(usage.output)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        usage.cache_read = cache_read;
        usage.cache_write = cache_write;
        if let Some(details) = &u.completion_tokens_details {
            usage.reasoning_output = details.reasoning_tokens;
        }
    }

    for choice in &chunk.choices {
        let delta = &choice.delta;

        // Compatible endpoints may expose the same reasoning delta under
        // multiple aliases. Prefer the provider's configured replay field, then
        // fall back across aliases for proxies that don't honor that setting.
        let reasoning_fields = match compat.thinking_format {
            ThinkingFormat::Xai => [
                (ReasoningField::Reasoning, delta.reasoning.as_deref()),
                (
                    ReasoningField::ReasoningContent,
                    delta.reasoning_content.as_deref(),
                ),
                (
                    ReasoningField::ReasoningText,
                    delta.reasoning_text.as_deref(),
                ),
            ],
            _ => [
                (
                    ReasoningField::ReasoningContent,
                    delta.reasoning_content.as_deref(),
                ),
                (ReasoningField::Reasoning, delta.reasoning.as_deref()),
                (
                    ReasoningField::ReasoningText,
                    delta.reasoning_text.as_deref(),
                ),
            ],
        };
        let reasoning = reasoning_fields.into_iter().find_map(|(field, value)| {
            value
                .filter(|value| !value.is_empty())
                .map(|value| (field, value))
        });
        if let Some((reasoning_field, reasoning_text)) = reasoning {
            // Only coalesce contiguous reasoning. Some compatible providers
            // interleave reasoning and visible text; appending later reasoning
            // to the first block makes the UI rewrite content above an answer
            // that is already streaming below it.
            let idx = ensure_thinking_block(content, reasoning_field);
            if let Some(Content::Thinking { thinking, .. }) = content.get_mut(idx) {
                thinking.push_str(reasoning_text);
            }
            let _ = tx
                .send(StreamEvent::ThinkingDelta {
                    content_index: idx,
                    delta: reasoning_text.to_string(),
                })
                .await;
        }

        // `reasoning_details` are replay metadata rather than user-visible
        // deltas: accumulate them on the current thinking block so the
        // opaque state is sent back with the next request. A block is kept
        // even when no reasoning text ever arrives (encrypted-only models).
        if let Some(details) = &delta.reasoning_details {
            let valid: Vec<&serde_json::Value> = details
                .iter()
                .filter(|detail| reasoning_details::is_reasoning_detail(detail))
                .collect();
            if !valid.is_empty() {
                let idx = ensure_thinking_block(content, ReasoningField::ReasoningContent);
                if let Some(Content::Thinking {
                    metadata:
                        Some(ThinkingMetadata::OpenAiCompletions {
                            details: stored, ..
                        }),
                    ..
                }) = content.get_mut(idx)
                {
                    let items = stored.get_or_insert_with(Vec::new);
                    for detail in valid {
                        reasoning_details::append_reasoning_detail(items, detail.clone());
                    }
                }
            }
        }

        // Handle text content. As with reasoning, preserve type transitions so
        // every new delta extends the tail instead of mutating an earlier row.
        if let Some(text) = &delta.content {
            let idx = if matches!(content.last(), Some(Content::Text { .. })) {
                content.len() - 1
            } else {
                content.push(Content::Text {
                    text: String::new(),
                });
                content.len() - 1
            };
            if let Some(Content::Text { text: t }) = content.get_mut(idx) {
                t.push_str(text);
            }
            let _ = tx
                .send(StreamEvent::TextDelta {
                    content_index: idx,
                    delta: text.clone(),
                })
                .await;
        }

        // Handle tool calls
        if let Some(tool_calls) = &delta.tool_calls {
            for tc in tool_calls {
                let tc_index = tc.index as usize;
                while tool_call_buffers.len() <= tc_index {
                    tool_call_buffers.push(ToolCallBuffer::default());
                }
                let buf = &mut tool_call_buffers[tc_index];
                let content_index = match buf.content_index {
                    Some(index) => index,
                    None => {
                        // Reserve the provider block position immediately. Text
                        // or reasoning may arrive after the tool-call start;
                        // waiting until finalize would move the tool to the end
                        // and make streamed content_index disagree with the
                        // completed Message order.
                        let index = content.len();
                        content.push(Content::ToolCall {
                            id: String::new(),
                            name: String::new(),
                            arguments: serde_json::Value::Object(Default::default()),
                            metadata: None,
                        });
                        buf.content_index = Some(index);
                        index
                    }
                };
                if let Some(id) = &tc.id {
                    buf.id = id.clone();
                }
                if let Some(f) = &tc.function {
                    if let Some(name) = &f.name {
                        buf.name.clone_from(name);
                    }
                    if let Some(args) = &f.arguments {
                        buf.arguments.push_str(args);
                    }
                }

                if !buf.started && (!buf.id.is_empty() || !buf.name.is_empty()) {
                    buf.started = true;
                    let _ = tx
                        .send(StreamEvent::ToolCallStart {
                            content_index,
                            id: buf.id.clone(),
                            name: buf.name.clone(),
                        })
                        .await;
                }
                if let Some(delta) = tc
                    .function
                    .as_ref()
                    .and_then(|function| function.arguments.as_ref())
                {
                    if buf.started && !delta.is_empty() {
                        let _ = tx
                            .send(StreamEvent::ToolCallDelta {
                                content_index,
                                id: buf.id.clone(),
                                name: buf.name.clone(),
                                delta: delta.clone(),
                            })
                            .await;
                    }
                }
            }
        }

        // Handle finish reason
        if let Some(reason) = &choice.finish_reason {
            if crate::provider::error::is_content_filter_reason(reason) {
                // Finalized as a refusal after the stream ends.
                *incomplete_reason = Some(reason.clone());
            }
            *stop_reason = match reason.as_str() {
                "stop" => StopReason::Stop,
                "length" => StopReason::Length,
                "tool_calls" => StopReason::ToolUse,
                _ => StopReason::Stop,
            };
        }
    }

    Ok(())
}

/// Index of the trailing thinking block, creating one when the last block
/// is not thinking so reasoning never rewrites content already streamed
/// below it.
fn ensure_thinking_block(content: &mut Vec<Content>, field: ReasoningField) -> usize {
    if matches!(content.last(), Some(Content::Thinking { .. })) {
        return content.len() - 1;
    }
    content.push(Content::Thinking {
        thinking: String::new(),
        metadata: Some(ThinkingMetadata::completions_text_only(field)),
    });
    content.len() - 1
}

async fn finalize_tool_calls(
    tx: &StreamSink,
    content: &mut Vec<Content>,
    tool_call_buffers: &[ToolCallBuffer],
) {
    for buf in tool_call_buffers.iter() {
        let args = crate::provider::json_repair::try_repair_json(&buf.arguments)
            .unwrap_or(serde_json::Value::Object(Default::default()));
        let content_index = match buf.content_index {
            Some(index) => index,
            None => content.len(),
        };
        let tool_call = Content::ToolCall {
            id: buf.id.clone(),
            name: buf.name.clone(),
            arguments: args.clone(),
            metadata: None,
        };
        if content_index < content.len() {
            content[content_index] = tool_call;
        } else {
            // Buffer indices are allocated from the next free content slot. If
            // a malformed stream leaves a gap, append rather than inventing
            // placeholder blocks; emitted and final indices still agree for all
            // well-formed streams.
            content.push(tool_call);
        }
        let _ = tx
            .send(StreamEvent::ToolCallEnd {
                content_index,
                id: buf.id.clone(),
                name: buf.name.clone(),
                arguments: args,
            })
            .await;
    }
}
