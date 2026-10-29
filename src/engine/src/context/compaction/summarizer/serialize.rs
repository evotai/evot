//! Serialize messages to text for LLM summarization.

use super::types::SummarizerInput;
use crate::context::compaction::config::truncate_summary;
use crate::context::compaction::config::CompactionConfig;
use crate::context::compaction::memory;
use crate::context::compaction::types::CompactionState;
use crate::types::*;

/// Conversation serialization follows pi's newest-biased branch-summary
/// budgeting while preserving the original goal at the head.
const SUMMARIZER_OMISSION_MARKER: &str = "[... middle messages omitted for summarization ...]";
/// Max chars per tool result in detailed serialized output (prevents bloat).
const TOOL_RESULT_MAX_CHARS: usize = 2000;

/// Controls provider-specific/tool-heavy message rendering. The abbreviated
/// form is used only after a summarizer context-limit failure.
#[derive(Debug, Clone, Copy, Default)]
pub struct SerializationOptions {
    pub abbreviate_tools: bool,
}

/// Prepare detailed summarizer input (normal path).
pub fn prepare_input(
    evicted: &[AgentMessage],
    split_prefix: Option<&[AgentMessage]>,
    prev_state: Option<&CompactionState>,
    config: &CompactionConfig,
) -> SummarizerInput {
    prepare_input_with_options(
        evicted,
        split_prefix,
        prev_state,
        config,
        SerializationOptions::default(),
    )
}

/// Prepare a SummarizerInput from raw messages and state.
/// Bridge between executor (which has messages) and summarizer (which wants text).
pub fn prepare_input_with_options(
    evicted: &[AgentMessage],
    split_prefix: Option<&[AgentMessage]>,
    prev_state: Option<&CompactionState>,
    config: &CompactionConfig,
    options: SerializationOptions,
) -> SummarizerInput {
    let input_max_bytes = config.summarizer_input_max_bytes();
    let previous_summary = prev_state
        .and_then(|state| state.last_summary.as_deref())
        .map(|summary| truncate_summary(summary, config.summary_max_bytes));
    let conversation_budget = input_max_bytes
        .saturating_sub(previous_summary.as_ref().map_or(0, |summary| summary.len()));
    let conversation =
        serialize_messages_bounded_with_options(evicted, conversation_budget, options);
    let turn_prefix = split_prefix.map(|messages| {
        serialize_messages_bounded_with_options(messages, input_max_bytes, options)
    });
    let file_ops = memory::extract_file_ops(evicted, prev_state);
    let completed_requests = memory::extract_user_requests(evicted);
    let env_discoveries = memory::extract_env_discoveries(evicted, prev_state);
    let last_conclusion = memory::latest_assistant_text(evicted);

    SummarizerInput {
        conversation,
        turn_prefix,
        previous_summary,
        custom_instructions: None,
        request_max_bytes: input_max_bytes,
        file_ops,
        evicted_count: evicted.len(),
        completed_requests,
        env_discoveries,
        last_conclusion,
    }
}

