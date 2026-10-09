use serde::Deserialize;
use serde::Serialize;

use super::llm::StopReason;
use super::llm::Usage;
use crate::context::now_ms;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/// Controls how long a tool result's content stays in context.
///
/// Only the compaction system consumes this — other modules pass it through.
/// `CurrentRun` cleanup is keyed off `Message::User`. Tool-generated
/// interactions (e.g. ask_user responses) are `Message::ToolResult` and
/// do NOT trigger cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retention {
    #[default]
    Normal,
    CurrentRun,
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImageSource {
    Path { path: String },
    Base64 { data: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThinkingMetadata {
    Anthropic {
        signature: String,
    },
    OpenAiResponses {
        item: serde_json::Value,
    },
    OpenAiCompletions {
        field: ReasoningField,
        /// Opaque `reasoning_details` entries (OpenRouter wire shape) that the
        /// endpoint needs replayed verbatim to continue its reasoning state,
        /// e.g. `reasoning.encrypted` payloads. Absent for endpoints that only
        /// stream reasoning text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Vec<serde_json::Value>>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolCallMetadata {
    OpenAiResponses { item_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningField {
    ReasoningContent,
    Reasoning,
    ReasoningText,
}

impl ThinkingMetadata {
    /// Reasoning text that only came from a plain reasoning field, without
    /// any opaque replay payload attached.
    pub fn completions_text_only(field: ReasoningField) -> Self {
        Self::OpenAiCompletions {
            field,
            details: None,
        }
    }

    /// Whether this metadata carries opaque provider state that must be
    /// replayed even when the visible thinking text is empty.
    pub fn has_replay_payload(&self) -> bool {
        match self {
            Self::Anthropic { signature } => !signature.is_empty(),
            Self::OpenAiResponses { .. } => true,
            Self::OpenAiCompletions { details, .. } => {
                details.as_ref().is_some_and(|items| !items.is_empty())
            }
        }
    }

    pub fn supports_api(&self, api: crate::provider::ApiProtocol) -> bool {
        matches!(
            (self, api),
            (
                Self::Anthropic { .. },
                crate::provider::ApiProtocol::AnthropicMessages
            ) | (
                Self::OpenAiResponses { .. },
                crate::provider::ApiProtocol::OpenAiResponses
            ) | (
                Self::OpenAiCompletions { .. },
                crate::provider::ApiProtocol::OpenAiCompletions
            )
        )
    }
}

impl ToolCallMetadata {
    pub fn supports_api(&self, api: crate::provider::ApiProtocol) -> bool {
        matches!(
            (self, api),
            (
                Self::OpenAiResponses { .. },
                crate::provider::ApiProtocol::OpenAiResponses
            )
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        source: ImageSource,
    },
    #[serde(rename = "thinking")]
    Thinking {
        thinking: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<ThinkingMetadata>,
    },
    #[serde(rename = "toolCall")]
    ToolCall {
        id: String,
        name: String,
        arguments: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<ToolCallMetadata>,
    },
}

impl Content {
    /// Resolve image data: load from disk if path-based, then resize to fit
    /// within 2000×2000 and 5MB limits before sending to the provider.
    /// Returns `(base64_data, mime_type)` or `None` if resolution fails.
    ///
    /// The media type sent is what the bytes are, whatever the block
    /// declared: images arrive from the read tool, chat channels and user
    /// attachments, each naming a type from a file name or a sender's
    /// header, and Anthropic rejects the whole request when that disagrees
    /// with the data. This is the one place every image passes through on
    /// its way to a provider, so it is where the declaration is settled.
    pub fn resolve_image_data(&self) -> Option<(String, String)> {
        use base64::Engine;
        let raw = match self {
            Content::Image { mime_type, source } => match source {
                ImageSource::Base64 { data } if !data.is_empty() => {
                    let mime = sniffed_mime_type_from_base64(data).unwrap_or(mime_type.as_str());
                    Some((data.clone(), mime.to_string()))
                }
                ImageSource::Path { path } => match std::fs::read(path) {
                    Ok(bytes) => {
                        let mime = crate::context::detect_image_mime_type(&bytes)
                            .unwrap_or(mime_type.as_str());
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        Some((b64, mime.to_string()))
                    }
                    Err(_) => None,
                },
                ImageSource::Base64 { .. } => None,
            },
            _ => None,
        };

        // Apply resize to cap dimensions at 2000×2000 and size at 5MB.
        // Token budgeting uses pi's fixed 4,800-character image heuristic;
        // resizing still bounds the actual provider payload and cost.
        // If resize fails (e.g., unrecognized format), fall back to original data.
        raw.map(|(data, mime)| crate::context::resize_image(&data, &mime).unwrap_or((data, mime)))
    }
}

/// Media type of base64 image data, read from the decoded header only.
fn sniffed_mime_type_from_base64(data: &str) -> Option<&'static str> {
    use base64::Engine;
    // 4 base64 chars per 3 bytes; take whole quads so the prefix decodes.
    let prefix_len = (crate::context::IMAGE_SNIFF_BYTES / 3 + 1) * 4;
    let prefix = &data[..data.len().min(prefix_len)];
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(prefix)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(prefix))
        .ok()?;
    crate::context::detect_image_mime_type(&decoded)
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "user")]
    User {
        content: Vec<Content>,
        timestamp: u64,
    },
    #[serde(rename = "assistant")]
    Assistant {
        content: Vec<Content>,
        #[serde(rename = "stopReason")]
        stop_reason: StopReason,
        model: String,
        provider: String,
        usage: Usage,
        timestamp: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        /// Unique completion identifier from the provider (e.g. `chatcmpl-xxx`, `msg_xxx`).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        response_id: Option<String>,
    },
    #[serde(rename = "toolResult")]
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        content: Vec<Content>,
        #[serde(rename = "isError")]
        is_error: bool,
        timestamp: u64,
        #[serde(default)]
        retention: Retention,
    },
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User {
            content: vec![Content::Text { text: text.into() }],
            timestamp: now_ms(),
        }
    }

    pub fn role(&self) -> &str {
        match self {
            Self::User { .. } => "user",
            Self::Assistant { .. } => "assistant",
            Self::ToolResult { .. } => "toolResult",
        }
    }

    /// Check if this assistant message represents a context overflow error.
    ///
    /// Some providers (SSE-based: Anthropic, OpenAI) return overflow as a
    /// `StopReason::Error` message rather than an HTTP error. This method
    /// checks the `error_message` field against known overflow patterns.
    pub fn is_context_overflow(&self) -> bool {
        match self {
            Self::Assistant {
                stop_reason: StopReason::Error,
                error_message: Some(msg),
                ..
            } => crate::provider::error::is_context_overflow_message(msg),
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// AgentMessage — LLM messages + extensible custom types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionMessage {
    pub role: String,
    pub kind: String,
    pub data: serde_json::Value,
}

impl ExtensionMessage {
    pub fn new(kind: impl Into<String>, data: impl Serialize) -> Self {
        Self {
            role: "extension".into(),
            kind: kind.into(),
            data: match serde_json::to_value(data) {
                Ok(v) => v,
                Err(_) => serde_json::Value::Null,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentMessage {
    /// Standard LLM message
    Llm(Message),
    /// App-specific message (UI-only, notifications, etc.)
    Extension(ExtensionMessage),
}

impl AgentMessage {
    pub fn role(&self) -> &str {
        match self {
            Self::Llm(m) => m.role(),
            Self::Extension(ext) => &ext.role,
        }
    }

    pub fn as_llm(&self) -> Option<&Message> {
        match self {
            Self::Llm(m) => Some(m),
            Self::Extension(_) => None,
        }
    }
}

impl From<Message> for AgentMessage {
    fn from(m: Message) -> Self {
        Self::Llm(m)
    }
}

/// Upgrade persisted Responses tool identities from the former
/// `call_id|item_id` encoding to the canonical ID plus provider metadata.
pub fn migrate_legacy_responses_tool_ids(messages: &mut [AgentMessage]) {
    let mut migrated_ids = std::collections::HashMap::new();

    for message in messages.iter_mut() {
        let AgentMessage::Llm(Message::Assistant { content, .. }) = message else {
            continue;
        };
        for block in content {
            let Content::ToolCall { id, metadata, .. } = block else {
                continue;
            };
            let Some((call_id, item_id)) = id.split_once('|') else {
                continue;
            };
            let identifiable = match metadata.as_ref() {
                Some(ToolCallMetadata::OpenAiResponses {
                    item_id: metadata_item_id,
                }) => metadata_item_id == item_id,
                None => item_id.starts_with("fc_") || item_id.starts_with("fc-"),
            };
            if call_id.is_empty() || !identifiable {
                continue;
            }

            let legacy_id = id.clone();
            let call_id = call_id.to_string();
            if metadata.is_none() {
                *metadata = Some(ToolCallMetadata::OpenAiResponses {
                    item_id: item_id.to_string(),
                });
            }
            id.clone_from(&call_id);
            migrated_ids.insert(legacy_id, call_id);
        }
    }

    for message in messages {
        let AgentMessage::Llm(Message::ToolResult { tool_call_id, .. }) = message else {
            continue;
        };
        if let Some(call_id) = migrated_ids.get(tool_call_id) {
            tool_call_id.clone_from(call_id);
        }
    }
}
