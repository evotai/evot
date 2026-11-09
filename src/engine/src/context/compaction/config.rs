//! Compaction configuration — single source of truth for all tunable parameters.

use super::summarizer::SummarizerMode;

const SUMMARY_TRUNCATION_MARKER: &str = "\n\n[… compaction summary truncated …]\n\n";

/// Bound a compaction summary while retaining both its overview and latest
/// conclusion. The limit is a byte budget and the result is always valid UTF-8.
pub fn truncate_summary(summary: &str, max_bytes: usize) -> String {
    if summary.len() <= max_bytes {
        return summary.to_string();
    }
    if max_bytes == 0 {
        return String::new();
    }
    if max_bytes <= SUMMARY_TRUNCATION_MARKER.len() {
        return summary[..summary.floor_char_boundary(max_bytes)].to_string();
    }

    let content_budget = max_bytes - SUMMARY_TRUNCATION_MARKER.len();
    let head_budget = content_budget * 2 / 3;
    let head_end = summary.floor_char_boundary(head_budget);
    let tail_budget = content_budget - head_end;
    let mut tail_start = summary.len().saturating_sub(tail_budget);
    while tail_start < summary.len() && !summary.is_char_boundary(tail_start) {
        tail_start += 1;
    }

    format!(
        "{}{}{}",
        &summary[..head_end],
        SUMMARY_TRUNCATION_MARKER,
        &summary[tail_start..]
    )
}

/// All compaction parameters in one place.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    // — Trigger —
    /// Effective request-input limit for the active model.
    pub context_window: usize,
    /// Documented total context window for display; `None` falls back to
    /// `context_window`. Purely cosmetic — all budget math uses
    /// `context_window`.
    pub advertised_context_window: Option<usize>,
    /// Tokens reserved for output + system prompt + tool defs.
    pub reserve_tokens: usize,
    /// Explicit compaction trigger. `None` uses `context_window - reserve_tokens`.
    /// Kept separate from output headroom so per-model policy does not distort
    /// summary input/output budgets.
    pub trigger_tokens: Option<usize>,

    // — Planner —
    /// Token budget for the retained tail (recent messages to keep in full).
    /// The sole retention condition, matching pi's `keepRecentTokens`.
    pub keep_recent_tokens: usize,

    // — Summarizer —
    /// Summarization strategy for summary generation.
    pub summarizer_mode: SummarizerMode,
    /// Maximum UTF-8 bytes retained in a generated summary.
    pub summary_max_bytes: usize,
}

/// Share of the window at which a finished run summarizes proactively. The
/// user is not waiting at run end, so compacting there hides the summary
/// latency that a pre-prompt compaction would put in front of the next reply.
pub const POST_TURN_TRIGGER_PERCENT: usize = 80;
/// Tokens reserved for output + system prompt + tool defs. This is a fixed
/// fallback for models without an explicit profile threshold.
pub const DEFAULT_RESERVE_TOKENS: usize = 16_384;
/// Maximum context retained immediately after compaction. Droid targets 40k;
/// the summary and active request overhead are deducted from this envelope.
pub const DEFAULT_POST_COMPACTION_TOKENS: usize = 40_000;
/// Default retained-message ceiling before active request overhead is deducted.
pub const DEFAULT_KEEP_RECENT_TOKENS: usize = DEFAULT_POST_COMPACTION_TOKENS
    - super::summarizer::mode::DEFAULT_SUMMARY_RESERVE_TOKENS as usize;
/// Maximum UTF-8 bytes for a summary inserted back into model context. Provider
/// output limits are token-based and do not protect deterministic fallbacks or
/// oversized summaries restored from older sessions.
pub const DEFAULT_SUMMARY_MAX_BYTES: usize = 32 * 1024;
/// Absolute byte ceiling for each complete summarizer user prompt. The effective
/// budget is also bounded by the model's context window via
/// `summarizer_input_max_bytes()`.
pub const SUMMARIZER_INPUT_MAX_BYTES: usize = 512 * 1024;
const ESTIMATED_BYTES_PER_TOKEN: usize = 4;

