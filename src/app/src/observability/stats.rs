//! Observability model — structured stats for transcript persistence.
//!
//! Each stats struct represents a single observability fact produced during
//! a run. `TranscriptStats` is the aggregating enum that provides encoding
//! (`to_item`) and decoding (`try_from_item`) between the strong types and
//! the flat `TranscriptItem::Stats { kind, data }` storage representation.

use serde::Deserialize;
use serde::Serialize;

use super::metrics::LlmCallMetrics;
use super::metrics::UsageSummary;
use crate::types::CompactReason;
use crate::types::CompactionMethod;
use crate::types::TranscriptItem;

// ---------------------------------------------------------------------------
// Stats structs — one per observability event kind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmCallStartedStats {
    pub turn: usize,
    pub attempt: usize,
    #[serde(default)]
    pub injected_count: usize,
    pub model: String,
    /// Effective level after model capability clamping. Missing in historical stats.
    #[serde(default)]
    pub thinking_level: String,
    pub message_count: usize,
    pub message_bytes: usize,
    pub system_prompt_tokens: usize,
    #[serde(default)]
    pub tool_definition_tokens: usize,
    /// Full system prompt text sent to the model (for the trace messages view).
    #[serde(default)]
    pub system_prompt: String,
    /// Tool schemas sent to the model (name, description, JSON Schema params).
    #[serde(default)]
    pub tool_definitions: Vec<ToolDef>,
}

/// A tool schema as sent to the model, persisted for the trace messages view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCallRetryStats {
    pub turn: usize,
    pub attempt: usize,
    pub max_retries: usize,
    pub delay_ms: u64,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCallCompletedStats {
    pub turn: usize,
    pub attempt: usize,
    pub usage: UsageSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<LlmCallMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub context_window: usize,
    #[serde(default)]
    pub stop_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFinishedStats {
    pub tool_call_id: String,
    pub tool_name: String,
    pub result_tokens: usize,
    pub duration_ms: u64,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextCompactionStartedStats {
    #[serde(default = "default_compact_reason")]
    pub reason: CompactReason,
    #[serde(default)]
    pub message_count: usize,
    pub estimated_tokens: usize,
    pub budget_tokens: usize,
    #[serde(default)]
    pub reserve_tokens: usize,
    #[serde(default)]
    pub trigger_threshold: usize,
    #[serde(default)]
    pub system_prompt_tokens: usize,
    #[serde(default)]
    pub tool_definition_tokens: usize,
    pub context_window: usize,
    #[serde(default)]
    pub will_retry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CompactionResult {
    NoOp,
    Compacted {
        before_message_count: usize,
        after_message_count: usize,
        before_tokens: usize,
        after_tokens: usize,
        messages_evicted: usize,
        current_run_reclaimed: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        method: Option<CompactionMethod>,
        /// Encrypted provider-native payload size, when remote succeeded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote_blob_bytes: Option<usize>,
        /// Why provider-native compaction was unavailable or failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback_reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextCompactionCompletedStats {
    #[serde(default = "default_compact_reason")]
    pub reason: CompactReason,
    pub result: CompactionResult,
    #[serde(default)]
    pub context_window: usize,
    #[serde(default)]
    pub will_retry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFinishedStats {
    pub usage: UsageSummary,
    pub turn_count: u32,
    pub duration_ms: u64,
    pub transcript_count: usize,
}

fn default_compact_reason() -> CompactReason {
    CompactReason::Threshold
}

/// One run-end step of the judge-driven prune branch. `decided` records the
/// verdicts with their probabilities so the judge's quality can be evaluated
/// offline; `applied` is present when the context was actually edited.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPrunedStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided: Option<evot_engine::context::compaction::DecideReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<evot_engine::context::compaction::ApplyReport>,
    #[serde(default)]
    pub context_window: usize,
}

// ---------------------------------------------------------------------------
// TranscriptStats — aggregating enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum TranscriptStats {
    LlmCallStarted(LlmCallStartedStats),
    LlmCallRetry(LlmCallRetryStats),
    LlmCallCompleted(LlmCallCompletedStats),
    ToolFinished(ToolFinishedStats),
    ContextCompactionStarted(ContextCompactionStartedStats),
    ContextCompactionCompleted(ContextCompactionCompletedStats),
    ContextPruned(ContextPrunedStats),
    RunFinished(RunFinishedStats),
}

impl TranscriptStats {
    /// Stable kind string for serialization / grep / jq.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::LlmCallStarted(_) => "llm_call_started",
            Self::LlmCallRetry(_) => "llm_call_retry",
            Self::LlmCallCompleted(_) => "llm_call_completed",
            Self::ToolFinished(_) => "tool_finished",
            Self::ContextCompactionStarted(_) => "context_compaction_started",
            Self::ContextCompactionCompleted(_) => "context_compaction_completed",
            Self::ContextPruned(_) => "context_pruned",
            Self::RunFinished(_) => "run_finished",
        }
    }

    /// Convert to a flat `TranscriptItem::Stats` for persistence.
    pub fn to_item(&self) -> TranscriptItem {
        let kind = self.kind_str().to_string();
        let data = match self {
            Self::LlmCallStarted(s) => serde_json::to_value(s),
            Self::LlmCallRetry(s) => serde_json::to_value(s),
            Self::LlmCallCompleted(s) => serde_json::to_value(s),
            Self::ToolFinished(s) => serde_json::to_value(s),
            Self::ContextCompactionStarted(s) => serde_json::to_value(s),
            Self::ContextCompactionCompleted(s) => serde_json::to_value(s),
            Self::ContextPruned(s) => serde_json::to_value(s),
            Self::RunFinished(s) => serde_json::to_value(s),
        }
        .unwrap_or_default();
        TranscriptItem::Stats { kind, data }
    }

    /// Try to decode a `TranscriptItem::Stats` back into a strong type.
    ///
    /// Returns `None` for non-Stats items, unknown kinds, or schema mismatches.
    pub fn try_from_item(item: &TranscriptItem) -> Option<Self> {
        let (kind, data) = match item {
            TranscriptItem::Stats { kind, data } => (kind.as_str(), data),
            _ => return None,
        };
        match kind {
            "llm_call_started" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::LlmCallStarted),
            "llm_call_retry" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::LlmCallRetry),
            "llm_call_completed" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::LlmCallCompleted),
            "tool_finished" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::ToolFinished),
            "context_compaction_started" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::ContextCompactionStarted),
            "context_compaction_completed" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::ContextCompactionCompleted),
            "context_pruned" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::ContextPruned),
            "run_finished" => serde_json::from_value(data.clone())
                .ok()
                .map(Self::RunFinished),
            _ => None,
        }
    }
}
