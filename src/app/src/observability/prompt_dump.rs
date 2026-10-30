//! Prompt dump model — structured snapshot of the system prompt + tools that
//! evot would send to the LLM right now.
//!
//! Produced on demand by the hidden `/_dump` slash command. Intended to be
//! human-readable JSON that can be diffed across builder changes or fed into a
//! standalone replay harness for prompt A/B testing.

use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptDump {
    /// evot version that produced this dump.
    pub evot_version: String,
    /// Working directory at dump time.
    pub cwd: String,
    /// Active tool mode (e.g. "Interactive", "Headless", "Readonly").
    pub mode: String,
    /// Model name evot would call.
    pub model: String,
    /// Thinking / reasoning effort hint.
    pub thinking_level: String,
    /// Full system prompt with per-section breakdown.
    pub system_prompt: SystemPromptDump,
    /// Tool definitions evot would attach to the request.
    pub tools: Vec<ToolDump>,
    /// Token totals for quick comparison.
    pub totals: TokenTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemPromptDump {
    /// The exact string evot would send as the system prompt.
    pub text: String,
    pub tokens: usize,
    pub sections: Vec<SectionDump>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionDump {
    pub name: String,
    pub text: String,
    pub tokens: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDump {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub tokens: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenTotals {
    pub system_prompt_tokens: usize,
    pub tool_definition_tokens: usize,
    pub grand_total: usize,
}
