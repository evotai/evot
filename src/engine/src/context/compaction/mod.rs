//! Context compaction — smart context management for long sessions.
//!
//! Architecture (WHEN / WHAT / HOW / APPLY):
//! - `trigger` — WHEN: usage-based threshold and overflow detection
//! - `plan` — WHAT: single planner (cut point, split turn, file ops)
//! - `summary` — HOW: one chain (remote → LLM → deterministic emergency)
//! - `executor` — APPLY: reclaim + assemble for in-memory message lists
//! - `controller` — stateful integration point for the agent loop
//! - `memory` / `transforms/` — extraction helpers and lossless reclaim

pub mod config;
pub mod controller;
pub mod emergency;
pub mod executor;
mod legacy;
pub mod memory;
pub mod plan;
pub mod remote;
pub mod summarizer;
pub mod summary;
pub mod transforms;
pub mod trigger;
pub mod types;

pub use config::truncate_summary;
pub use config::CompactionConfig;
pub use config::DEFAULT_KEEP_RECENT_TOKENS;
pub use config::DEFAULT_POST_COMPACTION_TOKENS;
pub use config::DEFAULT_RESERVE_TOKENS;
pub use config::DEFAULT_SUMMARY_MAX_BYTES;
pub use config::SUMMARIZER_INPUT_MAX_BYTES;
pub use controller::Checkpoint;
pub use controller::CompactionController;
pub use controller::CompactionResponse;
pub use legacy::ApplyReport;
pub use legacy::ApplyTrigger;
pub use legacy::DecideReport;
pub use plan::plan_compaction;
pub use plan::plan_messages;
pub use plan::plan_messages_from_boundary;
pub use plan::CompactEntry;
pub use plan::CompactionPlan;
pub use plan::SplitTurn;
pub use summarizer::mode::DEFAULT_SUMMARY_RESERVE_TOKENS;
pub use summarizer::SummarizerContext;
pub use summarizer::SummarizerInput;
pub use summarizer::SummarizerMode;
pub use summary::LlmPolicy;
pub use summary::SummaryContexts;
pub use summary::SummaryOptions;
pub use summary::SummaryOutcome;
pub use summary::SummaryRequest;
pub use summary::SummaryResult;
pub use types::AfterResponseAction;
pub use types::CompactionMethod;
pub use types::CompactionObserver;
pub use types::CompactionOutcome;
pub use types::CompactionPhase;
pub use types::CompactionState;
pub use types::CompactionStats;
pub use types::FileOps;
pub use types::ModelId;
pub use types::TriggerDecision;
pub use types::UsageSnapshot;
