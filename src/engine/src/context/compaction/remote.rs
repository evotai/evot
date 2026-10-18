//! Remote compaction — provider-native server-side compaction for OpenAI
//! Responses models.
//!
//! GPT/Codex models served over the Responses API support server-side
//! compaction: the conversation to evict is sent with a trailing
//! `compaction_trigger` input item, and the endpoint returns an opaque
//! encrypted `compaction` item that replays with far higher recall than a
//! text summary. Any failure falls back silently to local text
//! summarization — no configuration involved.

use tokio_util::sync::CancellationToken;

use super::summarizer::mode::SummarizerContext;
use crate::context::sanitize::sanitize_tool_pairs;
use crate::provider::stream::http;
use crate::provider::StreamConfig;
use crate::types::AgentMessage;
use crate::types::Content;
use crate::types::Message;
use crate::types::StopReason;
use crate::types::ThinkingMetadata;
use crate::types::Usage;

/// Successful remote compaction: the opaque item to replay in future requests.
#[derive(Debug, Clone)]
pub struct RemoteCompaction {
    /// The opaque `compaction` item returned by the Responses endpoint.
    pub item: serde_json::Value,
    /// Size of the encrypted payload (for observability only).
    pub encrypted_bytes: usize,
}

/// Prefix a removed local summary when transitioning from local compaction to
/// provider-native state. A prior remote compaction already exists as an opaque
/// item in `evicted` and must not be duplicated.
pub fn with_previous_local_summary(
    evicted: &[AgentMessage],
    previous_summary: Option<&str>,
) -> Vec<AgentMessage> {
    let mut input = Vec::with_capacity(evicted.len().saturating_add(1));
    if let Some(summary) = previous_summary.filter(|summary| !summary.trim().is_empty()) {
        input.push(AgentMessage::Llm(Message::User { provenance: None,
            content: vec![Content::Text {
                text: format!(
                    "The conversation history before this point was compacted into the following summary:\n\n{summary}"
                ),
            }],
            timestamp: crate::context::now_ms(),
        }));
    }
    input.extend_from_slice(evicted);
    input
}

/// Build the exact engine message used to replay a native compaction item.
/// `fallback_summary` is visible text only to non-Responses providers; the
/// Responses request builder emits the opaque item from metadata verbatim.
pub fn replacement_message(
    ctx: &SummarizerContext,
    compaction: RemoteCompaction,
    fallback_summary: String,
) -> AgentMessage {
    let provider = ctx
        .model_config
        .as_ref()
        .map(|model| model.provider().to_string())
        .unwrap_or_default();
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Thinking {
            thinking: fallback_summary,
            metadata: Some(ThinkingMetadata::OpenAiResponses {
                item: compaction.item,
            }),
        }],
        stop_reason: StopReason::Stop,
        model: ctx.model.clone(),
        provider,
        usage: Usage::default(),
        timestamp: crate::context::now_ms(),
        error_message: None,
        response_id: None,
    })
}

/// True when a message exists only to carry provider-native compaction state.
pub fn is_replacement_message(message: &AgentMessage) -> bool {
    matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if matches!(content.as_slice(), [Content::Thinking {
                metadata: Some(ThinkingMetadata::OpenAiResponses { item }), ..
            }] if matches!(item.get("type").and_then(|value| value.as_str()),
                Some("compaction" | "compaction_summary")))
    )
}

/// Replace provider-native compaction items with their readable fallback text.
/// Used for one retry when an upstream rejects replay (for example after an
/// account/model boundary). Ordinary Responses reasoning items are preserved.
pub fn downgrade_replay_messages(messages: &[Message]) -> (Vec<Message>, bool) {
    let mut found = false;
    let downgraded = messages
        .iter()
        .cloned()
        .map(|message| match message {
            Message::Assistant {
                content,
                stop_reason,
                model,
                provider,
                usage,
                timestamp,
                error_message,
                response_id,
            } => {
                let content = content
                    .into_iter()
                    .map(|block| match block {
                        Content::Thinking {
                            thinking,
                            metadata: Some(ThinkingMetadata::OpenAiResponses { item }),
                        } if matches!(
                            item.get("type").and_then(|value| value.as_str()),
                            Some("compaction" | "compaction_summary")
                        ) =>
                        {
                            found = true;
                            Content::Text { text: thinking }
                        }
                        other => other,
                    })
                    .collect();
                Message::Assistant {
                    content,
                    stop_reason,
                    model,
                    provider,
                    usage,
                    timestamp,
                    error_message,
                    response_id,
                }
            }
            other => other,
        })
        .collect();
    (downgraded, found)
}

#[derive(Debug, Clone)]
pub enum RemoteError {
    /// Request or protocol failure — caller falls back to local summarization.
    Failed(String),
    /// Cancelled by user — caller aborts compaction entirely.
    Cancelled,
}

/// Whether the current model/provider pair supports remote compaction.
///
/// The capability comes from the model catalog (GPT/Codex first-party models)
/// and requires the Responses transport: only that protocol can replay the
/// opaque `compaction` item in later requests.
pub fn supports(ctx: &SummarizerContext) -> bool {
    unavailable_reason(ctx).is_none()
}

