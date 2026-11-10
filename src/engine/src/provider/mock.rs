//! Mock provider for testing. No real API calls.

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::error::*;
use super::traits::*;
use crate::time::now_ms;
use crate::types::*;

/// A mock response: either plain text or tool calls
#[derive(Debug, Clone)]
pub enum MockResponse {
    Text(String),
    TextWithUsage {
        text: String,
        usage: Usage,
    },
    ToolCalls(Vec<MockToolCall>),
    ToolCallsWithStop {
        calls: Vec<MockToolCall>,
        stop_reason: StopReason,
    },
    /// Tool calls with the provider's own token count, as real providers
    /// report it on tool-use responses.
    ToolCallsWithUsage {
        calls: Vec<MockToolCall>,
        usage: Usage,
    },
    TextWithUsageAndStop {
        text: String,
        usage: Usage,
        stop_reason: StopReason,
    },
    TextWithUsageStopAndModel {
        text: String,
        usage: Usage,
        stop_reason: StopReason,
        model: String,
    },
}

#[derive(Debug, Clone)]
pub struct MockToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Mock LLM provider for tests. Supply a sequence of responses.
pub struct MockProvider {
    responses: Mutex<Vec<MockResponse>>,
}

impl MockProvider {
    pub fn new(responses: Vec<MockResponse>) -> Self {
        Self {
            responses: Mutex::new(responses),
        }
    }

    /// Convenience: provider that always returns the same text
    pub fn text(text: impl Into<String>) -> Self {
        Self::new(vec![MockResponse::Text(text.into())])
    }

    /// Convenience: sequence of text responses
    pub fn texts(texts: Vec<impl Into<String>>) -> Self {
        Self::new(
            texts
                .into_iter()
                .map(|t| MockResponse::Text(t.into()))
                .collect(),
        )
    }
}

#[async_trait]
impl StreamProvider for MockProvider {
    async fn stream(
        &self,
        _config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let response = {
            let mut responses = self.responses.lock();
            if responses.is_empty() {
                MockResponse::Text("(no more mock responses)".into())
            } else {
                responses.remove(0)
            }
        };

        if cancel.is_cancelled() {
            return Err(ProviderError::Cancelled);
        }

        let _ = tx.send(StreamEvent::Start);

        let message = match response {
            MockResponse::Text(text) => {
                build_text_response(text, Usage::default(), StopReason::Stop, "mock".into(), &tx)
            }
            MockResponse::TextWithUsage { text, usage } => {
                build_text_response(text, usage, StopReason::Stop, "mock".into(), &tx)
            }
            MockResponse::TextWithUsageAndStop {
                text,
                usage,
                stop_reason,
            } => build_text_response(text, usage, stop_reason, "mock".into(), &tx),
            MockResponse::TextWithUsageStopAndModel {
                text,
                usage,
                stop_reason,
                model,
            } => build_text_response(text, usage, stop_reason, model, &tx),
            MockResponse::ToolCalls(calls) => {
                build_tool_call_response(calls, StopReason::ToolUse, Usage::default(), &tx)
            }
            MockResponse::ToolCallsWithStop { calls, stop_reason } => {
                build_tool_call_response(calls, stop_reason, Usage::default(), &tx)
            }
            MockResponse::ToolCallsWithUsage { calls, usage } => {
                build_tool_call_response(calls, StopReason::ToolUse, usage, &tx)
            }
        };

        let _ = tx.send(StreamEvent::Done {
            message: message.clone(),
        });
        Ok(StreamOutcome::complete(message))
    }
}

fn build_tool_call_response(
    calls: Vec<MockToolCall>,
    stop_reason: StopReason,
    usage: Usage,
    tx: &mpsc::UnboundedSender<StreamEvent>,
) -> Message {
    let content = calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let id = format!("mock-tool-{index}");
            let _ = tx.send(StreamEvent::ToolCallStart {
                content_index: index,
                id: id.clone(),
                name: call.name.clone(),
            });
            let _ = tx.send(StreamEvent::ToolCallEnd {
                content_index: index,
                id: id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            });
            Content::ToolCall {
                id,
                name: call.name.clone(),
                arguments: call.arguments.clone(),
                metadata: None,
            }
        })
        .collect();

    Message::Assistant {
        content,
        stop_reason,
        model: "mock".into(),
        provider: "mock".into(),
        usage,
        timestamp: now_ms(),
        error_message: None,
        response_id: None,
    }
}

fn build_text_response(
    text: String,
    usage: Usage,
    stop_reason: StopReason,
    model: String,
    tx: &mpsc::UnboundedSender<StreamEvent>,
) -> Message {
    let _ = tx.send(StreamEvent::TextDelta {
        content_index: 0,
        delta: text.clone(),
    });
    Message::Assistant {
        content: vec![Content::Text { text }],
        stop_reason,
        model,
        provider: "local".into(),
        usage,
        timestamp: now_ms(),
        error_message: None,
        response_id: None,
    }
}
