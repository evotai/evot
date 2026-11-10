//! Shared numeric metrics and aggregation types.

use serde::Deserialize;
use serde::Serialize;

// ---------------------------------------------------------------------------
// UsageSummary — token usage statistics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageSummary {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
}

impl UsageSummary {
    /// Cache hit rate as a fraction (0.0–1.0).
    pub fn cache_hit_rate(&self) -> f64 {
        let total_input = self.input + self.cache_read + self.cache_write;
        if total_input == 0 {
            return 0.0;
        }
        self.cache_read as f64 / total_input as f64
    }

    /// Add another usage summary to this one.
    pub fn add(&mut self, other: &UsageSummary) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
}

// ---------------------------------------------------------------------------
// LlmCallMetrics — timing metrics for a single LLM streaming call
// ---------------------------------------------------------------------------

/// Timing metrics for a single LLM streaming call.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmCallMetrics {
    /// Total wall-clock time (ms).
    pub duration_ms: u64,
    /// Time to first byte — request start to stream start (ms).
    pub ttfb_ms: u64,
    /// Time to first token — request start to first text/thinking delta (ms).
    pub ttft_ms: u64,
    /// Streaming duration — first delta to completion (ms).
    pub streaming_ms: u64,
    /// Number of delta chunks received.
    pub chunk_count: u64,
}

// ---------------------------------------------------------------------------
// ToolAggStats — aggregated stats for a single tool across a run
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ToolAggStats {
    pub calls: u32,
    pub result_tokens: usize,
    pub duration_ms: u64,
    pub errors: u32,
}

// ---------------------------------------------------------------------------
// CompactRecord — a single compaction record
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactRecord {
    /// Deprecated wire field from leveled compaction; compaction has no
    /// levels anymore. Still serialized for old readers, never read.
    pub level: u8,
    pub from_tokens: usize,
    pub to_tokens: usize,
    /// Deprecated wire field from leveled compaction; always empty.
    pub action_map: String,
}

// ---------------------------------------------------------------------------
// RunSummaryData — all data needed to render a run summary
// ---------------------------------------------------------------------------

/// All data needed to render the run summary.
pub struct RunSummaryData {
    pub duration_ms: u64,
    pub turn_count: u32,
    pub usage: UsageSummary,
    pub llm_call_count: u32,
    pub tool_call_count: u32,
    pub system_prompt_tokens: usize,
    pub last_message_stats: Option<MessageStats>,
    pub llm_metrics: Vec<LlmCallMetrics>,
    pub llm_output_tokens: Vec<u64>,
    pub tool_stats: Vec<(String, ToolAggStats)>,
    pub compact_history: Vec<CompactRecord>,
    /// Latest context budget snapshot (estimated tokens, budget tokens).
    /// Used to render budget usage in the run summary.
    pub last_context_budget: Option<(usize, usize)>,
}

// ---------------------------------------------------------------------------
// MessageStats — per-role counts and estimated tokens for an LLM call
// ---------------------------------------------------------------------------

/// Per-role counts and estimated tokens for an LLM call's messages.
#[derive(Debug, Default)]
pub struct MessageStats {
    pub user_count: usize,
    pub assistant_count: usize,
    pub tool_result_count: usize,
    pub user_tokens: usize,
    pub assistant_tokens: usize,
    pub tool_result_tokens: usize,
    /// Per-tool token breakdown (name, tokens), sorted by tokens desc.
    pub tool_details: Vec<(String, usize)>,
}

impl MessageStats {
    pub fn total_tokens(&self, system_prompt_tokens: usize) -> usize {
        system_prompt_tokens + self.user_tokens + self.assistant_tokens + self.tool_result_tokens
    }
}
