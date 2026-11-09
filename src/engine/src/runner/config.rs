//! Configuration for the agent loop.

use std::sync::Arc;

use crate::context::ContextConfig;
use crate::context::ExecutionLimits;
use crate::provider::ModelConfig;
use crate::provider::StreamProvider;
use crate::spill::FsSpill;
use crate::types::*;

/// Type alias for convert_to_llm callback.
pub type ConvertToLlmFn = Box<dyn Fn(&[AgentMessage]) -> Vec<Message> + Send + Sync>;
/// Type alias for transform_context callback.
pub type TransformContextFn = Box<dyn Fn(Vec<AgentMessage>) -> Vec<AgentMessage> + Send + Sync>;
/// Type alias for steering/follow-up message callbacks.
pub type GetMessagesFn = Box<dyn Fn() -> Vec<AgentMessage> + Send + Sync>;
/// Called before each LLM turn. Return `false` to abort the loop.
pub type BeforeTurnFn = Arc<dyn Fn(&[AgentMessage], usize) -> bool + Send + Sync>;
/// Called after each LLM turn with the current messages and the turn's usage.
pub type AfterTurnFn = Arc<dyn Fn(&[AgentMessage], &Usage) + Send + Sync>;

/// Configuration for the agent loop
pub struct AgentLoopConfig {
    pub provider: Arc<dyn StreamProvider>,
    pub model: String,
    pub api_key: String,
    pub thinking_level: ThinkingLevel,
    pub max_tokens: Option<u32>,

    /// Optional model configuration for multi-provider support.
    /// When set, passed through to StreamConfig so providers can use
    /// base_url, headers, compat flags, etc.
    pub model_config: Option<ModelConfig>,

    /// Convert AgentMessage[] → Message[] before each LLM call.
    /// Default: keep only LLM-compatible messages.
    pub convert_to_llm: Option<ConvertToLlmFn>,

    /// Transform context before convert_to_llm (for pruning, compaction).
    pub transform_context: Option<TransformContextFn>,

    /// Get steering messages (user interruptions mid-run).
    pub get_steering_messages: Option<GetMessagesFn>,

    /// Get follow-up messages (queued work after agent finishes).
    pub get_follow_up_messages: Option<GetMessagesFn>,

    /// Context window configuration (auto-compaction).
    pub context_config: Option<ContextConfig>,

    /// Dedicated model for local compaction summaries. `None` follows the
    /// active model. Remote compaction always uses the active request context.
    pub compaction_context: Option<crate::context::SummarizerContext>,
    pub compaction_fallback_context: Option<crate::context::SummarizerContext>,

    /// Cross-compaction state restored from a persisted session (previous
    /// summary, cumulative file ops). Lets in-run auto-compaction update the
    /// existing summary instead of re-summarizing it as conversation text.
    pub initial_compaction_state: Option<crate::context::CompactionState>,

    /// Execution limits (max turns, tokens, duration).
    pub execution_limits: Option<ExecutionLimits>,

    /// Prompt caching configuration.
    pub cache_config: CacheConfig,

    /// Tool execution strategy (sequential, parallel, or batched).
    pub tool_execution: ToolExecutionStrategy,

    /// Retry policy for transient provider errors.
    pub retry_policy: crate::retry::RetryPolicy,

    /// Called before each LLM turn. Return `false` to abort the loop.
    pub before_turn: Option<BeforeTurnFn>,
    /// Called after each LLM turn with the current messages and the turn's usage.
    pub after_turn: Option<AfterTurnFn>,

    /// Spill: large tool results are written to disk instead of truncated.
    pub spill: Option<Arc<FsSpill>>,
}