pub fn serialize_messages_bounded_with_options(
    messages: &[AgentMessage],
    max_bytes: usize,
    options: SerializationOptions,
) -> String {
    let parts = serialize_message_parts(messages, options);
    let full = parts.join("\n\n");
    if full.len() <= max_bytes {
        return full;
    }
    if parts.len() <= 1 || max_bytes <= SUMMARIZER_OMISSION_MARKER.len() + 4 {
        return truncate_summary(&full, max_bytes);
    }

    let content_budget = max_bytes - SUMMARIZER_OMISSION_MARKER.len() - 4;
    let head_budget = content_budget / 3;
    let tail_budget = content_budget - head_budget;
    let (head, consumed) = take_prefix(&parts, head_budget);
    let tail = take_suffix(&parts[consumed..], tail_budget);

    [head.as_str(), SUMMARIZER_OMISSION_MARKER, tail.as_str()]
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Serialize messages to a text representation for the LLM.
pub fn serialize_messages(messages: &[AgentMessage]) -> String {
    serialize_message_parts(messages, SerializationOptions::default()).join("\n\n")
}

fn serialize_message_parts(
    messages: &[AgentMessage],
    options: SerializationOptions,
) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();

    for msg in messages {
        let mut message_parts = Vec::new();
        match msg {
            AgentMessage::Llm(Message::User { content, .. }) => {
                let text = extract_text_content(content);
                if !text.is_empty() {
                    message_parts.push(format!("[User]: {text}"));
                }
            }
            AgentMessage::Llm(Message::Assistant { content, .. }) => {
                let mut text_parts: Vec<&str> = Vec::new();
                let mut thinking_parts: Vec<&str> = Vec::new();
                let mut tool_calls: Vec<String> = Vec::new();

                for block in content {
                    match block {
                        Content::Text { text } => text_parts.push(text),
                        Content::Thinking { thinking, .. } if !options.abbreviate_tools => {
                            thinking_parts.push(thinking)
                        }
                        Content::Thinking { .. } => {}
                        Content::ToolCall {
                            name, arguments, ..
                        } => {
                            if options.abbreviate_tools {
                                tool_calls.push(name.clone());
                            } else {
                                let args_str = arguments.to_string();
                                tool_calls.push(format!("{name}({args_str})"));
                            }
                        }
                        _ => {}
                    }
                }

                if !thinking_parts.is_empty() {
                    message_parts.push(format!(
                        "[Assistant thinking]: {}",
                        thinking_parts.join("\n")
                    ));
                }
                if !text_parts.is_empty() {
                    message_parts.push(format!("[Assistant]: {}", text_parts.join("\n")));
                }
                if !tool_calls.is_empty() {
                    message_parts
                        .push(format!("[Assistant tool calls]: {}", tool_calls.join("; ")));
                }
            }
            AgentMessage::Llm(Message::ToolResult {
                tool_name,
                content,
                is_error,
                ..
            }) => {
                if options.abbreviate_tools {
                    let status = if *is_error { "error" } else { "ok" };
                    message_parts.push(format!(
                        "[Tool result: {tool_name}, status={status}, details omitted]"
                    ));
                } else {
                    let text = extract_text_content(content);
                    if !text.is_empty() {
                        let truncated = truncate_for_summary(&text, TOOL_RESULT_MAX_CHARS);
                        message_parts.push(format!("[Tool result]: {truncated}"));
                    }
                }
            }
            _ => {}
        }
        if !message_parts.is_empty() {
            parts.push(message_parts.join("\n\n"));
        }
    }

    parts
}

fn take_prefix(parts: &[String], budget: usize) -> (String, usize) {
    let mut selected = Vec::new();
    let mut used = 0;
    for part in parts {
        let separator = usize::from(!selected.is_empty()) * 2;
        if used + separator + part.len() > budget {
            if selected.is_empty() && budget > 0 {
                selected.push(truncate_summary(part, budget));
                return (selected.join("\n\n"), 1);
            }
            break;
        }
        used += separator + part.len();
        selected.push(part.clone());
    }
    let consumed = selected.len();
    (selected.join("\n\n"), consumed)
}

fn take_suffix(parts: &[String], budget: usize) -> String {
    let mut selected = Vec::new();
    let mut used = 0;
    for part in parts.iter().rev() {
        let separator = usize::from(!selected.is_empty()) * 2;
        if used + separator + part.len() > budget {
            if selected.is_empty() && budget > 0 {
                selected.push(truncate_summary(part, budget));
            }
            break;
        }
        used += separator + part.len();
        selected.push(part.clone());
    }
    selected.reverse();
    selected.join("\n\n")
}

fn extract_text_content(content: &[Content]) -> String {
    content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn truncate_for_summary(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    // `max_chars` is a byte budget; snap to a char boundary so multi-byte
    // characters (e.g. CJK, Devanagari) are never split mid-codepoint.
    let end = text.floor_char_boundary(max_chars);
    let truncated_chars = text.len() - end;
    format!(
        "{}\n\n[... {} more characters truncated]",
        &text[..end],
        truncated_chars
    )
}
