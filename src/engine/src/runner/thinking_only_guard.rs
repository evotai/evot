//! Thinking-only guard: detect when the model produces only thinking tokens
//! without any visible text or tool calls, and nudge it to produce output.

use crate::context::now_ms;
use crate::types::*;

/// Maximum number of thinking-only retries before giving up.
const MAX_RETRIES: usize = 2;

/// Tracks thinking-only responses and injects nudges.
pub struct ThinkingOnlyGuard {
    retries: usize,
}

impl Default for ThinkingOnlyGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl ThinkingOnlyGuard {
    pub fn new() -> Self {
        Self { retries: 0 }
    }

    /// Check if the response is thinking-only (has thinking but no text/tool_use).
    /// Returns a steering message to inject if a retry is warranted.
    pub fn check(&mut self, message: &Message, has_tool_calls: bool) -> Option<AgentMessage> {
        if has_tool_calls {
            self.retries = 0;
            return None;
        }

        if !is_thinking_only(message) {
            self.retries = 0;
            return None;
        }

        if self.retries >= MAX_RETRIES {
            return None;
        }

        self.retries += 1;
        Some(build_nudge())
    }
}

fn is_thinking_only(message: &Message) -> bool {
    match message {
        Message::Assistant { content, .. } => {
            let has_thinking = content
                .iter()
                .any(|c| matches!(c, Content::Thinking { .. }));
            let has_text = content
                .iter()
                .any(|c| matches!(c, Content::Text { text } if !text.trim().is_empty()));
            has_thinking && !has_text
        }
        _ => false,
    }
}

fn build_nudge() -> AgentMessage {
    let text = "<system-reminder>\n\
        Status: Your previous turn produced only internal reasoning with no \
        visible output (no text, no tool calls). This is not useful to the user. \
        Please produce a visible response: either call a tool, ask the user a \
        question, or state your conclusion.\n\
        </system-reminder>"
        .to_string();

    AgentMessage::Llm(Message::User {
        provenance: Some(crate::InputProvenance::runtime(
            1,
            "thinking_only_guard",
            None,
        )),
        content: vec![Content::Text { text }],
        timestamp: now_ms(),
    })
}
