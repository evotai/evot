use serde::Deserialize;
use serde::Serialize;

use crate::types::AgentMessage;
use crate::types::LlmCallMetrics;
use crate::types::LlmCallStats;
use crate::types::Message;
use crate::types::ThinkingLevel;
use crate::types::ToolDefinition;
use crate::types::ToolResult;
use crate::types::Usage;

// ---------------------------------------------------------------------------
// Unified error model
// ---------------------------------------------------------------------------

/// Classification of agent errors by source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorKind {
    /// LLM provider error (API failure, rate limit, etc.)
    Provider,
    /// Agent runtime error (bad state, missing context, etc.)
    Runtime,
    /// Input rejected by a filter.
    InputRejected,
}

/// Structured error information for `AgentEvent::Error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentErrorInfo {
    pub kind: AgentErrorKind,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        messages: Vec<AgentMessage>,
    },
    TurnStart,
    TurnEnd {
        message: AgentMessage,
        tool_results: Vec<Message>,
    },
    MessageStart {
        message: AgentMessage,
    },
    MessageUpdate {
        message: AgentMessage,
        delta: StreamDelta,
    },
    MessageEnd {
        message: AgentMessage,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
        preview_command: Option<String>,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        partial_result: ToolResult,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        result: ToolResult,
        is_error: bool,
        /// Estimated token count for the tool result content.
        result_tokens: usize,
        /// Wall-clock execution time (ms).
        duration_ms: u64,
    },
    ProgressMessage {
        tool_call_id: String,
        tool_name: String,
        text: String,
    },
    /// Unified error event — the single channel for all user-visible errors.
    ///
    /// Replaces the former `InputRejected` variant and provider/runtime `warn!` logs.
    /// App layer should display this to the user but NOT write it to transcript.
    Error {
        error: AgentErrorInfo,
    },
    /// A provider quota/reset window is exhausted. The same idempotent request
    /// will be retried after `delay_ms`; this event is transient UI state and
    /// is not persisted. `error` carries the provider-safe reason for display.
    QuotaWait {
        delay_ms: u64,
        error: String,
    },
    /// The bounded retry budget is exhausted but the provider keeps failing
    /// with retryable errors — a sustained upstream/gateway outage. The same
    /// request will be probed again after `delay_ms`, indefinitely, until it
    /// succeeds or the user cancels. Transient UI state, not persisted.
    OutageWait {
        delay_ms: u64,
        /// The last provider error, for display.
        error: String,
    },
    LlmCallStart {
        turn: usize,
        attempt: usize,
        injected_count: usize,
        request: LlmCallRequest,
        /// Pre-computed message stats from structured Content types.
        stats: LlmCallStats,
        /// Context budget snapshot (same source as compaction events).
        budget: crate::context::ContextBudgetSnapshot,
    },
    LlmCallRetry {
        turn: usize,
        attempt: usize,
        max_retries: usize,
        delay_ms: u64,
        error: String,
    },
    LlmCallEnd {
        turn: usize,
        attempt: usize,
        usage: Usage,
        error: Option<String>,
        metrics: LlmCallMetrics,
        context_window: usize,
        /// Stop reason from the LLM response.
        stop_reason: crate::types::StopReason,
        /// Response content blocks (text + tool calls). Empty on error.
        content: Vec<crate::types::Content>,
        /// Actual model name from the provider response.
        response_model: Option<String>,
        /// Unique completion identifier from the provider (e.g. `chatcmpl-xxx`, `msg_xxx`).
        response_id: Option<String>,
    },
    ContextCompactionStarted {
        reason: crate::context::CompactReason,
        estimated_tokens: usize,
        context_window: usize,
        reserve_tokens: usize,
        trigger_threshold: usize,
        will_retry: bool,
    },
    /// Live lifecycle phase, emitted at the actual execution boundary.
    ContextCompactionPhase {
        phase: crate::context::CompactionPhase,
        activity: Option<crate::context::compaction::types::CompactionActivity>,
    },
    ContextCompactionEnd {
        reason: crate::context::CompactReason,
        stats: crate::context::CompactionStats,
        /// Exact post-compaction context and cross-compaction state. The app
        /// persists these directly; it must not re-plan from raw transcript.
        messages: Vec<AgentMessage>,
        state: crate::context::CompactionState,
        /// Summary text generated by the compactor, without any transcript wrapper.
        summary: Option<String>,
        context_window: usize,
        will_retry: bool,
    },
}

// ---------------------------------------------------------------------------
// LLM call request snapshot
// ---------------------------------------------------------------------------

/// Canonical snapshot of the input sent to the LLM provider for a single call.
#[derive(Debug, Clone)]
pub struct LlmCallRequest {
    pub model: String,
    /// Effective level after model capability clamping, not just the configured request.
    pub thinking_level: ThinkingLevel,
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum StreamDelta {
    Text {
        content_index: usize,
        delta: String,
    },
    Thinking {
        content_index: usize,
        delta: String,
    },
    ToolCallStart {
        content_index: usize,
        id: String,
        name: String,
    },
    ToolCallDelta {
        content_index: usize,
        id: String,
        name: String,
        delta: String,
    },
    ToolCallEnd {
        content_index: usize,
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
}