pub fn unavailable_reason(ctx: &SummarizerContext) -> Option<String> {
    let Some(model_config) = &ctx.model_config else {
        return Some("model configuration is unavailable".into());
    };
    model_config
        .remote_compaction_unavailable_reason()
        .map(str::to_string)
}

/// Request server-side compaction of the messages being evicted.
pub async fn compact(
    ctx: &SummarizerContext,
    evicted: &[AgentMessage],
    cancel: CancellationToken,
) -> Result<RemoteCompaction, RemoteError> {
    let model_config = ctx
        .model_config
        .as_ref()
        .ok_or_else(|| RemoteError::Failed("remote compaction requires ModelConfig".into()))?;

    // The evicted zone can cut through tool call/result pairs at its edges;
    // the Responses API rejects unpaired calls, so sanitize first. Do not add
    // `split_prefix` separately: it is already a sub-range of `evicted`.
    let messages: Vec<Message> = sanitize_tool_pairs(evicted.to_vec())
        .into_iter()
        .filter_map(|message| match message {
            AgentMessage::Llm(message) => Some(message),
            AgentMessage::Extension(_) => None,
        })
        .collect();
    if messages.is_empty() {
        return Err(RemoteError::Failed("nothing to compact remotely".into()));
    }

    let config = StreamConfig {
        model: ctx.model.clone(),
        system_prompt: ctx.system_prompt.clone(),
        messages,
        tools: ctx.tools.clone(),
        thinking_level: ctx.thinking_level,
        api_key: ctx.api_key.clone(),
        max_tokens: ctx.max_tokens,
        model_config: ctx.model_config.clone(),
        cache_config: ctx.cache_config.clone(),
        prompt_cache_key: ctx.prompt_cache_key.clone(),
        client: None,
    };
    let mut body = crate::provider::openai_responses::request::build_request_body(&config);
    if let Some(input) = body.get_mut("input").and_then(|v| v.as_array_mut()) {
        input.push(serde_json::json!({"type": "compaction_trigger"}));
    } else {
        return Err(RemoteError::Failed(
            "request body has no input array".into(),
        ));
    }
    // Native compaction returns an opaque state item rather than generated text;
    // Codex-compatible upstreams reject text-generation output budgets here.
    body.as_object_mut()
        .map(|object| object.remove("max_output_tokens"));
    // Compaction items come back encrypted; the include flag must be present
    // even when the reasoning config would otherwise omit it.
    body["include"] = serde_json::json!(["reasoning.encrypted_content"]);

    // Provider-native compaction is still a standalone HTTP request. Do not
    // discover a relay body limit by sending the same multi-megabyte history
    // that triggered compaction; hand control back to the bounded local path.
    let body_bytes = serde_json::to_vec(&body)
        .map_err(|error| RemoteError::Failed(format!("failed to size request body: {error}")))?
        .len();
    if body_bytes > super::config::SUMMARIZER_INPUT_MAX_BYTES {
        return Err(RemoteError::Failed(format!(
            "remote compaction request is {body_bytes} bytes, exceeding the {}-byte safety limit",
            super::config::SUMMARIZER_INPUT_MAX_BYTES
        )));
    }

    let url = format!(
        "{}/responses",
        model_config.base_url().trim_end_matches('/')
    );
    let client =
        crate::provider::error::new_client().map_err(|e| RemoteError::Failed(e.to_string()))?;
    let mut builder = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .header("authorization", format!("Bearer {}", config.api_key));
    for (key, value) in model_config.headers() {
        builder = builder.header(key, value);
    }

    let send = async {
        let response = http::send_stream_request(builder.json(&body))
            .await
            .map_err(|e| RemoteError::Failed(e.to_string()))?;
        let response = http::check_error_status(response)
            .await
            .map_err(|e| RemoteError::Failed(e.to_string()))?;
        response
            .text()
            .await
            .map_err(|e| RemoteError::Failed(e.to_string()))
    };
    let text = tokio::select! {
        result = send => result?,
        _ = cancel.cancelled() => return Err(RemoteError::Cancelled),
    };

    parse_compaction_sse(&text)
}

/// Extract the single `compaction` item from a Responses SSE transcript.
pub fn parse_compaction_sse(text: &str) -> Result<RemoteCompaction, RemoteError> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut completed = false;

    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        match event.get("type").and_then(|t| t.as_str()) {
            Some("response.output_item.done") => {
                let item = &event["item"];
                if item.get("type").and_then(|t| t.as_str()) == Some("compaction") {
                    items.push(item.clone());
                }
            }
            Some("response.completed") => completed = true,
            Some("response.failed") | Some("error") => {
                let message = event
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .and_then(|e| e.get("message"))
                    .or_else(|| event.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Responses API error");
                return Err(RemoteError::Failed(message.to_string()));
            }
            _ => {}
        }
    }

    if !completed {
        return Err(RemoteError::Failed(
            "stream ended before response.completed".into(),
        ));
    }
    if items.len() != 1 {
        return Err(RemoteError::Failed(format!(
            "expected exactly one compaction item, got {}",
            items.len()
        )));
    }
    let item = items.remove(0);
    let encrypted_bytes = item
        .get("encrypted_content")
        .and_then(|c| c.as_str())
        .map(str::len)
        .unwrap_or(0);
    Ok(RemoteCompaction {
        item,
        encrypted_bytes,
    })
}
