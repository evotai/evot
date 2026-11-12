//! Provider-aware normalization of prior assistant content before an LLM call.

use crate::provider::ApiProtocol;
use crate::types::Content;
use crate::types::Message;

/// Preserve replayable thinking only for the exact provider/model/protocol that
/// produced it, and drop thinking from any other model (pi's
/// `transformMessages`, pi#10995). Sent as plain text, another model's
/// reasoning reads as part of the visible reply: the new model starts writing
/// its reasoning into the answer, and Anthropic refuses histories carrying
/// Gemini thought-summarizer output as `reasoning_extraction`. Unsigned thinking
/// is omitted even for the same model: turning it into text loses its provenance
/// and lets it survive a later model switch. Visible text and tool calls are kept.
pub fn transform_messages_for_model(
    messages: Vec<Message>,
    target_provider: &str,
    target_model: &str,
    target_api: ApiProtocol,
) -> Vec<Message> {
    // Run after any caller-supplied conversion too: it can remove results or
    // reintroduce incomplete assistant turns after the session was normalized.
    super::sanitize::sanitize_tool_pairs(
        messages
            .into_iter()
            .map(crate::types::AgentMessage::Llm)
            .collect(),
    )
    .into_iter()
    .filter_map(|message| match message {
        crate::types::AgentMessage::Llm(message) => Some(message),
        crate::types::AgentMessage::Extension(_) => None,
    })
    .map(|message| transform_message(message, target_provider, target_model, target_api))
    .collect()
}

fn transform_message(
    message: Message,
    target_provider: &str,
    target_model: &str,
    target_api: ApiProtocol,
) -> Message {
    let Message::Assistant {
        content,
        stop_reason,
        model,
        provider,
        usage,
        timestamp,
        error_message,
        response_id,
    } = message
    else {
        return message;
    };

    let same_model = provider == target_provider && model == target_model;
    let content = content
        .into_iter()
        .filter_map(|block| match block {
            Content::Thinking { .. } if !same_model => None,
            // Same model and API: keep the block with its metadata even when
            // the visible text is empty, because an opaque replay payload
            // (encrypted reasoning) is what the provider needs back.
            Content::Thinking {
                thinking,
                metadata: Some(metadata),
            } if metadata.supports_api(target_api) => (!thinking.trim().is_empty()
                || metadata.has_replay_payload())
            .then_some(Content::Thinking {
                thinking,
                metadata: Some(metadata),
            }),
            // Same names on another protocol is another model too.
            Content::Thinking {
                metadata: Some(_), ..
            } => None,
            // No replay metadata: omit the thought, never teach the model to
            // reproduce its reasoning as visible text on the next turn.
            Content::Thinking { .. } => None,
            Content::ToolCall {
                id,
                name,
                arguments,
                metadata,
            } => Some(Content::ToolCall {
                id,
                name,
                arguments,
                metadata: metadata.filter(|value| same_model && value.supports_api(target_api)),
            }),
            other => Some(other),
        })
        .collect();

    Message::Assistant {
        content,
        stop_reason,
        model,
        provider,
        usage,
        timestamp,
        error_message,
        response_id,
    }
}
