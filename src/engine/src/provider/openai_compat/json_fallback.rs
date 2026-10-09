//! OpenAI-compatible JSON fallback handling.
//!
//! When the upstream returns `application/json` instead of `text/event-stream`,
//! this module classifies the response as either an error or a complete
//! OpenAI Chat Completions response and converts it accordingly.

use tokio::sync::mpsc;
use tracing::debug;

use super::reasoning_details;
use super::types::*;
use crate::provider::error::ProviderError;
use crate::provider::route::OpenAiCompat;
use crate::provider::stream::fallback::FallbackEmitter;
use crate::provider::stream::http;
use crate::provider::traits::StreamConfig;
use crate::provider::traits::StreamEvent;
use crate::types::*;

/// Handle a JSON response from an OpenAI-compatible endpoint.
///
/// - Error-shaped JSON → [`ProviderError`]
/// - Success-shaped JSON → emits [`StreamEvent`]s and returns [`Message`]
pub(crate) async fn handle_json_response(
    response: reqwest::Response,
    tx: mpsc::UnboundedSender<StreamEvent>,
    config: &StreamConfig,
    compat: &OpenAiCompat,
) -> Result<Message, ProviderError> {
    let value = http::read_json_body(response).await?;

    // Check for error-shaped JSON first
    if value.get("error").is_some() {
        debug!("OpenAI-compat JSON fallback: error response detected");
        return Err(http::classify_json_error(&value));
    }

    debug!("OpenAI-compat JSON fallback: parsing as success completion");
    parse_success_response(value, tx, config, compat)
}

/// Parse a successful OpenAI Chat Completions JSON response into stream events.
fn parse_success_response(
    value: serde_json::Value,
    tx: mpsc::UnboundedSender<StreamEvent>,
    config: &StreamConfig,
    _compat: &OpenAiCompat,
) -> Result<Message, ProviderError> {
    let response: OpenAiResponse = serde_json::from_value(value)
        .map_err(|e| ProviderError::Api(format!("Failed to parse OpenAI response: {e}")))?;

    let mut emitter = FallbackEmitter::new(tx);

    // Process first choice
    if let Some(choice) = response.choices.first() {
        let msg = &choice.message;

        // Reasoning / thinking content
        let reasoning = [
            (
                ReasoningField::ReasoningContent,
                msg.reasoning_content.as_deref(),
            ),
            (ReasoningField::Reasoning, msg.reasoning.as_deref()),
            (ReasoningField::ReasoningText, msg.reasoning_text.as_deref()),
        ]
        .into_iter()
        .find_map(|(field, value)| {
            value
                .filter(|value| !value.is_empty())
                .map(|value| (field, value))
        });
        let details = msg
            .reasoning_details
            .clone()
            .and_then(reasoning_details::sanitize);
        match (reasoning, details) {
            (Some((field, thinking)), details) => {
                emitter.emit_thinking(
                    thinking,
                    Some(ThinkingMetadata::OpenAiCompletions { field, details }),
                );
            }
            // Encrypted-only reasoning: no visible text, but the opaque state
            // still has to be replayed on the next turn.
            (None, Some(details)) => {
                emitter.emit_replay_only_thinking(ThinkingMetadata::OpenAiCompletions {
                    field: ReasoningField::ReasoningContent,
                    details: Some(details),
                });
            }
            (None, None) => {}
        }

        // Text content
        if let Some(text) = &msg.content {
            emitter.emit_text(text);
        }

        // Tool calls
        if let Some(tool_calls) = &msg.tool_calls {
            for tc in tool_calls {
                let arguments =
                    crate::provider::json_repair::try_repair_json(&tc.function.arguments)
                        .unwrap_or(serde_json::Value::Object(Default::default()));
                emitter.emit_tool_call(&tc.id, &tc.function.name, arguments);
            }
        }

        // Stop reason
        let stop_reason = match choice.finish_reason.as_deref() {
            // Same contract as the SSE path: a content-filter stop is a
            // refusal error, never a normal completion.
            Some(reason) if crate::provider::error::is_content_filter_reason(reason) => {
                return Err(ProviderError::Api(crate::provider::error::refusal_message(
                    reason,
                )));
            }
            Some("stop") => StopReason::Stop,
            Some("length") => StopReason::Length,
            Some("tool_calls") => StopReason::ToolUse,
            _ => StopReason::Stop,
        };
        emitter.set_stop_reason(stop_reason);
    }

    // OpenAI includes cached tokens in prompt_tokens.
    if let Some(u) = &response.usage {
        let cache_read = u
            .prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .unwrap_or(u.prompt_cache_hit_tokens);
        let cache_write = u
            .prompt_tokens_details
            .as_ref()
            .map(|d| d.cache_write_tokens)
            .unwrap_or(0);
        let input = u
            .prompt_tokens
            .saturating_sub(cache_read)
            .saturating_sub(cache_write);
        let usage = Usage {
            input,
            output: u.completion_tokens,
            total_tokens: input
                .saturating_add(u.completion_tokens)
                .saturating_add(cache_read)
                .saturating_add(cache_write),
            cache_read,
            cache_write,
            ..Default::default()
        };
        emitter.set_usage(usage);
    }

    let provider = config
        .model_config
        .as_ref()
        .map(|mc| mc.provider().to_string())
        .unwrap_or_else(|| "openai".into());

    Ok(emitter.finalize(&config.model, &provider))
}

/// JSON fallback is one finite response, not an unbounded streaming producer.
pub(crate) async fn handle_json_response_sink(
    response: reqwest::Response,
    tx: crate::provider::stream::sink::StreamSink,
    config: &StreamConfig,
    compat: &OpenAiCompat,
) -> Result<Message, ProviderError> {
    let (legacy_tx, mut rx) = mpsc::unbounded_channel();
    let message = handle_json_response(response, legacy_tx, config, compat).await?;
    while let Some(event) = rx.recv().await {
        tx.send(event).await.map_err(|_| ProviderError::Cancelled)?;
    }
    Ok(message)
}
