//! evot run events → ACP `session/update` payloads and the turn's stop reason.

use agent_client_protocol_schema::v1 as acp;

use crate::agent::AssistantContentType;
use crate::agent::RunEvent;
use crate::agent::RunEventPayload;

/// Upper bound for tool output mirrored into a `tool_call_update`. The full
/// result stays in the session; clients only need enough to render it.
const MAX_TOOL_TEXT_BYTES: usize = 32 * 1024;

/// Folds one run's events into ACP updates and remembers how the turn ended.
#[derive(Default)]
pub(super) struct TurnProjection {
    /// Tool calls start `pending` because they wait for client approval.
    approval: bool,
    stop_reason: Option<String>,
    error: Option<String>,
}

impl TurnProjection {
    pub(super) fn new(approval: bool) -> Self {
        Self {
            approval,
            ..Self::default()
        }
    }

    pub(super) fn apply(&mut self, event: &RunEvent) -> Option<acp::SessionUpdate> {
        match &event.payload {
            RunEventPayload::AssistantDelta {
                content_type,
                delta,
                ..
            } => {
                if delta.is_empty() {
                    return None;
                }
                let chunk = acp::ContentChunk::new(acp::ContentBlock::from(delta.clone()));
                Some(match content_type {
                    AssistantContentType::Text => acp::SessionUpdate::AgentMessageChunk(chunk),
                    AssistantContentType::Thinking => acp::SessionUpdate::AgentThoughtChunk(chunk),
                })
            }
            // Started once per executable call with validated arguments; the
            // model-stream tool deltas before it are not projected, so each ID
            // gets exactly one `tool_call`.
            RunEventPayload::ToolStarted {
                tool_call_id,
                tool_name,
                args,
                preview_command,
            } => {
                let title = preview_command.clone().unwrap_or_else(|| tool_name.clone());
                let status = if self.approval {
                    acp::ToolCallStatus::Pending
                } else {
                    acp::ToolCallStatus::InProgress
                };
                Some(acp::SessionUpdate::ToolCall(
                    acp::ToolCall::new(tool_call_id.clone(), title)
                        .kind(tool_kind(tool_name))
                        .status(status)
                        .raw_input(args.clone()),
                ))
            }
            RunEventPayload::ToolFinished {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
                let status = if *is_error {
                    acp::ToolCallStatus::Failed
                } else {
                    acp::ToolCallStatus::Completed
                };
                let fields = acp::ToolCallUpdateFields::new()
                    .status(status)
                    .content(vec![acp::ToolCallContent::from(bounded(content))]);
                Some(acp::SessionUpdate::ToolCallUpdate(
                    acp::ToolCallUpdate::new(tool_call_id.clone(), fields),
                ))
            }
            RunEventPayload::AssistantCompleted {
                stop_reason,
                error_message,
                ..
            } => {
                self.stop_reason = Some(stop_reason.clone());
                if stop_reason == "error" {
                    self.error = error_message.clone().or_else(|| self.error.take());
                }
                None
            }
            RunEventPayload::LlmCallCompleted {
                usage,
                context_window,
                ..
            } if *context_window > 0 => {
                let used = usage.input + usage.cache_read + usage.cache_write + usage.output;
                Some(acp::SessionUpdate::UsageUpdate(acp::UsageUpdate::new(
                    used,
                    *context_window as u64,
                )))
            }
            RunEventPayload::Error { message } => {
                self.error = Some(message.clone());
                None
            }
            _ => None,
        }
    }

    /// ACP stop reason for a turn that was not cancelled by the client, or the
    /// error that ended it.
    pub(super) fn finish(self) -> Result<acp::StopReason, String> {
        if let Some(error) = self.error {
            return Err(error);
        }
        Ok(match self.stop_reason.as_deref() {
            Some("length") => acp::StopReason::MaxTokens,
            Some("aborted") => acp::StopReason::Cancelled,
            _ => acp::StopReason::EndTurn,
        })
    }
}

pub(super) fn tool_kind(name: &str) -> acp::ToolKind {
    match name {
        "bash" => acp::ToolKind::Execute,
        "read" => acp::ToolKind::Read,
        "write" | "edit" => acp::ToolKind::Edit,
        "grep" | "glob" | "semantic_code_search" => acp::ToolKind::Search,
        "web_fetch" => acp::ToolKind::Fetch,
        _ => acp::ToolKind::Other,
    }
}

fn bounded(text: &str) -> String {
    if text.len() <= MAX_TOOL_TEXT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_TOOL_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &text[..end])
}
