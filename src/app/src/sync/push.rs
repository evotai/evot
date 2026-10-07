//! Local → cloud. Every push is a compare-and-append at `cloud.synced_seq`, so
//! two machines can never silently interleave; the loser sees `Diverged` and
//! the user picks a side.

use std::sync::Arc;

use chrono::Utc;

use super::client;
use super::portable::has_path_images;
use super::portable::portable_entries;
use super::types::PushResponse;
use super::types::SyncAck;
use super::types::SyncPush;
use super::types::SYNC_SCHEMA_VERSION;
use crate::auth::AuthState;
use crate::error::EvotError;
use crate::error::Result;
use crate::storage::Storage;
use crate::types::CloudAccess;
use crate::types::CloudSync;
use crate::types::CloudVisibility;
use crate::types::ListTranscriptEntries;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;

/// One step of a push, reported after each batch the server acknowledged
/// (and once before the first, so a caller can draw an empty bar at once).
/// Entry counts are what a reader sees as progress; batch numbers are what
/// a log wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushProgress {
    pub uploaded_entries: usize,
    pub total_entries: usize,
    pub batch: usize,
    pub batches: usize,
}

/// Where a push reports its progress. `&|_| {}` for callers that do not care.
pub type ProgressSink<'a> = dyn Fn(PushProgress) + Sync + 'a;

#[derive(Debug, Clone)]
pub enum PushOutcome {
    /// Server now ends at `cloud.synced_seq`; `pushed` entries went up.
    Synced { cloud: CloudSync, pushed: usize },
    /// Another machine appended past our `synced_seq`. Nothing was written.
    Diverged { local_seq: u64, remote_seq: u64 },
    /// `SessionMeta.cloud` is `None`: the session is local-only.
    NotShared,
}

pub fn local_host() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_default()
}

/// Turn cloud sync on (or change who can read it) and push right away, so
/// the command that enabled it reports a real server state rather than a
/// promise.
///
/// `access: None` means "keep what it has": a bare `/share` on a public
/// session must not quietly take the page down. New sessions start private.
pub async fn share_session(
    state: &AuthState,
    storage: &Arc<dyn Storage>,
    session_id: &str,
    access: Option<CloudAccess>,
    evot_version: &str,
    on_progress: &ProgressSink<'_>,
) -> Result<PushOutcome> {
    let meta = load_meta(storage, session_id).await?;
    let previous = meta.cloud;
    let mut cloud = previous
        .clone()
        .unwrap_or_else(|| CloudSync::new(CloudVisibility::Private, local_host()));
    if let Some(access) = access {
        cloud.set_access(access);
    }
    storage.set_session_cloud(session_id, Some(cloud)).await?;
    let outcome =
        match push_session(state, storage, session_id, evot_version, false, on_progress).await {
            Ok(PushOutcome::Synced { cloud, pushed }) => PushOutcome::Synced { cloud, pushed },
            Ok(other) => {
                storage.set_session_cloud(session_id, previous).await?;
                return Ok(other);
            }
            Err(error) => {
                storage.set_session_cloud(session_id, previous).await?;
                return Err(error);
            }
        };
    // A server that predates team pages ignores the flag and acknowledges a
    // plain private session. Say so instead of reporting success.
    if access == Some(CloudAccess::Team) {
        if let PushOutcome::Synced { cloud, .. } = &outcome {
            if !cloud.team {
                return Err(EvotError::Conf(
                    "the cloud server does not support team sharing yet; the session stays private"
                        .into(),
                ));
            }
        }
    }
    Ok(outcome)
}

