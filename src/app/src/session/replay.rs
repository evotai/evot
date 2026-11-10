use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

/// Reconstruct visible history without exposing engine-only compaction state.
pub(super) fn resume_transcript_items(entries: Vec<TranscriptEntry>) -> Vec<TranscriptItem> {
    let mut items = Vec::new();
    for entry in entries {
        match entry.item {
            TranscriptItem::Compact {
                id,
                created_at,
                reason,
                summary,
                tokens_before,
                tokens_after,
                messages_before,
                messages_after,
                messages,
                details,
                ..
            } => {
                let skip = usize::from(messages.first().is_some_and(|message| {
                    matches!(
                        message,
                        TranscriptItem::User { text, .. }
                            if crate::session::conversation::context_view::is_summary_boundary_text(text, &summary)
                    )
                }));
                items.extend(
                    messages
                        .into_iter()
                        .skip(skip)
                        .filter(TranscriptItem::is_context_item),
                );
                items.push(TranscriptItem::Compact {
                    id,
                    created_at,
                    reason,
                    summary: evot_engine::truncate_summary(
                        &summary,
                        evot_engine::context::DEFAULT_SUMMARY_MAX_BYTES,
                    ),
                    tokens_before,
                    tokens_after,
                    messages_before,
                    messages_after,
                    messages: Vec::new(),
                    engine_messages: Vec::new(),
                    state: Box::default(),
                    details,
                });
            }
            TranscriptItem::Marker { messages, .. } => {
                items.extend(messages.into_iter().filter(TranscriptItem::is_context_item));
            }
            item => items.push(item),
        }
    }
    items
}
