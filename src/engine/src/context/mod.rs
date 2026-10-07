//! Context window management — token counting, compaction, and execution limits.

pub mod compaction;
pub mod history;
pub mod image_format;
pub mod image_resize;
pub mod limits;
pub mod sanitize;
pub mod tokens;
pub mod window;

pub use compaction::plan_compaction;
pub use compaction::plan_messages;
pub use compaction::plan_messages_from_boundary;
pub use compaction::truncate_summary;
pub use compaction::types::CompactReason;
pub use compaction::AfterResponseAction;
pub use compaction::CompactEntry;
pub use compaction::CompactionConfig;
pub use compaction::CompactionController;
pub use compaction::CompactionMethod;
pub use compaction::CompactionObserver;
pub use compaction::CompactionOutcome;
pub use compaction::CompactionPhase;
pub use compaction::CompactionPlan;
pub use compaction::CompactionResponse;
pub use compaction::CompactionState;
pub use compaction::CompactionStats;
pub use compaction::FileOps;
pub use compaction::ModelId;
pub use compaction::SummarizerContext;
pub use compaction::SummarizerInput;
pub use compaction::SummarizerMode;
pub use compaction::SummaryContexts;
pub use compaction::TriggerDecision;
pub use compaction::UsageSnapshot;
pub use compaction::DEFAULT_KEEP_RECENT_TOKENS;
pub use compaction::DEFAULT_POST_COMPACTION_TOKENS;
pub use compaction::DEFAULT_RESERVE_TOKENS;
pub use compaction::DEFAULT_SUMMARY_MAX_BYTES;
pub use compaction::DEFAULT_SUMMARY_RESERVE_TOKENS;
pub use compaction::SUMMARIZER_INPUT_MAX_BYTES;
pub use history::transform_messages_for_model;
pub use image_format::detect_image_mime_type;
pub use image_format::IMAGE_SNIFF_BYTES;
pub use image_resize::resize_image;
pub use limits::ExecutionLimits;
pub use limits::ExecutionTracker;
pub use limits::IdleClock;
pub use limits::IdlePause;
pub use sanitize::sanitize_tool_pairs;
pub use tokens::compute_call_stats;
pub use tokens::compute_call_stats_from_agent_messages;
pub use tokens::content_tokens;
pub use tokens::estimate_tokens;
pub use tokens::message_tokens;
pub use tokens::tool_definition_tokens;
pub use tokens::total_tokens;
pub use window::ContextBudgetSnapshot;
pub use window::ContextConfig;
pub use window::ContextTracker;

/// Milliseconds since UNIX epoch, or 0 if the system clock is unavailable.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
