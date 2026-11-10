//! Replay downgrade for provider-native compaction items.

use crate::types::Content;
use crate::types::Message;
use crate::types::ThinkingMetadata;

/// Replace provider-native compaction items with their readable fallback text.
/// Used for one retry when an upstream rejects replay (for example after an
/// account/model boundary). Ordinary Responses reasoning items are preserved.
pub fn downgrade_replay_messages(messages: &[Message]) -> (Vec<Message>, bool) {
    let mut found = false;
    let downgraded = messages
        .iter()
        .cloned()
        .map(|message| match message {
            Message::Assistant {
                content,
                stop_reason,
                model,
                provider,
                usage,
                timestamp,
                error_message,
                response_id,
            } => {
                let content = content
                    .into_iter()
                    .map(|block| match block {
                        Content::Thinking {
                            thinking,
                            metadata: Some(ThinkingMetadata::OpenAiResponses { item }),
                        } if matches!(
                            item.get("type").and_then(|value| value.as_str()),
                            Some("compaction" | "compaction_summary")
                        ) =>
                        {
                            found = true;
                            Content::Text { text: thinking }
                        }
                        other => other,
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
            other => other,
        })
        .collect();
    (downgraded, found)
}
