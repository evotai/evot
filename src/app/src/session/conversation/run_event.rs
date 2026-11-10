//! Event system — RunEvent, RunEventPayload, RunEventContext.

use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;

use crate::observability::CompactionResult;
use crate::types::AssistantBlock;
use crate::types::CompactReason;
use crate::types::CompactRecord;
use crate::types::LlmCallMetrics;
use crate::types::UsageSummary;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStreamPhase {
    Start,
    Delta,
    End,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistantContentType {
    Text,
    Thinking,
}

/// One reviewed tool call, an item of `tool_calls_reviewed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewedCallPayload {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: String,
    pub relevance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunEventPayload {
    RunStarted {},
    TurnStarted {},
    AssistantDelta {
        content_index: usize,
        content_type: AssistantContentType,
        delta: String,
    },
    AssistantToolCall {
        content_index: usize,
        tool_call_id: String,
        tool_name: String,
        phase: ToolCallStreamPhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        delta: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<serde_json::Value>,
    },
    AssistantCompleted {
        content: Vec<AssistantBlock>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<UsageSummary>,
        stop_reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    ToolStarted {
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview_command: Option<String>,
    },
    ToolProgress {
        tool_call_id: String,
        tool_name: String,
        text: String,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        details: serde_json::Value,
    },
    ToolFinished {
        tool_call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        details: serde_json::Value,
        /// Estimated token count of the tool result content.
        #[serde(default)]
        result_tokens: usize,
        /// Wall-clock execution time (ms).
        #[serde(default)]
        duration_ms: u64,
    },
    LlmCallStarted {
        turn: usize,
        attempt: usize,
        injected_count: usize,
        model: String,
        message_count: usize,
        message_bytes: usize,
        /// Estimated total context tokens (same source as compaction events).
        #[serde(default)]
        estimated_context_tokens: usize,
        system_prompt_tokens: usize,
        #[serde(default)]
        tool_definition_tokens: usize,
        tool_count: usize,
        /// Pre-computed message stats by role.
        #[serde(skip_serializing_if = "Option::is_none")]
        message_stats: Option<LlmMessageStats>,
        /// Context budget in tokens (context_window − system_prompt_tokens).
        #[serde(default)]
        budget_tokens: usize,
        /// Full context window size in tokens.
        #[serde(default)]
        context_window: usize,
    },
    LlmCallRetry {
        turn: usize,
        attempt: usize,
        max_retries: usize,
        delay_ms: u64,
        error: String,
    },
    /// Transient quota/reset wait state. This is public for live UIs but
    /// deliberately omitted from persisted transcript observability.
    QuotaWaiting {
        delay_ms: u64,
        #[serde(default)]
        error: String,
    },
    /// Transient upstream-outage wait state: the bounded retry budget is
    /// exhausted but the provider error remains retryable, so the run keeps
    /// probing instead of failing. Public for live UIs, omitted from persisted
    /// transcript observability.
    OutageWaiting {
        delay_ms: u64,
        error: String,
    },
    LlmCallCompleted {
        turn: usize,
        attempt: usize,
        usage: UsageSummary,
        #[serde(default)]
        cache_read: u64,
        #[serde(default)]
        cache_write: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        metrics: Option<LlmCallMetrics>,
        #[serde(default)]
        context_window: usize,
        /// LLM stop reason (e.g. "stop", "tool_use", "max_tokens", "error").
        #[serde(default)]
        stop_reason: String,
        /// Tool calls returned by the LLM, if any.
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<LlmToolCallSummary>>,
        /// Model that actually served the response when it differs from the
        /// requested model (e.g. Anthropic server-side fallback
        /// claude-fable-5 → claude-opus-4-8).
        #[serde(skip_serializing_if = "Option::is_none")]
        response_model: Option<String>,
    },
    ContextCompactionStarted {
        reason: CompactReason,
        #[serde(default)]
        message_count: usize,
        estimated_tokens: usize,
        budget_tokens: usize,
        #[serde(default)]
        reserve_tokens: usize,
        #[serde(default)]
        trigger_threshold: usize,
        #[serde(default)]
        system_prompt_tokens: usize,
        #[serde(default)]
        tool_definition_tokens: usize,
        context_window: usize,
        #[serde(default)]
        will_retry: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message_stats: Option<LlmMessageStats>,
    },
    ContextCompactionPhase {
        phase: evot_engine::CompactionPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activity: Option<evot_engine::context::compaction::types::CompactionActivity>,
    },
    ContextCompactionCompleted {
        reason: CompactReason,
        result: CompactionResult,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default)]
        context_window: usize,
        #[serde(default)]
        will_retry: bool,
    },
    /// Retired wire event, readable for historical addon payloads only.
    ToolCallsReviewed {
        calls: Vec<ReviewedCallPayload>,
    },
    /// Retired wire event, readable for historical addon payloads only.
    ContextPruned {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decided: Option<evot_engine::context::compaction::DecideReport>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        applied: Option<evot_engine::context::compaction::ApplyReport>,
        #[serde(default)]
        context_window: usize,
    },
    RunFinished {
        text: String,
        usage: UsageSummary,
        turn_count: u32,
        duration_ms: u64,
        transcript_count: usize,
        #[serde(default)]
        compact_history: Vec<CompactRecord>,
    },
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// LlmToolCallSummary — tool call in LlmCallCompleted
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCallSummary {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

// ---------------------------------------------------------------------------
// LlmMessageStats — pre-computed message breakdown by role
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessageStats {
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

impl From<evot_engine::LlmCallStats> for LlmMessageStats {
    fn from(s: evot_engine::LlmCallStats) -> Self {
        Self {
            user_count: s.user_count,
            assistant_count: s.assistant_count,
            tool_result_count: s.tool_result_count,
            image_count: s.image_count,
            image_path_count: s.image_path_count,
            image_base64_count: s.image_base64_count,
            user_tokens: s.user_tokens,
            assistant_tokens: s.assistant_tokens,
            tool_result_tokens: s.tool_result_tokens,
            image_tokens: s.image_tokens,
            tool_details: s.tool_details,
        }
    }
}

impl RunEventPayload {
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run_started",
            Self::TurnStarted { .. } => "turn_started",
            Self::AssistantDelta { .. } => "assistant_delta",
            Self::AssistantToolCall { .. } => "assistant_tool_call",
            Self::AssistantCompleted { .. } => "assistant_completed",
            Self::ToolStarted { .. } => "tool_started",
            Self::ToolProgress { .. } => "tool_progress",
            Self::ToolFinished { .. } => "tool_finished",
            Self::LlmCallStarted { .. } => "llm_call_started",
            Self::LlmCallRetry { .. } => "llm_call_retry",
            Self::QuotaWaiting { .. } => "quota_waiting",
            Self::OutageWaiting { .. } => "outage_waiting",
            Self::LlmCallCompleted { .. } => "llm_call_completed",
            Self::ContextCompactionStarted { .. } => "context_compaction_started",
            Self::ContextCompactionPhase { .. } => "context_compaction_phase",
            Self::ContextCompactionCompleted { .. } => "context_compaction_completed",
            Self::ToolCallsReviewed { .. } => "tool_calls_reviewed",
            Self::ContextPruned { .. } => "context_pruned",
            Self::RunFinished { .. } => "run_finished",
            Self::Error { .. } => "error",
        }
    }
}

// ---------------------------------------------------------------------------
// RunEvent — custom serde to maintain { kind, payload: {...}, ... } shape
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RunEvent {
    pub event_id: String,
    pub run_id: String,
    pub session_id: String,
    pub turn: u32,
    pub payload: RunEventPayload,
    pub created_at: String,
}

impl RunEvent {
    pub fn new(run_id: String, session_id: String, turn: u32, payload: RunEventPayload) -> Self {
        Self {
            event_id: crate::types::new_id(),
            run_id,
            session_id,
            turn,
            payload,
            created_at: Utc::now().to_rfc3339(),
        }
    }

    pub fn kind_str(&self) -> &'static str {
        self.payload.kind_str()
    }
}

