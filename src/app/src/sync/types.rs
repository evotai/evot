//! Wire types for `/v1/sessions`, the private cross-machine session store.
//!
//! Distinct from `/v1/shares`: shares are public, lossy, immutable snapshots;
//! this is the owner's own transcript, kept whole so any signed-in machine can
//! resume it. Every payload carries `schema_version`; the server refuses
//! versions it does not know rather than guessing.

use serde::Deserialize;
use serde::Serialize;

use crate::types::CloudVisibility;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;

pub const SYNC_SCHEMA_VERSION: u32 = 1;

/// One incremental push. `entries` are strictly after `expected_seq`; the
/// server appends them only when its copy still ends at `expected_seq`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPush {
    pub schema_version: u32,
    pub evot_version: String,
    /// Full metadata with `cloud` stripped: sync state is per machine and is
    /// rebuilt from the server's answer on the pulling side.
    pub meta: SessionMeta,
    pub expected_seq: u64,
    pub entries: Vec<TranscriptEntry>,
    pub visibility: CloudVisibility,
    /// Ask for a team page as well (only with `visibility == Private`).
    /// Omitted when off, which is exactly what older builds send.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
    pub origin_host: String,
    /// Replace the server copy instead of appending. Only the explicit
    /// "overwrite with local" resolution sets this.
    #[serde(default)]
    pub force: bool,
    /// Full viewer document (same contract as `/v1/shares`), present while
    /// public or team so the server can render the page without knowing evot's
    /// transcript format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer: Option<serde_json::Value>,
    /// A large push goes up as several batches and only the last one carries
    /// `viewer`. The earlier batches set this so the server keeps the page it
    /// already shows instead of taking it down between batches. Omitted when
    /// off, which is exactly what older builds send.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_viewer: bool,
}

/// Server acknowledgement for a push or a visibility change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncAck {
    pub seq: u64,
    pub visibility: CloudVisibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    /// Team page state; see `CloudSync::team`. Absent from older servers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
}

/// Push result the caller must branch on. A conflict is a normal outcome, not
/// an error: it means another machine appended first.
#[derive(Debug, Clone)]
pub enum PushResponse {
    Acked(SyncAck),
    Conflict { remote_seq: u64 },
}

/// One row of the owner's remote index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSession {
    pub session_id: String,
    pub meta: SessionMeta,
    pub seq: u64,
    pub visibility: CloudVisibility,
    #[serde(default)]
    pub origin_host: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    /// Team page state; see `CloudSync::team`. Absent from older servers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteIndex {
    pub schema_version: u32,
    pub sessions: Vec<RemoteSession>,
}

/// Everything after `after_seq` for one session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPull {
    pub schema_version: u32,
    pub meta: SessionMeta,
    pub seq: u64,
    pub visibility: CloudVisibility,
    #[serde(default)]
    pub origin_host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    /// Team page state; see `CloudSync::team`. Absent from older servers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    pub entries: Vec<TranscriptEntry>,
}
