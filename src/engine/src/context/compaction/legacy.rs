//! Read/write compatibility DTOs for retired context-pruning events.
//!
//! Historical sessions and addon JSON retain these published shapes. They
//! contain no runtime behavior and must never enable external model calls.

use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Keep,
    Truncate,
    Remove,
}

/// The judge's verdict on one tool call, with the numbers behind it so the
/// quality of the model can be evaluated afterwards.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub call_id: String,
    pub tool_name: String,
    /// Compact JSON of the call arguments, truncated for the record.
    pub arguments: String,
    pub decision: Decision,
    /// P(the call still matters); `None` when the judge did not answer.
    pub keep_call: Option<f64>,
    /// P(the verbatim result is still needed).
    pub keep_result: Option<f64>,
    /// Estimated tokens the decision frees when applied.
    pub saves_tokens: usize,
}

/// One round of asking the judge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DecideReport {
    pub verdicts: Vec<Verdict>,
    pub context_tokens: usize,
    /// Tokens the pending verdicts would free, all rounds included.
    pub pending_tokens: usize,
    pub requests: usize,
    pub elapsed_ms: u64,
    /// Which user requests the judge considered still in play; the task the
    /// verdicts were judged against. Empty when the round was skipped.
    #[serde(default)]
    pub user_requests: Vec<RequestRelevance>,
    /// One entry per judge request of the call round: what stretch of the
    /// conversation it covered and how large the state was.
    #[serde(default)]
    pub batches: Vec<BatchReport>,
}

/// The judge's view of one user request when deciding what the task is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestRelevance {
    /// Index of the user message in the history.
    pub message_index: usize,
    /// The request, abridged.
    pub text: String,
    /// P(still in play). `None` when not asked: the latest request, a request
    /// too old to fit the round, or a round that failed.
    pub probability: Option<f64>,
    pub in_play: bool,
}

/// One judge request of the call round.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchReport {
    /// Message range the state rendered verbatim.
    pub from: usize,
    pub to: usize,
    /// Estimated tokens of the state after fitting.
    pub state_tokens: usize,
    pub call_ids: Vec<String>,
    /// Why the batch produced no verdicts, when it did not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
}

/// One batch of edits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApplyReport {
    pub removed: usize,
    pub truncated: usize,
    /// Pending verdicts skipped because their call is pinned or gone.
    pub skipped: usize,
    pub before_tokens: usize,
    pub after_tokens: usize,
    pub before_messages: usize,
    pub after_messages: usize,
    pub trigger: ApplyTrigger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyTrigger {
    /// The run ended; the next request starts a fresh prompt anyway.
    RunEnd,
    /// The context passed the prune threshold mid-run.
    Threshold,
    /// A summary compaction is about to rebuild the prefix regardless.
    BeforeCompaction,
    /// The user asked.
    Manual,
    /// No longer emitted (pending savings reached a share of the context);
    /// kept so events persisted by earlier versions still read back.
    Savings,
    /// No longer emitted (the provider cache had gone cold); kept so events
    /// persisted by earlier versions still read back.
    ColdCache,
}