/// Incremental push of everything after `cloud.synced_seq`. Metadata always
/// rides along so renames and turn counts reach the other machines even when
/// no new transcript entry exists.
///
/// `force` replaces the server copy wholesale: the "overwrite with local" side
/// of a divergence.
pub async fn push_session(
    state: &AuthState,
    storage: &Arc<dyn Storage>,
    session_id: &str,
    evot_version: &str,
    force: bool,
    on_progress: &ProgressSink<'_>,
) -> Result<PushOutcome> {
    let meta = load_meta(storage, session_id).await?;
    let Some(cloud) = meta.cloud.clone() else {
        return Ok(PushOutcome::NotShared);
    };
    let all = storage
        .list_entries(ListTranscriptEntries {
            session_id: session_id.to_string(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    // Private sync and public/team shares must never send local-only image
    // paths. Use the same portable entries for the viewer and the raw copy.
    let access = cloud.access();
    // Builds before image embedding synced the path, not the bytes, so a copy
    // the server already holds may carry dead paths. Widening access only
    // uploads the tail, which would leave those entries as they are for
    // importers. Entries are stored with paths locally and made portable on
    // the way out, so the local shape cannot say whether the server copy is
    // clean; when earlier entries carry images, replace the copy from the
    // start rather than refuse. That is what `/share off` and re-sharing did
    // by hand, minus the delete and the round trip.
    let mut force = force;
    if access != CloudAccess::Private && !force && cloud.synced_seq > 0 {
        let synced = all.iter().filter(|entry| entry.seq <= cloud.synced_seq);
        for entry in synced {
            if has_path_images(entry)? {
                force = true;
                break;
            }
        }
    }
    let after_seq = if force { 0 } else { cloud.synced_seq };
    let portable = portable_entries(&all)?;
    let viewer = if access != CloudAccess::Private && !portable.is_empty() {
        Some(serde_json::to_value(crate::share::export_session(
            &meta,
            &portable,
            evot_version,
        ))?)
    } else {
        None
    };
    let entries: Vec<_> = portable
        .into_iter()
        .filter(|entry| entry.seq > after_seq)
        .collect();
    let local_seq = all.last().map(|entry| entry.seq).unwrap_or(after_seq);
    let pushed = entries.len();
    let batches = split_batches(entries);
    let batch_count = batches.len();
    let last = batch_count.saturating_sub(1);
    let mut cloud = cloud;
    let mut expected_seq = after_seq;
    let mut uploaded = 0usize;
    // Only the first batch may replace: a `force` on every batch would wipe
    // the ones already appended. Compare-and-append carries the rest.
    on_progress(PushProgress {
        uploaded_entries: 0,
        total_entries: pushed,
        batch: 0,
        batches: batch_count,
    });
    for (index, batch) in batches.into_iter().enumerate() {
        let is_last = index == last;
        let batch_len = batch.len();
        let payload = SyncPush {
            schema_version: SYNC_SCHEMA_VERSION,
            evot_version: evot_version.to_string(),
            meta: wire_meta(&meta),
            expected_seq,
            entries: batch,
            visibility: cloud.visibility,
            team: access == CloudAccess::Team,
            origin_host: cloud.origin_host.clone(),
            force,
            viewer: if is_last { viewer.clone() } else { None },
            keep_viewer: !is_last,
        };
        match client::push(state, &payload).await? {
            PushResponse::Acked(ack) => {
                // Record every acknowledged batch, so an interrupted upload
                // resumes after the last one that landed instead of starting over.
                cloud = acknowledge(storage, session_id, cloud, &ack).await?;
                expected_seq = ack.seq;
                force = false;
                uploaded += batch_len;
                on_progress(PushProgress {
                    uploaded_entries: uploaded,
                    total_entries: pushed,
                    batch: index + 1,
                    batches: batch_count,
                });
            }
            PushResponse::Conflict { remote_seq } => {
                return Ok(PushOutcome::Diverged {
                    local_seq,
                    remote_seq,
                })
            }
        }
    }
    Ok(PushOutcome::Synced { cloud, pushed })
}

/// Bytes of serialized entries per request. Well under what one HTTP round
/// trip through nginx and Cloudflare handles comfortably, and small enough
/// that progress is visible on a slow uplink.
const BATCH_BYTES: usize = 4 * 1024 * 1024;
/// Entries per request; the server bounds the list length of one push.
const BATCH_ENTRIES: usize = 5_000;

/// Cut the entries into consecutive batches. Always at least one batch, even
/// when empty: a metadata-only push (rename, turn count) must still go up.
fn split_batches(entries: Vec<TranscriptEntry>) -> Vec<Vec<TranscriptEntry>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_bytes = 0usize;
    for entry in entries {
        let size = serde_json::to_vec(&entry)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        let full = !current.is_empty()
            && (current_bytes + size > BATCH_BYTES || current.len() >= BATCH_ENTRIES);
        if full {
            batches.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current_bytes += size;
        current.push(entry);
    }
    batches.push(current);
    batches
}

/// Remove the server copy and forget sync state locally. The transcript stays.
pub async fn unshare_session(
    state: &AuthState,
    storage: &Arc<dyn Storage>,
    session_id: &str,
) -> Result<()> {
    match client::delete(state, session_id).await {
        Ok(()) => {}
        // Already gone remotely: still clear the local flag.
        Err(EvotError::Conf(message)) if message.contains("HTTP 404") => {}
        Err(error) => return Err(error),
    }
    storage.set_session_cloud(session_id, None).await?;
    Ok(())
}

async fn acknowledge(
    storage: &Arc<dyn Storage>,
    session_id: &str,
    mut cloud: CloudSync,
    ack: &SyncAck,
) -> Result<CloudSync> {
    cloud.synced_seq = ack.seq;
    cloud.synced_at = Utc::now().to_rfc3339();
    cloud.visibility = ack.visibility;
    cloud.public_url = ack.public_url.clone();
    // The server's answer wins: it may have refused or dropped the team page.
    cloud.team = ack.team && ack.visibility == CloudVisibility::Private;
    cloud.team_url = ack.team_url.clone();
    cloud.team_name = ack.team_name.clone();
    let saved = storage
        .set_session_cloud(session_id, Some(cloud.clone()))
        .await?;
    Ok(saved.cloud.unwrap_or(cloud))
}

async fn load_meta(storage: &Arc<dyn Storage>, session_id: &str) -> Result<SessionMeta> {
    storage
        .get_session(session_id)
        .await?
        .ok_or_else(|| EvotError::Session(format!("session not found: {session_id}")))
}

/// Sync state is per machine; the server hands each puller its own view.
pub(super) fn wire_meta(meta: &SessionMeta) -> SessionMeta {
    let mut meta = meta.clone();
    meta.cloud = None;
    meta
}
