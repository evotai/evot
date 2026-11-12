//! Anthropic JSON fallback handling.
//!
//! When the upstream returns `application/json` instead of `text/event-stream`,
//! this module classifies the response as either an error or a complete
//! Anthropic Messages API response and converts it accordingly.

use tokio::sync::mpsc;
use tracing::debug;

use crate::provider::error::ProviderError;
use crate::provider::stream::fallback::FallbackEmitter;
use crate::provider::stream::http;
use crate::provider::traits::StreamConfig;
use crate::provider::traits::StreamEvent;
use crate::types::*;

/// Handle a JSON response from the Anthropic Messages API.
///
/// - Error-shaped JSON → [`ProviderError`]
/// - Success-shaped JSON → emits [`StreamEvent`]s and returns [`Message`]
pub(crate) async fn handle_json_response(
    response: reqwest::Response,
    tx: mpsc::UnboundedSender<StreamEvent>,
    config: &StreamConfig,
) -> Result<Message, ProviderError> {
    let value = http::read_json_body(response).await?;

    // Check for error-shaped JSON first
    if is_error_response(&value) {
        debug!("Anthropic JSON fallback: error response detected");
        return Err(http::classify_json_error(&value));
    }

    debug!("Anthropic JSON fallback: parsing as success completion");
    parse_success_response(value, tx, config)
}

fn json_has_effective_content(value: &serde_json::Value) -> bool {
    value
        .get("content")
        .and_then(|content| content.as_array())
        .is_some_and(|blocks| {
            blocks.iter().any(
                |block| match block.get("type").and_then(|kind| kind.as_str()) {
                    Some("text") => block
                        .get("text")
                        .and_then(|text| text.as_str())
                        .is_some_and(|text| !text.trim().is_empty()),
                    Some("thinking") => block
                        .get("thinking")
                        .and_then(|thinking| thinking.as_str())
                        .is_some_and(|thinking| !thinking.trim().is_empty()),
                    Some("tool_use") => true,
                    _ => false,
                },
            )
        })
}

/// Check if the JSON body looks like an Anthropic error response.
///
/// Anthropic errors have the shape:
/// ```json
/// { "type": "error", "error": { "type": "...", "message": "..." } }
/// ```
fn is_error_response(value: &serde_json::Value) -> bool {
    // Explicit error type
    if value.get("type").and_then(|t| t.as_str()) == Some("error") {
        return true;
    }
    // Has an error object
    if value.get("error").is_some() {
        return true;
    }
    false
}

/// Parse a successful Anthropic Messages API JSON response into stream events.
fn parse_success_response(
    value: serde_json::Value,
    tx: mpsc::UnboundedSender<StreamEvent>,
    config: &StreamConfig,
) -> Result<Message, ProviderError> {
    let stop_reason = match value.get("stop_reason").and_then(|reason| reason.as_str()) {
        Some("end_turn" | "pause_turn" | "stop_sequence") | None => StopReason::Stop,
        Some("tool_use") => StopReason::ToolUse,
        Some("max_tokens") => StopReason::Length,
        Some(reason @ ("refusal" | "sensitive")) => {
            return Err(ProviderError::Api(
                crate::provider::error::refusal_message_with_category(
                    reason,
                    value
                        .pointer("/stop_details/category")
                        .and_then(|value| value.as_str()),
                ),
            ));
        }
        Some(reason) => {
            return Err(ProviderError::Api(format!(
                "Unhandled Anthropic stop reason: {reason}"
            )));
        }
    };
    if !json_has_effective_content(&value) {
        return Err(ProviderError::Api(
            "Empty response from provider (no content)".into(),
        ));
    }
    let mut emitter = FallbackEmitter::new(tx);

    // Parse content blocks
    if let Some(blocks) = value.get("content").and_then(|c| c.as_array()) {
        for block in blocks {
            let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        emitter.emit_text(text);
                    }
                }
                "thinking" => {
                    let thinking = block.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    let signature = block
                        .get("signature")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    emitter.emit_thinking(
                        thinking,
                        signature.map(|signature| ThinkingMetadata::Anthropic { signature }),
                    );
                }
                "tool_use" => {
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arguments = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                    emitter.emit_tool_call(&id, &name, arguments);
                }
                _ => {
                    debug!("Anthropic JSON fallback: unknown content block type: {block_type}");
                }
            }
        }
    }

    // Parse usage
    if let Some(u) = value.get("usage") {
        let mut usage = Usage::default();
        if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
            usage.input = v;
        }
        if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
            usage.output = v;
        }
        if let Some(v) = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
            usage.cache_read = v;
        }
        if let Some(v) = u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
        {
            usage.cache_write = v;
        }
        if let Some(v) = u
            .get("output_tokens_details")
            .and_then(|details| details.get("thinking_tokens"))
            .and_then(|v| v.as_u64())
        {
            usage.reasoning_output = v;
        }
        usage.refresh_total_tokens();
        emitter.set_usage(usage);
    }

    emitter.set_stop_reason(stop_reason);

    let provider = config
        .model_config
        .as_ref()
        .map(|model| model.provider())
        .unwrap_or("anthropic");
    Ok(emitter.finalize(&config.model, provider))
}

/// JSON fallback is one finite response, not an unbounded streaming producer.
pub(crate) async fn handle_json_response_sink(
    response: reqwest::Response,
    tx: crate::provider::stream::sink::StreamSink,
    config: &StreamConfig,
) -> Result<Message, ProviderError> {
    let (legacy_tx, mut rx) = mpsc::unbounded_channel();
    let message = handle_json_response(response, legacy_tx, config).await?;
    while let Some(event) = rx.recv().await {
        tx.send(event).await.map_err(|_| ProviderError::Cancelled)?;
    }
    Ok(message)
}
