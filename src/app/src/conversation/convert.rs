//! Message conversion — between engine AgentMessages and TranscriptItems.

use crate::observability::UsageSummary;
use crate::types::AssistantBlock;
use crate::types::TranscriptImageSource;
use crate::types::TranscriptItem;
use crate::types::TranscriptUserContent;

/// Extract text content from engine Content blocks.
pub fn extract_content_text(content: &[evot_engine::Content]) -> String {
    content
        .iter()
        .filter_map(|c| {
            if let evot_engine::Content::Text { text } = c {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Convert engine AgentMessages to TranscriptItems.
pub fn from_agent_messages(messages: &[evot_engine::AgentMessage]) -> Vec<TranscriptItem> {
    messages.iter().map(transcript_from_agent_message).collect()
}

/// Convert TranscriptItems to engine AgentMessages.
pub fn into_agent_messages(items: &[TranscriptItem]) -> Vec<evot_engine::AgentMessage> {
    let mut messages: Vec<_> = items.iter().map(agent_message_from_transcript).collect();
    evot_engine::migrate_legacy_responses_tool_ids(&mut messages);
    messages
}

/// Convert a single engine AgentMessage to a TranscriptItem.
pub fn transcript_from_agent_message(message: &evot_engine::AgentMessage) -> TranscriptItem {
    match message {
        evot_engine::AgentMessage::Llm(evot_engine::Message::User {
            content,
            provenance,
            ..
        }) => {
            let mut item = TranscriptItem::user_from_content(content);
            if let TranscriptItem::User {
                provenance: saved, ..
            } = &mut item
            {
                *saved = provenance.clone();
            }
            item
        }
        evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
            content,
            stop_reason,
            model,
            provider,
            usage,
            timestamp,
            error_message,
            ..
        }) => TranscriptItem::Assistant {
            content: assistant_blocks_from_content(content),
            stop_reason: stop_reason.to_string(),
            usage: usage_summary_from_engine(usage),
            model: model.clone(),
            provider: provider.clone(),
            timestamp: *timestamp,
            error_message: error_message.clone(),
        },
        evot_engine::AgentMessage::Llm(evot_engine::Message::ToolResult {
            tool_call_id,
            tool_name,
            content,
            is_error,
            ..
        }) => {
            let text = extract_content_text(content);
            TranscriptItem::ToolResult {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                content: text,
                is_error: *is_error,
                // The engine's `Message::ToolResult` carries no details (they
                // ride on the `ToolExecutionEnd` event, persisted directly in
                // runtime.rs). This path converts history messages that have
                // already been stripped to content, so details is null here.
                details: serde_json::Value::Null,
            }
        }
        evot_engine::AgentMessage::Extension(ext) => TranscriptItem::Extension {
            kind: ext.kind.clone(),
            data: ext.data.clone(),
        },
    }
}

/// Timestamp for history items whose original time was not persisted.
///
/// `ContextTracker` only trusts an assistant's usage as a context anchor when
/// that assistant is not older than any message before it. Stamping replayed
/// user / tool-result items with the resume time would make every stored
/// assistant look stale, discard the provider's own token counts, and fall back
/// to the full-history byte estimate (which showed "212%" of the window after a
/// resume). Zero means "time unknown" and never invalidates an anchor.
const HISTORY_TIMESTAMP_UNKNOWN: u64 = 0;

/// Convert a single TranscriptItem to an engine AgentMessage.
pub fn agent_message_from_transcript(item: &TranscriptItem) -> evot_engine::AgentMessage {
    match item {
        TranscriptItem::User {
            text,
            content,
            provenance,
        } => {
            let content = if content.is_empty() {
                vec![evot_engine::Content::Text { text: text.clone() }]
            } else {
                content
                    .iter()
                    .map(|item| match item {
                        TranscriptUserContent::Text { text } => {
                            evot_engine::Content::Text { text: text.clone() }
                        }
                        TranscriptUserContent::Image { mime_type, source } => {
                            let source = match source {
                                TranscriptImageSource::Path { path } => {
                                    evot_engine::ImageSource::Path { path: path.clone() }
                                }
                                TranscriptImageSource::Base64 { data } => {
                                    evot_engine::ImageSource::Base64 { data: data.clone() }
                                }
                            };
                            evot_engine::Content::Image {
                                mime_type: mime_type.clone(),
                                source,
                            }
                        }
                    })
                    .collect()
            };
            evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                provenance: provenance.clone(),
                content,
                timestamp: HISTORY_TIMESTAMP_UNKNOWN,
            })
        }
        TranscriptItem::Assistant {
            content,
            stop_reason,
            usage,
            model,
            provider,
            timestamp,
            error_message,
        } => evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
            content: engine_content_from_assistant_blocks(content),
            stop_reason: parse_stop_reason(stop_reason),
            model: model.clone(),
            provider: provider.clone(),
            usage: engine_usage_from_summary(usage),
            timestamp: *timestamp,
            error_message: error_message.clone(),
            response_id: None,
        }),
        TranscriptItem::ToolResult {
            tool_call_id,
            tool_name,
            content,
            is_error,
            ..
        } => evot_engine::AgentMessage::Llm(evot_engine::Message::ToolResult {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            content: vec![evot_engine::Content::Text {
                text: content.clone(),
            }],
            is_error: *is_error,
            timestamp: HISTORY_TIMESTAMP_UNKNOWN,
            retention: evot_engine::Retention::Normal,
        }),
        TranscriptItem::System { text } => evot_engine::AgentMessage::Extension(
            evot_engine::ExtensionMessage::new("system", serde_json::json!({ "text": text })),
        ),
        TranscriptItem::Extension { kind, data } => evot_engine::AgentMessage::Extension(
            evot_engine::ExtensionMessage::new(kind.clone(), data.clone()),
        ),
        TranscriptItem::Compact { summary, .. } => {
            evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                provenance: None,
                content: vec![evot_engine::Content::Text {
                    text: crate::compact::context_view::compact_summary_item(summary)
                        .as_user_text()
                        .unwrap_or_default(),
                }],
                timestamp: HISTORY_TIMESTAMP_UNKNOWN,
            })
        }
        // Marker items should never reach conversion — filtered by resolve_transcript.
        // Defensive fallback: convert to a no-op extension that the engine will ignore.
        TranscriptItem::Marker { .. } => evot_engine::AgentMessage::Extension(
            evot_engine::ExtensionMessage::new("marker", serde_json::json!({})),
        ),
        // Stats items should never reach conversion — filtered by resolve_transcript.
        // Defensive fallback: convert to a no-op extension that the engine will ignore.
        TranscriptItem::Stats { .. } => evot_engine::AgentMessage::Extension(
            evot_engine::ExtensionMessage::new("internal_stats", serde_json::json!({})),
        ),
    }
}

