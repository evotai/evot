//! Compaction types — data structures for the compaction system.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::Deserialize;
use serde::Serialize;

use crate::types::AgentMessage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactReason {
    Threshold,
    Overflow,
    Manual,
    /// The provider refused the request (safety filter); the context was
    /// compacted so the retry no longer carries the triggering content.
    Refusal,
}

pub fn bounded_fallback_reason(reason: &str) -> String {
    let normalized = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(500).collect()
}

/// How the evicted context was summarized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionMethod {
    /// Historical method, retained only to read existing sessions. Never emitted.
    Prune,
    /// Provider-native server-side compaction (opaque encrypted item).
    Remote,
    /// Local text summarization.
    Local,
    /// Remote compaction was attempted but failed; fell back to local.
    RemoteFailedLocal,
}

/// Live phase shared by automatic and manual compaction frontends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionPhase {
    /// Historical wire phase. No runtime path emits it.
    Pruning,
    Planning,
    Remote,
    LocalFallback,
    Local,
    Complete,
}

/// Transient activity within an existing phase; the published phase vocabulary
/// stays unchanged so older clients can still follow the lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionActivity {
    Waiting,
    Generating,
}

#[derive(Debug, Clone, Copy)]
pub struct CompactionUpdate {
    pub phase: CompactionPhase,
    pub activity: Option<CompactionActivity>,
}

pub type CompactionObserver = Arc<dyn Fn(CompactionUpdate) + Send + Sync>;

pub fn notify_compaction_phase(observer: &Option<CompactionObserver>, phase: CompactionPhase) {
    if let Some(observer) = observer {
        observer(CompactionUpdate {
            phase,
            activity: None,
        });
    }
}

pub fn notify_compaction_activity(
    observer: &Option<CompactionObserver>,
    activity: CompactionActivity,
) {
    if let Some(observer) = observer {
        observer(CompactionUpdate {
            phase: CompactionPhase::Local,
            activity: Some(activity),
        });
    }
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/// Identifies a model (provider + model id) for overflow detection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelId {
    pub provider: String,
    pub model: String,
}

/// Snapshot of usage from the most recent assistant response.
#[derive(Debug, Clone)]
pub struct UsageSnapshot {
    pub input: usize,
    pub cache_read: usize,
    pub cache_write: usize,
    pub output: usize,
    pub total_tokens: usize,
    pub model: ModelId,
    pub timestamp: u64,
    pub stop_reason: crate::types::StopReason,
    pub error_message: Option<String>,
}

/// Result of trigger evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerDecision {
    /// No compaction needed.
    Skip,
    /// Context exceeds threshold — compact, do not retry.
    Threshold { context_tokens: usize },
    /// Context overflow — compact, and retry only when the response did not
    /// complete successfully.
    Overflow {
        context_tokens: usize,
        will_retry: bool,
    },
    /// Context overflow detected again after a compact-and-retry was already
    /// attempted this turn. Do not retry — surface a user-visible message so
    /// the user can reduce context or switch to a larger-context model.
    OverflowExhausted { context_tokens: usize },
    /// The provider refused the request (safety filter / refusal). Compact
    /// the context so the triggering content leaves the active request, then
    /// retry once.
    Refusal { context_tokens: usize },
    /// A refusal recurred after a compact-and-retry was already attempted
    /// this turn. Do not retry again.
    RefusalExhausted { context_tokens: usize },
}

// ---------------------------------------------------------------------------
// Tracker (cross-compaction state)
// ---------------------------------------------------------------------------

/// Accumulated state across compactions — serialized into transcript.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompactionState {
    /// Cumulative file operations.
    pub file_ops: FileOps,
    /// Environment discoveries (paths, toolchains).
    pub env_discoveries: Vec<String>,
    /// Completed user requests (short summaries).
    pub completed_requests: Vec<String>,
    /// Timestamp of this compaction.
    pub timestamp: u64,
    /// How many compactions have occurred in this session.
    pub generation: u32,
    /// LLM-generated summary from last compaction (for incremental updates).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_summary: Option<String>,
    /// Exact text of the summary message currently present in the LLM context.
    /// Before the next compaction this message is removed and `last_summary` is
    /// supplied to the summarizer instead, preventing duplicate old summaries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_summary_message: Option<String>,
}

/// Tracked file operations, accumulated across compactions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileOps {
    pub read: BTreeSet<String>,
    pub written: BTreeSet<String>,
    pub edited: BTreeSet<String>,
}

impl FileOps {
    /// Files that were modified (written or edited).
    pub fn modified(&self) -> BTreeSet<&String> {
        self.written.iter().chain(self.edited.iter()).collect()
    }

    /// Files that were only read (not modified).
    pub fn read_only(&self) -> Vec<&String> {
        let modified = self.modified();
        self.read.iter().filter(|f| !modified.contains(f)).collect()
    }
}

// ---------------------------------------------------------------------------
// Executor output
// ---------------------------------------------------------------------------

/// Final result of a compaction execution.
#[derive(Debug, Clone)]
pub struct CompactionOutcome {
    pub messages: Vec<AgentMessage>,
    pub state: CompactionState,
    pub stats: CompactionStats,
}

/// Statistics about what compaction did.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompactionStats {
    /// Summary generated for the evicted context, when a summarizing compaction ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Messages before compaction.
    pub before_message_count: usize,
    /// Messages after compaction.
    pub after_message_count: usize,
    /// Estimated tokens before.
    pub before_tokens: usize,
    /// Estimated tokens after.
    pub after_tokens: usize,
    /// Messages evicted.
    pub messages_evicted: usize,
    /// CurrentRun results reclaimed.
    pub current_run_reclaimed: usize,
    /// How the summary was produced (None for legacy/no-op stats).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<CompactionMethod>,
    /// Why provider-native compaction was unavailable or failed before local fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    /// Size of the provider-native compaction payload, when remote ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_blob_bytes: Option<usize>,
}

// ---------------------------------------------------------------------------
// Action returned by loop integration
// ---------------------------------------------------------------------------

/// What the agent loop should do after compaction evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AfterResponseAction {
    /// Continue normally.
    Continue,
    /// Retry the current turn (after overflow recovery).
    Retry,
}
