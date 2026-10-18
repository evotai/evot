//! Transcript domain model — items, entries, and context projection.

pub use evot_engine::CompactionMethod;
use serde::Deserialize;
use serde::Serialize;

use crate::observability::UsageSummary;

// ---------------------------------------------------------------------------
// MarkerKind — types of transcript markers that reset the context baseline
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MarkerKind {
    /// Clear the context — start fresh.
    Clear,
}

// ---------------------------------------------------------------------------
// AssistantBlock — content blocks in assistant messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantBlock {
    Text {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<evot_engine::ToolCallMetadata>,
    },
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<evot_engine::ThinkingMetadata>,
    },
}

impl AssistantBlock {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            _ => None,
        }
    }
}

pub fn assistant_text(content: &[AssistantBlock]) -> String {
    content.iter().filter_map(AssistantBlock::text).collect()
}

// ---------------------------------------------------------------------------
// TranscriptUserContent — user content blocks preserved in original order
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptUserContent {
    Text {
        text: String,
    },
    Image {
        mime_type: String,
        source: TranscriptImageSource,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptImageSource {
    Base64 { data: String },
    Path { path: String },
}

// ---------------------------------------------------------------------------
// Compact transcript model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompactReason {
    Threshold,
    Overflow,
    Manual,
    /// Judge-decided prune applied at run end (no summary written).
    Prune,
    /// Automatic compact-and-retry after a provider safety refusal.
    Refusal,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompactDetails {
    #[serde(default)]
    pub read_files: Vec<String>,
    #[serde(default)]
    pub modified_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<CompactionMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_blob_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

// ---------------------------------------------------------------------------
// TranscriptItem — a single item in a conversation transcript
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptItem {
    User {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<TranscriptUserContent>,
        /// Versioned source metadata; never changes text/content sent to models.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provenance: Option<evot_engine::InputProvenance>,
    },
    Assistant {
        #[serde(alias = "content_blocks")]
        content: Vec<AssistantBlock>,
        stop_reason: String,
        #[serde(default)]
        usage: UsageSummary,
        #[serde(default)]
        model: String,
        #[serde(default)]
        provider: String,
        #[serde(default)]
        timestamp: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
        /// Structured metadata for UI rendering and state reconstruction on
        /// resume (e.g. a plan artifact's task list). Never sent to the LLM.
        /// Defaults to null for transcripts written before this field existed.
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        details: serde_json::Value,
    },
    System {
        text: String,
    },
    Extension {
        kind: String,
        data: serde_json::Value,
    },
    Compact {
        id: String,
        created_at: u64,
        reason: CompactReason,
        summary: String,
        tokens_before: usize,
        tokens_after: usize,
        messages_before: usize,
        messages_after: usize,
        /// App-layer replacement context used by transcript views.
        messages: Vec<TranscriptItem>,
        /// Exact Engine replacement context. This preserves retention,
        /// timestamps, and sanitized tool-pair boundaries across resume.
        engine_messages: Vec<evot_engine::AgentMessage>,
        /// Exact Engine cross-compaction state.
        state: Box<evot_engine::CompactionState>,
        #[serde(default)]
        details: CompactDetails,
    },
    /// Observability fact — persisted in transcript.jsonl but never enters
    /// the conversation context sent to the engine.
    Stats {
        kind: String,
        data: serde_json::Value,
    },
    /// Unified marker that resets the current context baseline. Compaction is a
    /// first-class `TranscriptItem::Compact` entry instead of a marker kind.
    Marker {
        kind: MarkerKind,
        /// Context snapshot at the time of the marker.
        messages: Vec<TranscriptItem>,
    },
}

impl TranscriptItem {
    /// Whether this item belongs in the conversation context view.
    ///
    /// Items that return `false` are observability/control facts that live in
    /// the raw transcript but must be filtered out before sending to the engine.
    pub fn is_context_item(&self) -> bool {
        !matches!(
            self,
            Self::Stats { .. } | Self::Compact { .. } | Self::Marker { .. }
        )
    }

    pub fn as_user_text(&self) -> Option<String> {
        match self {
            Self::User { text, .. } => Some(text.clone()),
            _ => None,
        }
    }

    /// Build a User transcript item from engine content blocks.
    pub fn user_from_content(content: &[evot_engine::Content]) -> Self {
        let text = content
            .iter()
            .filter_map(|c| match c {
                evot_engine::Content::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");

        let content = content
            .iter()
            .filter_map(|c| match c {
                evot_engine::Content::Text { text } => {
                    Some(TranscriptUserContent::Text { text: text.clone() })
                }
                evot_engine::Content::Image { mime_type, source } => {
                    let source = match source {
                        evot_engine::ImageSource::Base64 { data } => {
                            TranscriptImageSource::Base64 { data: data.clone() }
                        }
                        evot_engine::ImageSource::Path { path } => {
                            TranscriptImageSource::Path { path: path.clone() }
                        }
                    };
                    Some(TranscriptUserContent::Image {
                        mime_type: mime_type.clone(),
                        source,
                    })
                }
                _ => None,
            })
            .collect();

        Self::User {
            text,
            content,
            provenance: None,
        }
    }
}

// ---------------------------------------------------------------------------
// TranscriptEntry — a transcript item with metadata for storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub session_id: String,
    pub run_id: Option<String>,
    pub seq: u64,
    pub turn: u32,
    pub item: TranscriptItem,
    pub created_at: String,
}

impl TranscriptEntry {
    pub fn new(
        session_id: String,
        run_id: Option<String>,
        seq: u64,
        turn: u32,
        item: TranscriptItem,
    ) -> Self {
        Self {
            session_id,
            run_id,
            seq,
            turn,
            item,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

// ---------------------------------------------------------------------------
// ListTranscriptEntries — query for listing transcript entries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListTranscriptEntries {
    pub session_id: String,
    pub run_id: Option<String>,
    pub after_seq: Option<u64>,
    pub limit: Option<usize>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a run-finished usage summary by summing assistant-message usage.
/// This is a convenience re-export so callers don't need to depend on metrics
/// directly when they already have a `UsageSummary`.
/// Short preview of a transcript item for context navigation output.
pub fn entry_preview(item: &TranscriptItem) -> String {
    let text = match item {
        TranscriptItem::User { text, .. } => text.clone(),
        TranscriptItem::Assistant { content, .. } => assistant_text(content),
        _ => String::new(),
    };
    let normalized: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let preview: String = chars.by_ref().take(60).collect();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}
