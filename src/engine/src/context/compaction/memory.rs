//! Memory extraction — the cumulative [`CompactionState`] carried across
//! compactions (file ops, environment facts, completed requests), read from
//! the messages a compaction evicts.

use super::types::CompactionState;
use super::types::FileOps;
use crate::time::now_ms;
use crate::types::*;

/// Build the cumulative state from evicted messages + previous state.
pub fn build_state(
    evicted: &[AgentMessage],
    split_prefix: Option<&[AgentMessage]>,
    prev_state: Option<&CompactionState>,
) -> CompactionState {
    let file_ops = extract_file_ops(evicted, prev_state);
    let env_discoveries = extract_env_discoveries(evicted, prev_state);
    let completed_requests = extract_user_requests(evicted);

    let mut all_requests = prev_state
        .map(|s| s.completed_requests.clone())
        .unwrap_or_default();
    all_requests.extend(completed_requests);
    // Keep bounded
    if all_requests.len() > 20 {
        all_requests = all_requests.split_off(all_requests.len() - 20);
    }

    // Include split prefix file ops
    let file_ops = if let Some(prefix) = split_prefix {
        let mut ops = file_ops;
        collect_file_ops_from_messages(prefix, &mut ops);
        ops
    } else {
        file_ops
    };

    CompactionState {
        file_ops,
        env_discoveries,
        completed_requests: all_requests,
        timestamp: now_ms(),
        generation: prev_state.map(|s| s.generation + 1).unwrap_or(1),
        last_summary: None,
        context_summary_message: None,
    }
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

const ANCHOR_MAX_CHARS: usize = 200;
const CONCLUSION_MAX_CHARS: usize = 300;

pub fn extract_user_requests(messages: &[AgentMessage]) -> Vec<String> {
    let mut requests = Vec::new();
    for msg in messages {
        if let AgentMessage::Llm(Message::User { content, .. }) = msg {
            let text: String = content
                .iter()
                .filter_map(|c| match c {
                    Content::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" ");
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed.starts_with("[Context compacted") {
                continue;
            }
            let short = if trimmed.len() > ANCHOR_MAX_CHARS {
                format!(
                    "{}…",
                    &trimmed[..trimmed.floor_char_boundary(ANCHOR_MAX_CHARS)]
                )
            } else {
                trimmed.to_string()
            };
            requests.push(short);
        }
    }
    requests
}

pub fn extract_file_ops(
    messages: &[AgentMessage],
    prev_state: Option<&CompactionState>,
) -> FileOps {
    let mut ops = prev_state.map(|s| s.file_ops.clone()).unwrap_or_default();
    collect_file_ops_from_messages(messages, &mut ops);
    ops
}

pub(crate) fn collect_file_ops_from_messages(messages: &[AgentMessage], ops: &mut FileOps) {
    for msg in messages {
        if let AgentMessage::Llm(Message::Assistant { content, .. }) = msg {
            for block in content {
                if let Content::ToolCall {
                    name, arguments, ..
                } = block
                {
                    let path = arguments
                        .get("path")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if let Some(path) = path {
                        match name.to_lowercase().as_str() {
                            "read" => {
                                ops.read.insert(path);
                            }
                            "write" => {
                                ops.written.insert(path);
                            }
                            "edit" => {
                                ops.edited.insert(path);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

pub fn extract_env_discoveries(
    messages: &[AgentMessage],
    prev_state: Option<&CompactionState>,
) -> Vec<String> {
    let mut env = prev_state
        .map(|s| s.env_discoveries.clone())
        .unwrap_or_default();

    for (i, msg) in messages.iter().enumerate() {
        if let AgentMessage::Llm(Message::ToolResult {
            tool_name,
            is_error: false,
            content,
            tool_call_id,
            ..
        }) = msg
        {
            if tool_name != "bash" && tool_name != "Bash" {
                continue;
            }

            let cmd =
                find_tool_call_param(messages, i, tool_call_id, "command").unwrap_or_default();

            let is_env_probe = cmd.contains("which ")
                || cmd.contains("find /")
                || cmd.contains("rustup")
                || cmd.starts_with("export PATH=");

            if !is_env_probe {
                continue;
            }

            let text: String = content
                .iter()
                .filter_map(|c| match c {
                    Content::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");

            for line in text.lines().take(5) {
                let trimmed = line.trim();
                if trimmed.contains("/bin/")
                    || trimmed.contains("/usr/")
                    || trimmed.contains("toolchain")
                    || trimmed.contains("rustup")
                {
                    let entry = if trimmed.len() > 100 {
                        format!("{}...", &trimmed[..trimmed.floor_char_boundary(97)])
                    } else {
                        trimmed.to_string()
                    };
                    if !env.contains(&entry) {
                        env.push(entry);
                    }
                    if env.len() >= 10 {
                        return env;
                    }
                    break;
                }
            }
        }
    }
    env
}

pub fn latest_assistant_text(messages: &[AgentMessage]) -> Option<String> {
    for msg in messages.iter().rev() {
        if let AgentMessage::Llm(Message::Assistant { content, .. }) = msg {
            for c in content.iter().rev() {
                if let Content::Text { text } = c {
                    let t = text.trim();
                    if t.is_empty() || is_filler(t) || t.starts_with("[Summary]") {
                        continue;
                    }
                    let trimmed = if t.chars().count() > CONCLUSION_MAX_CHARS {
                        format!(
                            "{}…",
                            t.chars().take(CONCLUSION_MAX_CHARS).collect::<String>()
                        )
                    } else {
                        t.to_string()
                    };
                    return Some(trimmed);
                }
            }
        }
    }
    None
}

fn is_filler(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    matches!(
        t.as_str(),
        "done"
            | "done."
            | "ok"
            | "ok."
            | "sure"
            | "sure."
            | "i'll fix this"
            | "let me check"
            | "let me look"
    )
}

fn find_tool_call_param(
    messages: &[AgentMessage],
    tool_result_idx: usize,
    target_id: &str,
    param: &str,
) -> Option<String> {
    for msg in messages[..tool_result_idx].iter().rev() {
        if let AgentMessage::Llm(Message::Assistant { content, .. }) = msg {
            for block in content {
                if let Content::ToolCall { id, arguments, .. } = block {
                    if id == target_id {
                        return arguments
                            .get(param)
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                }
            }
        }
    }
    None
}
