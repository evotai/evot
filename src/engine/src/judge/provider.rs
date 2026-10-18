//! A [`Judge`] that speaks through an ordinary [`StreamProvider`].
//!
//! llmproxy's Jev channel accepts a Messages / Chat request whose single tool
//! schema is the question list, so the judge is just another model endpoint
//! from the client's point of view: same transport, same credentials, same
//! request accounting.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::wire;
use super::Answer;
use super::Judge;
use super::JudgeError;
use super::JudgeLimits;
use super::Question;
use crate::context::now_ms;
use crate::provider::ModelConfig;
use crate::provider::StreamConfig;
use crate::provider::StreamEvent;
use crate::provider::StreamProvider;
use crate::provider::ToolDefinition;
use crate::types::CacheConfig;
use crate::types::Content;
use crate::types::Message;
use crate::types::StopReason;
use crate::types::ThinkingLevel;

pub struct ProviderJudge {
    provider: Arc<dyn StreamProvider>,
    model: String,
    api_key: String,
    model_config: Option<ModelConfig>,
    session_id: Option<String>,
    limits: JudgeLimits,
}

impl ProviderJudge {
    pub fn new(
        provider: Arc<dyn StreamProvider>,
        model: impl Into<String>,
        api_key: impl Into<String>,
        model_config: Option<ModelConfig>,
    ) -> Self {
        Self {
            provider,
            model: model.into(),
            api_key: api_key.into(),
            model_config,
            session_id: None,
            limits: JudgeLimits::default(),
        }
    }

    /// Attach the active application session to every judge request.
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Size requests for a judge model other than the default one.
    pub fn with_limits(mut self, limits: JudgeLimits) -> Self {
        self.limits = limits;
        self
    }

    fn request(&self, state: &str, questions: &[Question]) -> StreamConfig {
        StreamConfig {
            model: self.model.clone(),
            system_prompt: String::new(),
            messages: vec![Message::User {
                provenance: None,
                content: vec![Content::Text {
                    text: state.to_string(),
                }],
                timestamp: now_ms(),
            }],
            tools: vec![ToolDefinition {
                name: wire::TOOL_NAME.into(),
                description: "Typed decisions about the state.".into(),
                parameters: wire::tool_schema(questions),
            }],
            thinking_level: ThinkingLevel::Off,
            api_key: self.api_key.clone(),
            max_tokens: Some(1),
            model_config: self.model_config.clone(),
            cache_config: CacheConfig::default(),
            prompt_cache_key: self.session_id.clone(),
            client: None,
        }
    }
}

#[async_trait]
impl Judge for ProviderJudge {
    async fn ask(
        &self,
        state: &str,
        questions: &[Question],
        cancel: CancellationToken,
    ) -> Result<HashMap<String, Answer>, JudgeError> {
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let stream = self
            .provider
            .stream(self.request(state, questions), tx, cancel.clone());
        tokio::pin!(stream);
        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = futures::poll!(&mut stream);
                return Err(JudgeError::Cancelled);
            }
            result = &mut stream => result.map_err(|e| JudgeError::Transport(e.to_string()))?,
        };
        rx.close();
        while rx.try_recv().is_ok() {}

        let Message::Assistant {
            content,
            stop_reason,
            error_message,
            ..
        } = outcome.into_message()
        else {
            return Err(JudgeError::Malformed(
                "reply is not an assistant message".into(),
            ));
        };
        if stop_reason == StopReason::Error {
            return Err(JudgeError::Transport(
                error_message.unwrap_or_else(|| "unknown error".into()),
            ));
        }
        let text = content.iter().find_map(|c| match c {
            Content::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        });
        let tool_input = content.iter().find_map(|c| match c {
            Content::ToolCall { arguments, .. } => Some(arguments),
            _ => None,
        });
        wire::parse_answers(questions, text, tool_input)
    }

    fn limits(&self) -> JudgeLimits {
        self.limits
    }
}