// Custom Serialize: output { event_id, run_id, session_id, turn, kind, payload, created_at }
impl Serialize for RunEvent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;

        // Serialize payload to Value, then strip the "kind" tag from it
        let payload_value =
            serde_json::to_value(&self.payload).map_err(serde::ser::Error::custom)?;
        let payload_obj = match &payload_value {
            serde_json::Value::Object(map) => {
                let mut stripped = serde_json::Map::new();
                for (k, v) in map {
                    if k != "kind" {
                        stripped.insert(k.clone(), v.clone());
                    }
                }
                serde_json::Value::Object(stripped)
            }
            other => other.clone(),
        };

        let mut map = serializer.serialize_map(Some(7))?;
        map.serialize_entry("event_id", &self.event_id)?;
        map.serialize_entry("run_id", &self.run_id)?;
        map.serialize_entry("session_id", &self.session_id)?;
        map.serialize_entry("turn", &self.turn)?;
        map.serialize_entry("kind", self.kind_str())?;
        map.serialize_entry("payload", &payload_obj)?;
        map.serialize_entry("created_at", &self.created_at)?;
        map.end()
    }
}

// Custom Deserialize: read kind, then use it to deserialize payload
impl<'de> Deserialize<'de> for RunEvent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("expected object"))?;

        let event_id = obj
            .get("event_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::missing_field("event_id"))?
            .to_string();
        let run_id = obj
            .get("run_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::missing_field("run_id"))?
            .to_string();
        let session_id = obj
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::missing_field("session_id"))?
            .to_string();
        let turn_u64 = obj
            .get("turn")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| serde::de::Error::missing_field("turn"))?;
        let turn = u32::try_from(turn_u64).map_err(|_| {
            serde::de::Error::custom(format!("turn value {turn_u64} exceeds u32 range"))
        })?;
        let created_at = obj
            .get("created_at")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::missing_field("created_at"))?
            .to_string();

        // Reconstruct payload by injecting kind back into the payload object
        let kind_str = obj
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::missing_field("kind"))?;
        let payload_value = obj
            .get("payload")
            .ok_or_else(|| serde::de::Error::missing_field("payload"))?
            .clone();
        let tagged = match payload_value {
            serde_json::Value::Object(mut map) => {
                map.insert(
                    "kind".to_string(),
                    serde_json::Value::String(kind_str.to_string()),
                );
                serde_json::Value::Object(map)
            }
            other => other,
        };
        let payload: RunEventPayload =
            serde_json::from_value(tagged).map_err(serde::de::Error::custom)?;

        Ok(RunEvent {
            event_id,
            run_id,
            session_id,
            turn,
            payload,
            created_at,
        })
    }
}

// ---------------------------------------------------------------------------
// RunEventContext — RunEvent factory with run/session context
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct RunEventContext<'a> {
    run_id: &'a str,
    session_id: &'a str,
    turn: u32,
}

impl<'a> RunEventContext<'a> {
    pub fn new(run_id: &'a str, session_id: &'a str, turn: u32) -> Self {
        Self {
            run_id,
            session_id,
            turn,
        }
    }

    pub fn started(&self) -> RunEvent {
        self.with_turn(0).event(RunEventPayload::RunStarted {})
    }

    pub fn finished(
        &self,
        text: String,
        usage: UsageSummary,
        turn_count: u32,
        duration_ms: u64,
        transcript_count: usize,
        compact_history: Vec<CompactRecord>,
    ) -> RunEvent {
        self.event(RunEventPayload::RunFinished {
            text,
            usage,
            turn_count,
            duration_ms,
            transcript_count,
            compact_history,
        })
    }

    pub fn event(&self, payload: RunEventPayload) -> RunEvent {
        RunEvent::new(
            self.run_id.to_string(),
            self.session_id.to_string(),
            self.turn,
            payload,
        )
    }

    fn with_turn(self, turn: u32) -> Self {
        Self { turn, ..self }
    }
}
