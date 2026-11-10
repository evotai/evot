use serde::Deserialize;
use serde::Serialize;

/// Wire protocol used to invoke a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiProtocol {
    AnthropicMessages,
    OpenAiResponses,
    OpenAiCompletions,
}

impl std::fmt::Display for ApiProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AnthropicMessages => write!(f, "anthropic_messages"),
            Self::OpenAiResponses => write!(f, "openai_responses"),
            Self::OpenAiCompletions => write!(f, "openai_completions"),
        }
    }
}
