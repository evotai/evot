//! OpenAI-compatible streaming and non-streaming response types.

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Streaming (SSE chunk) types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct OpenAiChunk {
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) choices: Vec<OpenAiChoice>,
    #[serde(default)]
    pub(crate) usage: Option<OpenAiUsage>,
    #[serde(default)]
    pub(crate) incomplete_details: Option<OpenAiIncompleteDetails>,
    #[serde(default)]
    pub error: Option<OpenAiErrorBody>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiIncompleteDetails {
    #[serde(default)]
    pub reason: String,
}

#[derive(Deserialize)]
pub struct OpenAiErrorBody {
    #[serde(default)]
    pub message: String,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiChoice {
    pub delta: OpenAiDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
pub(crate) struct OpenAiDelta {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_text: Option<String>,
    /// OpenRouter-style structured reasoning replay entries. Streamed as
    /// deltas; text/summary entries are coalesced, encrypted entries kept
    /// discrete. See [`super::reasoning_details`].
    #[serde(default)]
    pub reasoning_details: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub tool_calls: Option<Vec<OpenAiToolCallDelta>>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiToolCallDelta {
    #[serde(default)]
    pub index: u32,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<OpenAiFunctionDelta>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiFunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    /// Legacy cache-hit field used by compatible providers.
    #[serde(default)]
    pub prompt_cache_hit_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub prompt_tokens_details: Option<OpenAiPromptTokensDetails>,
    #[serde(default)]
    pub completion_tokens_details: Option<OpenAiCompletionTokensDetails>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiPromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: u64,
    /// Compatible providers may report cache writes separately.
    #[serde(default)]
    pub cache_write_tokens: u64,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiCompletionTokensDetails {
    #[serde(default)]
    pub reasoning_tokens: u64,
}

// ---------------------------------------------------------------------------
// Non-streaming (full JSON completion) types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct OpenAiResponse {
    #[serde(default)]
    pub choices: Vec<OpenAiResponseChoice>,
    #[serde(default)]
    pub usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiResponseChoice {
    pub message: OpenAiResponseMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiResponseMessage {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_text: Option<String>,
    #[serde(default)]
    pub reasoning_details: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub tool_calls: Option<Vec<OpenAiResponseToolCall>>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiResponseToolCall {
    #[serde(default)]
    pub id: String,
    pub function: OpenAiResponseFunction,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiResponseFunction {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}
