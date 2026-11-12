//! Anthropic SSE/JSON payload types.

use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct AnthropicMessageStart {
    pub message: AnthropicMessageInfo,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicMessageInfo {
    #[serde(default)]
    pub id: Option<String>,
    pub usage: AnthropicUsage,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicUsage {
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens_details: Option<AnthropicOutputTokensDetails>,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicOutputTokensDetails {
    #[serde(default)]
    pub thinking_tokens: u64,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicContentBlockStart {
    pub index: u64,
    pub content_block: AnthropicContentBlock,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text {
        #[allow(dead_code)]
        text: String,
    },
    #[serde(rename = "thinking")]
    Thinking {
        #[allow(dead_code)]
        thinking: String,
    },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },
    /// Server-side model fallback notice (e.g. claude-fable-5 → claude-opus-4-8
    /// on refusal/reasoning-extraction). Carries the substitute model so the
    /// UI can surface what actually served the request.
    #[serde(rename = "fallback")]
    Fallback {
        #[serde(default)]
        to: Option<AnthropicFallbackModel>,
    },
    /// Any other block type (e.g. `redacted_thinking`, or forward-compat
    /// server-side blocks). Ignored rather than rejected so a
    /// new Anthropic block type does not abort the whole stream, matching pi's
    /// permissive `if/else if` dispatch.
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicFallbackModel {
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicContentBlockDelta {
    pub index: u64,
    pub delta: AnthropicDelta,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
#[allow(clippy::enum_variant_names)]
pub(crate) enum AnthropicDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { thinking: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
    #[serde(rename = "signature_delta")]
    SignatureDelta { signature: String },
    /// Any other delta type. Ignored rather than rejected for forward
    /// compatibility with new Anthropic delta kinds.
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicMessageDelta {
    pub delta: AnthropicMessageDeltaInner,
    pub usage: AnthropicUsage,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicMessageDeltaInner {
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_details: Option<AnthropicStopDetails>,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicStopDetails {
    #[serde(default)]
    pub category: Option<String>,
}
