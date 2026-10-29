use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

const SUMMARY_PREFIX: &str =
    "The conversation history before this point was compacted into the following summary:\n\n";

/// Stem of [`SUMMARY_PREFIX`], deliberately shorter than the 40-character head
/// budget used by session titles. Matching on the stem therefore recognizes
/// both a live summary message and a title that an earlier release already
/// truncated mid-prefix (`"The conversation history before this poi.."`).
const SUMMARY_STEM: &str = "The conversation history before this";

pub fn compact_summary_text(summary: &str) -> String {
    format!("{SUMMARY_PREFIX}{summary}")
}

/// Whether the text is synthetic context inserted by compaction rather than an
/// actual user prompt (or a session title previously derived from one).
pub fn is_compact_summary_text(text: &str) -> bool {
    text.starts_with(SUMMARY_STEM)
}

pub fn compact_summary_item(summary: &str) -> TranscriptItem {
    TranscriptItem::User {
        provenance: None,
        text: compact_summary_text(summary),
        content: vec![],
    }
}

pub fn resolve_context_entries(entries: &[TranscriptEntry]) -> Vec<(u64, TranscriptItem)> {
    let last_control = entries.iter().rposition(|e| is_control_point(&e.item));

    match last_control {
        Some(idx) => match &entries[idx].item {
            TranscriptItem::Compact {
                summary, messages, ..
            } => {
                let mut compact_messages = messages.clone();
                normalize_transcript_summary_boundary(summary, &mut compact_messages);
                let mut items = compact_messages
                    .into_iter()
                    .filter(|item| item.is_context_item())
                    .map(|item| (0, item))
                    .collect::<Vec<_>>();
                for entry in &entries[idx + 1..] {
                    if entry.item.is_context_item() {
                        items.push((entry.seq, entry.item.clone()));
                    }
                }
                items
            }
            TranscriptItem::Marker { messages, .. } => {
                let mut items: Vec<(u64, TranscriptItem)> = messages
                    .iter()
                    .filter(|item| item.is_context_item())
                    .cloned()
                    .map(|item| (0, item))
                    .collect();
                for entry in &entries[idx + 1..] {
                    if entry.item.is_context_item() {
                        items.push((entry.seq, entry.item.clone()));
                    }
                }
                items
            }
            _ => unreachable!("control point predicate and match are inconsistent"),
        },
        None => entries
            .iter()
            .filter(|entry| entry.item.is_context_item())
            .map(|entry| (entry.seq, entry.item.clone()))
            .collect(),
    }
}

pub fn resolve_context_items(entries: &[TranscriptEntry]) -> Vec<TranscriptItem> {
    resolve_context_entries(entries)
        .into_iter()
        .map(|(_, item)| item)
        .collect()
}

/// Resolve the exact Engine context and compaction state at the latest control
/// point. Legacy oversized summaries are bounded only at that synthetic boundary;
/// ordinary user messages appended before or after it are left untouched.
pub fn resolve_engine_context_with_state(
    entries: &[TranscriptEntry],
) -> (
    Vec<evot_engine::AgentMessage>,
    Option<evot_engine::CompactionState>,
) {
    let last_control = entries
        .iter()
        .rposition(|entry| is_control_point(&entry.item));
    let (mut messages, state) = match last_control {
        Some(index) => match &entries[index].item {
            TranscriptItem::Compact {
                summary,
                engine_messages,
                state,
                ..
            } => {
                let mut messages = engine_messages.clone();
                let mut state = state.as_ref().clone();
                normalize_engine_summary_boundary(summary, &mut messages, &mut state);
                (messages, Some(state))
            }
            TranscriptItem::Marker { messages, .. } => (
                crate::conversation::convert::into_agent_messages(messages),
                None,
            ),
            _ => (Vec::new(), None),
        },
        None => (Vec::new(), None),
    };
    let start = last_control
        .map(|index| index.saturating_add(1))
        .unwrap_or(0);
    messages.extend(crate::conversation::convert::into_agent_messages(
        &entries[start..]
            .iter()
            .filter(|entry| entry.item.is_context_item())
            .map(|entry| entry.item.clone())
            .collect::<Vec<_>>(),
    ));
    evot_engine::migrate_legacy_responses_tool_ids(&mut messages);
    (messages, state)
}