impl CompactionConfig {
    /// Derive config from an effective request-input limit.
    pub fn from_context_window(context_window: usize) -> Self {
        Self {
            context_window,
            advertised_context_window: None,
            reserve_tokens: DEFAULT_RESERVE_TOKENS,
            trigger_tokens: None,
            keep_recent_tokens: DEFAULT_KEEP_RECENT_TOKENS,
            summarizer_mode: SummarizerMode::default(),
            summary_max_bytes: DEFAULT_SUMMARY_MAX_BYTES,
        }
    }

    /// Build from a `ContextConfig`, respecting user-customized fields.
    pub fn from_context_config(ctx: &crate::context::window::ContextConfig) -> Self {
        // ContextConfig.max_context_tokens is the effective input limit.
        // Output headroom is reserved here via reserve_tokens (single source
        // of headroom), so trigger threshold = window - reserve_tokens.
        let mut cfg = Self::from_context_window(ctx.max_context_tokens);
        cfg.advertised_context_window = ctx.advertised_context_window;
        if let Some(reserve) = ctx.reserve_tokens {
            cfg.reserve_tokens = reserve;
        }
        cfg.trigger_tokens = ctx.trigger_tokens;
        if let Some(keep_recent) = ctx.keep_recent_tokens {
            cfg.keep_recent_tokens = keep_recent;
        }
        cfg
    }

    /// Window size shown to the user: the model's documented total window
    /// when known, otherwise the effective input limit.
    pub fn displayed_window(&self) -> usize {
        self.advertised_context_window
            .unwrap_or(self.context_window)
    }

    pub fn post_compaction_target(&self) -> usize {
        if self.context_window == 0 {
            DEFAULT_POST_COMPACTION_TOKENS
        } else {
            DEFAULT_POST_COMPACTION_TOKENS.min(self.context_window)
        }
    }

    /// Summary budget used by both planning and generation. Tiny model windows
    /// keep at least half of the post-compaction envelope for retained context.
    pub fn summary_reserve_tokens(&self) -> usize {
        (self.summarizer_mode.reserve_tokens() as usize).min(self.post_compaction_target() / 2)
    }

    /// Effective byte bound for generated and deterministic summaries.
    pub fn summary_max_bytes(&self) -> usize {
        self.summary_max_bytes.min(
            self.summary_reserve_tokens()
                .saturating_mul(ESTIMATED_BYTES_PER_TOKEN),
        )
    }

    /// Retained-message budget inside the post-compaction envelope.
    pub fn retained_tail_budget(&self, request_overhead_tokens: usize) -> usize {
        let envelope_budget = self
            .post_compaction_target()
            .saturating_sub(self.summary_reserve_tokens())
            .saturating_sub(request_overhead_tokens);
        self.keep_recent_tokens.min(envelope_budget)
    }

    /// Input budget for each complete summarizer user prompt. It uses the
    /// context window minus output headroom and an absolute transport ceiling.
    pub fn summarizer_input_max_bytes(&self) -> usize {
        if self.context_window == 0 {
            return SUMMARIZER_INPUT_MAX_BYTES;
        }
        let output_headroom = self.reserve_tokens.min(self.context_window / 2);
        self.context_window
            .saturating_sub(output_headroom)
            .saturating_mul(ESTIMATED_BYTES_PER_TOKEN)
            .min(SUMMARIZER_INPUT_MAX_BYTES)
    }

    /// Summary threshold applied when a run has finished: never above the
    /// mid-run threshold, so an explicit `trigger_tokens` stays authoritative.
    pub fn post_turn_trigger_threshold(&self) -> usize {
        (self.context_window / 100 * POST_TURN_TRIGGER_PERCENT).min(self.trigger_threshold())
    }

    /// Token threshold that triggers compaction.
    pub fn trigger_threshold(&self) -> usize {
        self.trigger_tokens
            .unwrap_or_else(|| self.context_window.saturating_sub(self.reserve_tokens))
            .min(self.context_window)
    }
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self::from_context_window(128_000)
    }
}
