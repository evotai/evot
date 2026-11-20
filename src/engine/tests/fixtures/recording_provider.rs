//! Recording provider — captures `StreamConfig` inputs and returns scripted
//! replies in order.
//!
//! Unlike `MockProvider`, this fixture records every request so tests can
//! assert on what was actually sent to the LLM (prompts, system prompt,
//! `max_tokens`, message count). Replies are consumed per call, enabling
//! multi-call scenarios such as split-turn summaries.
//!
//! # Example
//! ```rust,ignore
//! let provider = RecordingProvider::new(vec![Reply::text("SUMMARY")]);
//! let captured = provider.captured();
//! // ... drive the code under test ...
//! assert!(captured.lock()[0].system_prompt.contains("summarization"));
//! ```

use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use evotengine::provider::error::ProviderError;
use evotengine::provider::traits::*;
use evotengine::provider::StreamOutcome;
use evotengine::provider::StreamProvider;
use evotengine::types::*;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A scripted reply for a single `stream` call.
#[derive(Debug, Clone)]
pub enum Reply {
    /// Return an assistant text message that stops normally.
    Text(String),
    /// Return an assistant message with `StopReason::Error` and the given message.
    Error(String),
    /// Cancel the provided token, then return an (ignored) text message.
    /// Mirrors a mid-flight cancellation observed by the caller after draining.
    Cancel,
    /// Fail the request with a provider-declared transient error.
    Transient(String),
    /// Fail the request with an invalid-request error.
    Invalid(String),
}

impl Reply {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(text.into())
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::Error(message.into())
    }
}

/// Captured request log, shared between the provider and the test.
pub type Captured = Arc<Mutex<Vec<StreamConfig>>>;

/// Provider that records requests and returns scripted replies.
pub struct RecordingProvider {
    replies: Mutex<VecDeque<Reply>>,
    captured: Captured,
}

impl RecordingProvider {
    /// Create a provider with the given replies, consumed in order.
    pub fn new(replies: Vec<Reply>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            captured: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Handle to the captured request log. Clone-friendly (`Arc`).
    pub fn captured(&self) -> Captured {
        self.captured.clone()
    }
}

#[async_trait]
impl StreamProvider for RecordingProvider {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.captured.lock().push(config);

        let reply = self
            .replies
            .lock()
            .pop_front()
            .unwrap_or_else(|| Reply::Text("(no more scripted replies)".into()));

        let _ = tx.send(StreamEvent::Start);

        let message = match reply {
            Reply::Text(text) => assistant_text(text, StopReason::Stop, None),
            Reply::Error(message) => {
                assistant_text(String::new(), StopReason::Error, Some(message))
            }
            Reply::Cancel => {
                cancel.cancel();
                assistant_text(String::new(), StopReason::Stop, None)
            }
            Reply::Transient(message) => return Err(ProviderError::Transient { message }),
            Reply::Invalid(message) => return Err(ProviderError::InvalidRequest(message)),
        };

        let _ = tx.send(StreamEvent::Done {
            message: message.clone(),
        });
        Ok(StreamOutcome::complete(message))
    }
}

fn assistant_text(text: String, stop_reason: StopReason, error_message: Option<String>) -> Message {
    Message::Assistant {
        content: vec![Content::Text { text }],
        stop_reason,
        model: "recording".into(),
        provider: "recording".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message,
        response_id: None,
    }
}