/// Enforce compaction summary bounds before an atomic compact item is persisted
/// and published. Retained real user messages are not modified.
pub(crate) fn normalize_compact_item(
    item: &mut TranscriptItem,
    replacement_context: &mut [TranscriptItem],
) {
    let TranscriptItem::Compact {
        summary,
        messages,
        engine_messages,
        state,
        ..
    } = item
    else {
        return;
    };

    normalize_transcript_summary_boundary(summary, messages);
    normalize_transcript_summary_boundary(summary, replacement_context);
    normalize_engine_summary_boundary(summary, engine_messages, state);
    *summary = bounded_summary(summary);
}

fn normalize_transcript_summary_boundary(summary: &str, messages: &mut [TranscriptItem]) {
    let Some(TranscriptItem::User { text, content, .. }) = messages.first_mut() else {
        return;
    };
    if !is_summary_boundary_text(text, summary) {
        return;
    }

    let bounded = bounded_summary(text);
    if bounded.len() == text.len() {
        return;
    }
    for block in content {
        if let crate::types::TranscriptUserContent::Text { text: block_text } = block {
            if block_text.as_str() == text.as_str() {
                *block_text = bounded.clone();
            }
        }
    }
    *text = bounded;
}

fn normalize_engine_summary_boundary(
    persisted_summary: &str,
    messages: &mut [evot_engine::AgentMessage],
    state: &mut evot_engine::CompactionState,
) {
    let mut local_context_summary = None;
    let mut remote_summary = false;

    if let Some(first) = messages.first_mut() {
        remote_summary = evot_engine::context::compaction::remote::is_replacement_message(first);
        if remote_summary {
            normalize_remote_fallback(first);
        } else if let evot_engine::AgentMessage::Llm(evot_engine::Message::User {
            content, ..
        }) = first
        {
            if let [evot_engine::Content::Text { text }] = content.as_mut_slice() {
                let matches_state = state.context_summary_message.as_deref() == Some(text.as_str());
                if matches_state || is_summary_boundary_text(text, persisted_summary) {
                    *text = bounded_summary(text);
                    local_context_summary = Some(text.clone());
                }
            }
        }
    }

    state.last_summary = match state.last_summary.take() {
        Some(summary) => Some(bounded_summary(&summary)),
        None if !persisted_summary.is_empty() => Some(bounded_summary(persisted_summary)),
        None => None,
    };
    state.context_summary_message = if remote_summary {
        None
    } else if local_context_summary.is_some() {
        local_context_summary
    } else {
        state
            .context_summary_message
            .take()
            .map(|summary| bounded_summary(&summary))
    };
}

fn normalize_remote_fallback(message: &mut evot_engine::AgentMessage) {
    let evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant { content, .. }) = message
    else {
        return;
    };
    if let [evot_engine::Content::Thinking { thinking, .. }] = content.as_mut_slice() {
        *thinking = bounded_summary(thinking);
    }
}

pub(crate) fn is_summary_boundary_text(text: &str, summary: &str) -> bool {
    text == summary || text.strip_prefix(SUMMARY_PREFIX) == Some(summary)
}

fn bounded_summary(summary: &str) -> String {
    evot_engine::truncate_summary(summary, evot_engine::context::DEFAULT_SUMMARY_MAX_BYTES)
}

pub fn resolve_snapshot_at(entries: &[TranscriptEntry], target_seq: u64) -> Vec<TranscriptItem> {
    let scoped: Vec<TranscriptEntry> = entries
        .iter()
        .filter(|entry| entry.seq <= target_seq)
        .cloned()
        .collect();
    resolve_context_items(&scoped)
}

fn is_control_point(item: &TranscriptItem) -> bool {
    matches!(
        item,
        TranscriptItem::Compact { .. } | TranscriptItem::Marker { .. }
    )
}