/// Convert engine Content blocks to AssistantBlocks (for ProtocolEvent).
pub fn assistant_blocks_from_content(content: &[evot_engine::Content]) -> Vec<AssistantBlock> {
    content
        .iter()
        .filter_map(|block| match block {
            evot_engine::Content::Text { text } => {
                Some(AssistantBlock::Text { text: text.clone() })
            }
            evot_engine::Content::Thinking { thinking, metadata } => {
                Some(AssistantBlock::Thinking {
                    text: thinking.clone(),
                    metadata: metadata.clone(),
                })
            }
            evot_engine::Content::ToolCall {
                id,
                name,
                arguments,
                metadata,
            } => Some(AssistantBlock::ToolCall {
                id: id.clone(),
                name: name.clone(),
                input: scrub_tool_args(name, arguments),
                metadata: metadata.clone(),
            }),
            _ => None,
        })
        .collect()
}

fn engine_content_from_assistant_blocks(blocks: &[AssistantBlock]) -> Vec<evot_engine::Content> {
    blocks
        .iter()
        .map(|block| match block {
            AssistantBlock::Text { text } => evot_engine::Content::Text { text: text.clone() },
            AssistantBlock::Thinking { text, metadata } => evot_engine::Content::Thinking {
                thinking: text.clone(),
                metadata: metadata.clone(),
            },
            AssistantBlock::ToolCall {
                id,
                name,
                input,
                metadata,
            } => evot_engine::Content::ToolCall {
                id: id.clone(),
                name: name.clone(),
                arguments: input.clone(),
                metadata: metadata.clone(),
            },
        })
        .collect()
}

fn engine_usage_from_summary(usage: &UsageSummary) -> evot_engine::Usage {
    let total_tokens = usage
        .input
        .saturating_add(usage.output)
        .saturating_add(usage.cache_read)
        .saturating_add(usage.cache_write);
    evot_engine::Usage {
        input: usage.input,
        output: usage.output,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
        total_tokens,
        reasoning_output: 0,
    }
}

fn usage_summary_from_engine(usage: &evot_engine::Usage) -> UsageSummary {
    UsageSummary {
        input: usage.input,
        output: usage.output,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
    }
}

/// Compute total usage from engine AgentMessages.
pub fn total_usage(messages: &[evot_engine::AgentMessage]) -> UsageSummary {
    let mut input: u64 = 0;
    let mut output: u64 = 0;
    let mut cache_read: u64 = 0;
    let mut cache_write: u64 = 0;

    for message in messages {
        if let evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant { usage, .. }) =
            message
        {
            input += usage.input;
            output += usage.output;
            cache_read += usage.cache_read;
            cache_write += usage.cache_write;
        }
    }

    UsageSummary {
        input,
        output,
        cache_read,
        cache_write,
    }
}

pub fn scrub_tool_args(_tool_name: &str, args: &serde_json::Value) -> serde_json::Value {
    args.clone()
}

/// Parse a stop_reason string back into the engine StopReason enum.
fn parse_stop_reason(s: &str) -> evot_engine::StopReason {
    match s {
        "stop" => evot_engine::StopReason::Stop,
        "length" => evot_engine::StopReason::Length,
        "toolUse" => evot_engine::StopReason::ToolUse,
        "error" => evot_engine::StopReason::Error,
        "aborted" => evot_engine::StopReason::Aborted,
        _ => evot_engine::StopReason::Stop,
    }
}
