//! Shared fallback event emitter and Message builder.
//!
//! When a provider receives a complete JSON response instead of an SSE stream,
//! this module provides a uniform way to emit [`StreamEvent`]s and assemble
//! the final [`Message::Assistant`] — avoiding duplicated logic across providers.

use tokio::sync::mpsc;

use crate::context::now_ms;
use crate::provider::traits::StreamEvent;
use crate::types::*;

/// Builder that accumulates content blocks, emits [`StreamEvent`]s, and
/// finalises into a [`Message::Assistant`].
pub struct FallbackEmitter {
    tx: mpsc::UnboundedSender<StreamEvent>,
    content: Vec<Content>,
    usage: Usage,
    stop_reason: StopReason,
}

impl FallbackEmitter {
    /// Create a new emitter. Sends [`StreamEvent::Start`] immediately.
    pub fn new(tx: mpsc::UnboundedSender<StreamEvent>) -> Self {
        let _ = tx.send(StreamEvent::Start);
        Self {
            tx,
            content: Vec::new(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
        }
    }

    /// Emit a text content block.
    pub fn emit_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let idx = self.content.len();
        self.content.push(Content::Text {
            text: text.to_string(),
        });
        let _ = self.tx.send(StreamEvent::TextDelta {
            content_index: idx,
            delta: text.to_string(),
        });
    }

    /// Emit a thinking content block.
    pub fn emit_thinking(&mut self, thinking: &str, metadata: Option<ThinkingMetadata>) {
        if thinking.is_empty() {
            return;
        }
        let idx = self.content.len();
        self.content.push(Content::Thinking {
            thinking: thinking.to_string(),
            metadata,
        });
        let _ = self.tx.send(StreamEvent::ThinkingDelta {
            content_index: idx,
            delta: thinking.to_string(),
        });
    }

    /// Record a thinking block that has no visible text but carries opaque
    /// provider state (encrypted reasoning) which must be replayed later.
    /// Nothing is streamed to the UI.
    pub fn emit_replay_only_thinking(&mut self, metadata: ThinkingMetadata) {
        if !metadata.has_replay_payload() {
            return;
        }
        self.content.push(Content::Thinking {
            thinking: String::new(),
            metadata: Some(metadata),
        });
    }

    /// Emit a complete tool call content block.
    pub fn emit_tool_call(&mut self, id: &str, name: &str, arguments: serde_json::Value) {
        let idx = self.content.len();
        self.content.push(Content::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: arguments.clone(),
            metadata: None,
        });
        let _ = self.tx.send(StreamEvent::ToolCallStart {
            content_index: idx,
            id: id.to_string(),
            name: name.to_string(),
        });
        let _ = self.tx.send(StreamEvent::ToolCallEnd {
            content_index: idx,
            id: id.to_string(),
            name: name.to_string(),
            arguments,
        });
    }

    /// Set the token usage for this response.
    pub fn set_usage(&mut self, usage: Usage) {
        self.usage = usage;
    }

    /// Set the stop reason for this response.
    pub fn set_stop_reason(&mut self, reason: StopReason) {
        self.stop_reason = reason;
    }

    /// Finalise: assemble the [`Message::Assistant`], emit [`StreamEvent::Done`],
    /// and return the message.
    pub fn finalize(self, model: &str, provider: &str) -> Message {
        let message = Message::Assistant {
            content: self.content,
            stop_reason: self.stop_reason,
            model: model.to_string(),
            provider: provider.to_string(),
            usage: self.usage,
            timestamp: now_ms(),
            error_message: None,
            response_id: None,
        };
        let _ = self.tx.send(StreamEvent::Done {
            message: message.clone(),
        });
        message
    }
}
