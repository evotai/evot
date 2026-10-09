//! Provider-aware normalization of prior assistant content before an LLM call.

use crate::provider::ApiProtocol;
use crate::types::Content;
use crate::types::Message;

/// Preserve replayable thinking only for the exact provider/model/protocol that
/// produced it. Foreign or unsigned thinking remains useful context, but is
/// downgraded to ordinary text so provider-specific opaque state is never sent
/// to the wrong API.
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
            // Same model and API: keep the block with its metadata even when
            // the visible text is empty, because an opaque replay payload
            // (encrypted reasoning) is what the provider needs back.
            Content::Thinking { thinking, metadata }
                if same_model
                    && metadata
                        .as_ref()
                        .is_some_and(|value| value.supports_api(target_api))
                    && (!thinking.trim().is_empty()
                        || metadata
                            .as_ref()
                            .is_some_and(|value| value.has_replay_payload())) =>
            {
                Some(Content::Thinking { thinking, metadata })
            }
            Content::Thinking { thinking, .. } if thinking.trim().is_empty() => None,
            Content::Thinking { thinking, .. } => Some(Content::Text { text: thinking }),
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
