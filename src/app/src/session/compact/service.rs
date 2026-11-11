//! Application completion boundary for manual compaction. The caller must
//! coordinate active runs before entering; this service owns persistence and
//! conversion to the published outcome, not run cancellation/admission.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::orchestrator::compact_session_with_status;
use super::orchestrator::CompactSessionStatus;
use super::orchestrator::ManualCompactRequest;
use super::orchestrator::ManualCompactionOutcome;
use crate::base::error::Result;
use crate::session::Session;
use crate::types::TranscriptItem;

pub async fn compact(
    session: &Arc<Session>,
    request: ManualCompactRequest,
    cancel: CancellationToken,
) -> Result<ManualCompactionOutcome> {
    if cancel.is_cancelled() {
        return Ok(ManualCompactionOutcome::Cancelled);
    }
    let context_window = request.settings.context_window;
    let result = compact_session_with_status(session, request, cancel).await?;
    if result.status == CompactSessionStatus::Cancelled {
        return Ok(ManualCompactionOutcome::Cancelled);
    }
    // Preserve the existing completion boundary, including saves for no-ops.
    // Once committed, a late cancellation must not mask a completed compaction.
    session.save().await?;
    match result.item {
        Some(TranscriptItem::Compact {
            summary,
            tokens_before,
            tokens_after,
            messages_before,
            messages_after,
            details,
            ..
        }) => Ok(ManualCompactionOutcome::Compacted {
            summary,
            tokens_before,
            tokens_after,
            messages_before,
            messages_after,
            context_window,
            messages_evicted: messages_before
                .saturating_sub(messages_after)
                .saturating_add(1),
            current_run_reclaimed: 0,
            // Published addon field from the leveled-compaction era; the CLI
            // no longer reads it. Kept at its last value for old readers.
            compaction_level: 3,
            used_fallback: result.used_fallback,
            method: details.method,
        }),
        _ => Ok(ManualCompactionOutcome::NothingToCompact),
    }
}
