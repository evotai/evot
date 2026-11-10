use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::model::ModelConfig;
use crate::provider::ProviderError;
use crate::types::*;

/// Events emitted during LLM streaming
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Stream started, partial assistant message
    Start,
    /// Text content delta
    TextDelta { content_index: usize, delta: String },
    /// Thinking content delta
    ThinkingDelta { content_index: usize, delta: String },
    /// Tool call started. Arguments arrive separately as raw JSON deltas.
    ToolCallStart {
        content_index: usize,
        id: String,
        name: String,
    },
    /// Raw tool call argument fragment, matching the provider stream.
    ToolCallDelta {
        content_index: usize,
        id: String,
        name: String,
        delta: String,
    },
    /// Tool call ended with its finalized arguments.
    ToolCallEnd {
        content_index: usize,
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Stream completed successfully
    Done { message: Message },
    /// Stream errored
    Error { message: Message },
}

/// Configuration for a streaming LLM call
#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub model: String,
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub thinking_level: ThinkingLevel,
    pub api_key: String,
    pub max_tokens: Option<u32>,
    /// Optional model configuration for multi-provider support.
    /// When set, providers use this for base_url, compat flags, headers, etc.
    pub model_config: Option<ModelConfig>,
    /// Prompt caching configuration. Default: enabled with auto strategy.
    pub cache_config: CacheConfig,
    /// Optional key for provider-side prompt cache routing.
    pub prompt_cache_key: Option<String>,
    /// Optional dedicated HTTP client.
    ///
    /// `None` uses the process-wide shared client, which is right for the
    /// application: one connection pool against a stable set of origins. Tests
    /// that point providers at many short-lived mock servers must set their
    /// own: a pooled keep-alive connection belonging to an origin that has
    /// since been recycled onto the same port can hand one server's response to
    /// another server's request.
    pub client: Option<reqwest::Client>,
}

impl StreamConfig {
    /// The client for this request: the dedicated one when set, otherwise the
    /// shared process client.
    pub fn http_client(&self) -> Result<reqwest::Client, crate::provider::ProviderError> {
        match &self.client {
            Some(client) => Ok(client.clone()),
            None => crate::provider::error::new_client(),
        }
    }

    /// Caller output cap before applying the model's independent output limit.
    pub fn requested_max_tokens(&self) -> u32 {
        self.max_tokens
            .or(self.model_config.as_ref().map(|model| model.max_tokens()))
            .unwrap_or(8192)
            .max(1)
    }

    /// Clamp an output cap to the model's declared maximum output size.
    ///
    /// `ModelConfig::context_window()` is the independent maximum input size,
    /// so it must not be reduced by or used to reduce this output budget.
    pub fn clamp_max_tokens_to_model(&self, requested: u32) -> u32 {
        self.model_config
            .as_ref()
            .map(|model| requested.min(model.max_tokens()))
            .unwrap_or(requested)
            .max(1)
    }

    pub fn resolved_max_tokens(&self) -> u32 {
        self.clamp_max_tokens_to_model(self.requested_max_tokens())
    }
}

/// Provider stream outcome.
///
/// `message.model` is the requested model used for thinking replay.
/// `served_model` is the upstream alias when it differs, for UI only.
#[derive(Debug)]
pub struct StreamOutcome {
    message: Message,
    served_model: Option<String>,
}

impl StreamOutcome {
    pub fn complete(message: Message) -> Self {
        Self {
            message,
            served_model: None,
        }
    }

    pub fn served_by(mut self, served: Option<String>) -> Self {
        let requested = match &self.message {
            Message::Assistant { model, .. } => model.as_str(),
            _ => return self,
        };
        self.served_model = served.filter(|name| !name.is_empty() && name != requested);
        self
    }

    pub fn message(&self) -> &Message {
        &self.message
    }

    pub fn into_message(self) -> Message {
        self.message
    }

    pub fn served_model(&self) -> Option<&str> {
        self.served_model.as_deref()
    }
}

impl From<Message> for StreamOutcome {
    fn from(message: Message) -> Self {
        Self::complete(message)
    }
}

/// The core provider trait. Implement this for each LLM backend.
#[async_trait]
impl<T: StreamProvider + ?Sized> StreamProvider for Arc<T> {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.as_ref().stream(config, tx, cancel).await
    }

    async fn stream_bounded(
        &self,
        config: StreamConfig,
        tx: mpsc::Sender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.as_ref().stream_bounded(config, tx, cancel).await
    }
}

#[async_trait]
pub trait StreamProvider: Send + Sync {
    /// Bounded host path. Legacy custom providers use this compatibility
    /// bridge; built-in HTTP providers override it without an intermediate queue.
    async fn stream_bounded(
        &self,
        config: StreamConfig,
        tx: mpsc::Sender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        super::legacy_bridge::stream(self, config, tx, cancel).await
    }

    /// Stream a completion, sending [`StreamEvent`]s through the channel.
    ///
    /// On success returns the completed assistant message. On failure returns a
    /// [`ProviderError`] for retry/error handling.
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError>;
}
