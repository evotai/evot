//! A stored transcript → the `session/update` notifications `session/load`
//! replays before it answers.
//!
//! Shows what the terminal UI shows on resume: the user's own words and
//! pasted images, the assistant's text and thinking, and each tool call with
//! its result. Runtime context, compaction summaries and observability facts
//! have no user-facing form and are skipped.

use std::collections::HashMap;

use agent_client_protocol_schema::v1 as acp;

use super::projection::bounded;
use super::projection::tool_kind;
use crate::session::conversation::input::authored_text;
use crate::types::AssistantBlock;
use crate::types::TranscriptImageSource;
use crate::types::TranscriptItem;
use crate::types::TranscriptUserContent;

pub(super) fn history_updates(items: &[TranscriptItem]) -> Vec<acp::SessionUpdate> {
    let results: HashMap<&str, (&str, bool)> = items
        .iter()
        .filter_map(|item| match item {
            TranscriptItem::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => Some((tool_call_id.as_str(), (content.as_str(), *is_error))),
            _ => None,
        })
        .collect();
    let mut updates = Vec::new();
    for item in items {
        match item {
            TranscriptItem::User { content, .. } => user_updates(item, content, &mut updates),
            TranscriptItem::Assistant { content, .. } => {
                for block in content {
                    updates.extend(assistant_update(block, &results));
                }
            }
            _ => {}
        }
    }
    updates
}

fn user_updates(
    item: &TranscriptItem,
    content: &[TranscriptUserContent],
    updates: &mut Vec<acp::SessionUpdate>,
) {
    if let Some(text) = authored_text(item) {
        updates.push(user_chunk(acp::ContentBlock::from(text)));
    }
    for block in content {
        // Images saved by path stay on disk; only inline ones replay.
        if let TranscriptUserContent::Image {
            mime_type,
            source: TranscriptImageSource::Base64 { data },
        } = block
        {
            let image = acp::ImageContent::new(data.clone(), mime_type.clone());
            updates.push(user_chunk(acp::ContentBlock::Image(image)));
        }
    }
}

fn user_chunk(content: acp::ContentBlock) -> acp::SessionUpdate {
    acp::SessionUpdate::UserMessageChunk(acp::ContentChunk::new(content))
}

fn assistant_update(
    block: &AssistantBlock,
    results: &HashMap<&str, (&str, bool)>,
) -> Option<acp::SessionUpdate> {
    match block {
        AssistantBlock::Text { text } if !text.is_empty() => Some(
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(text.clone().into())),
        ),
        AssistantBlock::Thinking { text, .. } if !text.is_empty() => Some(
            acp::SessionUpdate::AgentThoughtChunk(acp::ContentChunk::new(text.clone().into())),
        ),
        AssistantBlock::Text { .. } | AssistantBlock::Thinking { .. } => None,
        AssistantBlock::ToolCall {
            id, name, input, ..
        } => {
            let call = acp::ToolCall::new(id.clone(), name.clone())
                .kind(tool_kind(name))
                .raw_input(input.clone());
            // A call without a result was interrupted; it will never finish.
            let call = match results.get(id.as_str()) {
                Some((content, is_error)) => call
                    .status(if *is_error {
                        acp::ToolCallStatus::Failed
                    } else {
                        acp::ToolCallStatus::Completed
                    })
                    .content(vec![acp::ToolCallContent::from(bounded(content))]),
                None => call.status(acp::ToolCallStatus::Failed),
            };
            Some(acp::SessionUpdate::ToolCall(call))
        }
    }
}
