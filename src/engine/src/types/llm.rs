use std::fmt;

use serde::Deserialize;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Stop reasons & usage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

impl fmt::Display for StopReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stop => write!(f, "stop"),
            Self::Length => write!(f, "length"),
            Self::ToolUse => write!(f, "toolUse"),
            Self::Error => write!(f, "error"),
            Self::Aborted => write!(f, "aborted"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// Output tokens used for reasoning/thinking (e.g. chain-of-thought).
    #[serde(default)]
    pub reasoning_output: u64,
}

impl Usage {
    /// Total tokens represented by the disjoint usage buckets.
    pub fn component_total_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    /// Provider total, falling back to normalized usage buckets.
    pub fn context_tokens(&self) -> u64 {
        if self.total_tokens > 0 {
            self.total_tokens
        } else {
            self.component_total_tokens()
        }
    }

    /// Recompute `total_tokens` from usage buckets.
    pub fn refresh_total_tokens(&mut self) {
        self.total_tokens = self.component_total_tokens();
    }

    /// Fraction of input tokens served from cache (0.0–1.0).
    /// Returns 0.0 if no input tokens were processed.
    pub fn cache_hit_rate(&self) -> f64 {
        let total_input = self.input + self.cache_read + self.cache_write;
        if total_input == 0 {
            return 0.0;
        }
        self.cache_read as f64 / total_input as f64
    }
}

/// Timing metrics collected during a single LLM streaming call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LlmCallMetrics {
    /// Total wall-clock time from request start to completion (ms).
    pub duration_ms: u64,
    /// Time to first byte — request start to `StreamEvent::Start` (ms).
    pub ttfb_ms: u64,
    /// Time to first token — request start to first text/thinking delta (ms).
    pub ttft_ms: u64,
    /// Streaming duration — first delta to `Done` (ms).
    pub streaming_ms: u64,
    /// Number of delta chunks received.
    pub chunk_count: u64,
}

// ---------------------------------------------------------------------------
// Cache configuration
// ---------------------------------------------------------------------------

/// Controls prompt caching behavior for providers that support it.
///
/// By default, caching is enabled with automatic breakpoint placement.
/// This gives optimal cost savings without any user configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheConfig {
    /// Master switch — set to false to disable all caching hints.
    /// Default: true.
    pub enabled: bool,
    /// How cache breakpoints are placed.
    pub strategy: CacheStrategy,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            strategy: CacheStrategy::Auto,
        }
    }
}

// ---------------------------------------------------------------------------
// Tool execution strategy
// ---------------------------------------------------------------------------

/// Controls how multiple tool calls from a single LLM response are executed.
///
/// When the LLM returns multiple tool calls (e.g., "read file A, read file B,
/// run bash C"), this determines whether they run sequentially or in parallel.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolExecutionStrategy {
    /// Run tools one at a time, check steering between each.
    /// Use for debugging or tools with shared mutable state.
    Sequential,
    /// Run all tool calls concurrently, check steering after all complete.
    /// Default — most tool calls are independent and this gives the best latency.
    #[default]
    Parallel,
    /// Run in batches of N, check steering between batches.
    /// Balances speed with human-in-the-loop control.
    Batched { size: usize },
}

/// Strategy for placing cache breakpoints (Anthropic-specific; other providers
/// handle caching automatically regardless of this setting).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CacheStrategy {
    /// Automatic breakpoint placement (recommended).
    /// Caches: system prompt, tool definitions, and recent conversation history.
    #[default]
    Auto,
    /// Disable caching entirely.
    Disabled,
    /// Fine-grained control over what gets cached.
    Manual {
        /// Cache the system prompt.
        cache_system: bool,
        /// Cache tool definitions.
        cache_tools: bool,
        /// Cache conversation history (second-to-last message).
        cache_messages: bool,
    },
}

// ---------------------------------------------------------------------------
// Thinking level
// ---------------------------------------------------------------------------

/// Abstract reasoning effort selected by the user. Mirrors pi's
/// `ModelThinkingLevel`: every variant is a real, selectable tier. Translation
/// to a provider-specific wire value happens per model via
/// [`crate::provider::ModelConfig::thinking_level_policy`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    /// Extra-high reasoning level. Only selectable when model metadata opts in.
    Xhigh,
    /// Maximum reasoning level. Distinct from `xhigh`; GPT-5.6 and newer Claude
    /// models can expose both tiers.
    Max,
}

impl ThinkingLevel {
    /// Canonical lowercase name, matching the serde representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// Pre-computed message stats for an LLM call, computed at the engine layer
/// from structured `Message`/`Content` types for accurate token accounting.
///
/// Does NOT include `message_count` or `tool_count` — those come from
/// `request.messages.len()` / `request.tools.len()` to avoid dual sources.
#[derive(Debug, Clone, Default)]
pub struct LlmCallStats {
    pub user_count: usize,
    pub assistant_count: usize,
    pub tool_result_count: usize,
    pub image_count: usize,
    pub image_path_count: usize,
    pub image_base64_count: usize,
    pub user_tokens: usize,
    pub assistant_tokens: usize,
    pub tool_result_tokens: usize,
    pub image_tokens: usize,
    /// Per-tool token breakdown: (name, estimated_tokens), sorted desc.
    pub tool_details: Vec<(String, usize)>,
}
