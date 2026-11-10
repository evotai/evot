use std::collections::HashMap;

use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::provider::error::classify_stream_error;
use crate::provider::error::ProviderError;
use crate::provider::json_repair::try_repair_json;
use crate::provider::stream::http::SseEvent;
use crate::provider::stream::sink::StreamSink;
use crate::provider::stream::sse::SseReader;
use crate::provider::traits::*;
use crate::time::now_ms;
use crate::types::*;

#[derive(Debug)]
enum OutputSlot {
    Thinking {
        content_index: usize,
    },
    Text {
        content_index: usize,
    },
    Tool {
        content_index: usize,
        item_id: String,
        call_id: String,
        name: String,
        arguments: String,
        started: bool,
    },
}

pub(crate) async fn decode_sse_stream(
    response: reqwest::Response,
    tx: StreamSink,
    cancel: CancellationToken,
    config: &StreamConfig,
) -> Result<StreamOutcome, ProviderError> {
    let mut reader = SseReader::new(response);

    let mut content = Vec::new();
    let mut slots = HashMap::<usize, OutputSlot>::new();
    let mut usage = Usage::default();
    let mut response_id = None;
    let mut response_model = None;
    let mut stop_reason = StopReason::Stop;
    let mut incomplete_reason = None;
    let mut saw_terminal = false;
    let _ = tx.send(StreamEvent::Start).await;

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
            event = reader.next(&cancel) => match event.map_err(ProviderError::Network)? {
                None => break,
                Some(event) if event.data == "[DONE]" => break,
                Some(event) => process_event(
                    &event,
                    &tx,
                    &mut content,
                    &mut slots,
                    &mut usage,
                    &mut response_id,
                    &mut response_model,
                    &mut stop_reason,
                    &mut incomplete_reason,
                    &mut saw_terminal,
                ).await?,
            }
        }
    }

    if !saw_terminal {
        return Err(ProviderError::ProtocolIncomplete(
            "OpenAI Responses stream ended before a terminal response event".into(),
        ));
    }

    // Output stopped by the content filter is a safety refusal, not a length
    // truncation: surface it as an error so refusal recovery can compact.
    let refused = incomplete_reason
        .as_deref()
        .is_some_and(crate::provider::error::is_content_filter_reason);
    if refused {
        stop_reason = StopReason::Error;
    }
    if stop_reason == StopReason::Stop
        && content
            .iter()
            .any(|block| matches!(block, Content::ToolCall { .. }))
    {
        stop_reason = StopReason::ToolUse;
    }
    if !refused && content.is_empty() && usage.context_tokens() == 0 {
        return Err(ProviderError::Api(
            "Empty response from provider (OpenAI Responses: no content, no usage)".into(),
        ));
    }
    let message = Message::Assistant {
        content,
        stop_reason,
        model: config.model.clone(),
        provider: config
            .model_config
            .as_ref()
            .map(|model| model.provider().to_string())
            .unwrap_or_else(|| "openai".into()),
        usage,
        timestamp: now_ms(),
        error_message: incomplete_reason
            .as_deref()
            .map(crate::provider::error::incomplete_message),
        response_id,
    };
    let _ = tx
        .send(StreamEvent::Done {
            message: message.clone(),
        })
        .await;
    Ok(StreamOutcome::complete(message).served_by(response_model))
}

#[allow(clippy::too_many_arguments)]
async fn process_event(
    sse: &SseEvent,
    tx: &StreamSink,
    content: &mut Vec<Content>,
    slots: &mut HashMap<usize, OutputSlot>,
    usage: &mut Usage,
    response_id: &mut Option<String>,
    response_model: &mut Option<String>,
    stop_reason: &mut StopReason,
    incomplete_reason: &mut Option<String>,
    saw_terminal: &mut bool,
) -> Result<(), ProviderError> {
    let value: serde_json::Value = serde_json::from_str(&sse.data)
        .map_err(|error| ProviderError::Api(format!("Invalid OpenAI Responses event: {error}")))?;
    let event_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(sse.event.as_str());

    if event_type == "error" || event_type == "response.failed" {
        let message = value
            .pointer("/error/message")
            .or_else(|| value.pointer("/response/error/message"))
            .or_else(|| value.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&sse.data);
        return Err(classify_stream_error(message, Some(&value)));
    }
    if event_type == "response.cancelled" {
        return Err(ProviderError::Api("OpenAI response was cancelled".into()));
    }

    if let Some(response) = value.get("response") {
        capture_response_metadata(response, response_id, response_model);
    }

    match event_type {
        "response.output_item.added" => {
            let output_index = usize_field(&value, "output_index")?;
            if let Some(item) = value.get("item") {
                create_slot(output_index, item, tx, content, slots).await;
            }
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            let output_index = usize_field(&value, "output_index")?;
            let delta = string_field(&value, "delta");
            let content_index = ensure_thinking_slot(output_index, content, slots).await;
            if let Some(Content::Thinking { thinking, .. }) = content.get_mut(content_index) {
                thinking.push_str(delta);
            }
            if !delta.is_empty() {
                let _ = tx
                    .send(StreamEvent::ThinkingDelta {
                        content_index,
                        delta: delta.to_string(),
                    })
                    .await;
            }
        }
        "response.reasoning_summary_part.done" => {
            let output_index = usize_field(&value, "output_index")?;
            let content_index = ensure_thinking_slot(output_index, content, slots).await;
            if let Some(Content::Thinking { thinking, .. }) = content.get_mut(content_index) {
                if !thinking.is_empty() {
                    thinking.push_str("\n\n");
                    let _ = tx
                        .send(StreamEvent::ThinkingDelta {
                            content_index,
                            delta: "\n\n".into(),
                        })
                        .await;
                }
            }
        }
        "response.output_text.delta" | "response.refusal.delta" => {
            let output_index = usize_field(&value, "output_index")?;
            let delta = string_field(&value, "delta");
            let content_index = ensure_text_slot(output_index, content, slots).await;
            if let Some(Content::Text { text }) = content.get_mut(content_index) {
                text.push_str(delta);
            }
            if !delta.is_empty() {
                let _ = tx
                    .send(StreamEvent::TextDelta {
                        content_index,
                        delta: delta.to_string(),
                    })
                    .await;
            }
        }
        "response.function_call_arguments.delta" => {
            let output_index = usize_field(&value, "output_index")?;
            let delta = string_field(&value, "delta");
            if let Some(OutputSlot::Tool {
                content_index,
                item_id: _,
                call_id,
                name,
                arguments,
                started,
            }) = slots.get_mut(&output_index)
            {
                // A delta that opens a new object after the buffer already
                // closed one means several function calls' arguments are
                // landing in the same slot (upstream reused `output_index`).
                // The merged buffer will fail to parse; log it so the source
                // of the corruption is attributable from logs.
                if arguments.trim_end().ends_with('}') && delta.trim_start().starts_with('{') {
                    tracing::warn!(
                        output_index,
                        call_id = %call_id,
                        tool = %name,
                        buffered_len = arguments.len(),
                        "function_call_arguments delta opens a new object after a closed one; \
                         multiple tool calls appear to share one output_index"
                    );
                }
                arguments.push_str(delta);
                if !*started && (!call_id.is_empty() || !name.is_empty()) {
                    *started = true;
                    let _ = tx
                        .send(StreamEvent::ToolCallStart {
                            content_index: *content_index,
                            id: call_id.clone(),
                            name: name.clone(),
                        })
                        .await;
                }
                if *started && !delta.is_empty() {
                    let _ = tx
                        .send(StreamEvent::ToolCallDelta {
                            content_index: *content_index,
                            id: call_id.clone(),
                            name: name.clone(),
                            delta: delta.to_string(),
                        })
                        .await;
                }
            }
        }
        "response.function_call_arguments.done" => {
            let output_index = usize_field(&value, "output_index")?;
            if let Some(OutputSlot::Tool { arguments, .. }) = slots.get_mut(&output_index) {
                arguments.clear();
                arguments.push_str(string_field(&value, "arguments"));
            }
        }
        "response.output_item.done" => {
            let output_index = usize_field(&value, "output_index")?;
            if let Some(item) = value.get("item") {
                if !slots.contains_key(&output_index) {
                    create_slot(output_index, item, tx, content, slots).await;
                }
                finish_slot(output_index, item, tx, content, slots).await;
            }
        }
        "response.completed" => {
            if let Some(response) = value.get("response") {
                update_usage(response, usage);
                backfill_reasoning_metadata(response, content);
            }
            *saw_terminal = true;
        }
        "response.incomplete" => {
            if let Some(response) = value.get("response") {
                update_usage(response, usage);
                backfill_reasoning_metadata(response, content);
                *incomplete_reason = response
                    .pointer("/incomplete_details/reason")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
            }
            *stop_reason = StopReason::Length;
            *saw_terminal = true;
        }
        _ => debug!("Ignoring OpenAI Responses event type={event_type}"),
    }
    Ok(())
}

async fn create_slot(
    output_index: usize,
    item: &serde_json::Value,
    tx: &StreamSink,
    content: &mut Vec<Content>,
    slots: &mut HashMap<usize, OutputSlot>,
) {
    if slots.contains_key(&output_index) {
        return;
    }
    let content_index = content.len();
    match string_field(item, "type") {
        "reasoning" => {
            content.push(Content::Thinking {
                thinking: String::new(),
                metadata: Some(ThinkingMetadata::OpenAiResponses { item: item.clone() }),
            });
            slots.insert(output_index, OutputSlot::Thinking { content_index });
        }
        "message" => {
            content.push(Content::Text {
                text: String::new(),
            });
            slots.insert(output_index, OutputSlot::Text { content_index });
        }
        "function_call" => {
            let item_id = string_field(item, "id").to_string();
            let call_id = string_field(item, "call_id").to_string();
            let name = string_field(item, "name").to_string();
            let arguments = string_field(item, "arguments").to_string();
            content.push(Content::ToolCall {
                id: call_id.clone(),
                name: name.clone(),
                arguments: serde_json::Value::Object(Default::default()),
                metadata: openai_tool_metadata(&item_id),
            });
            let started = !call_id.is_empty() || !name.is_empty();
            if started {
                let _ = tx
                    .send(StreamEvent::ToolCallStart {
                        content_index,
                        id: call_id.clone(),
                        name: name.clone(),
                    })
                    .await;
            }
            slots.insert(output_index, OutputSlot::Tool {
                content_index,
                item_id,
                call_id,
                name,
                arguments,
                started,
            });
        }
        _ => {}
    }
}

async fn ensure_thinking_slot(
    output_index: usize,
    content: &mut Vec<Content>,
    slots: &mut HashMap<usize, OutputSlot>,
) -> usize {
    if let Some(OutputSlot::Thinking { content_index }) = slots.get(&output_index) {
        return *content_index;
    }
    let content_index = content.len();
    content.push(Content::Thinking {
        thinking: String::new(),
        metadata: None,
    });
    slots.insert(output_index, OutputSlot::Thinking { content_index });
    content_index
}

async fn ensure_text_slot(
    output_index: usize,
    content: &mut Vec<Content>,
    slots: &mut HashMap<usize, OutputSlot>,
) -> usize {
    if let Some(OutputSlot::Text { content_index }) = slots.get(&output_index) {
        return *content_index;
    }
    let content_index = content.len();
    content.push(Content::Text {
        text: String::new(),
    });
    slots.insert(output_index, OutputSlot::Text { content_index });
    content_index
}

async fn finish_slot(
    output_index: usize,
    item: &serde_json::Value,
    tx: &StreamSink,
    content: &mut [Content],
    slots: &mut HashMap<usize, OutputSlot>,
) {
    let Some(slot) = slots.get_mut(&output_index) else {
        return;
    };
    match slot {
        OutputSlot::Thinking { content_index } => {
            if let Some(Content::Thinking { thinking, metadata }) = content.get_mut(*content_index)
            {
                let summary = item
                    .get("summary")
                    .and_then(serde_json::Value::as_array)
                    .map(|parts| text_parts(parts, "text"))
                    .unwrap_or_default();
                let reasoning = item
                    .get("content")
                    .and_then(serde_json::Value::as_array)
                    .map(|parts| text_parts(parts, "text"))
                    .unwrap_or_default();
                if !summary.is_empty() {
                    *thinking = summary;
                } else if !reasoning.is_empty() {
                    *thinking = reasoning;
                }
                *metadata = Some(ThinkingMetadata::OpenAiResponses { item: item.clone() });
            }
        }
        OutputSlot::Text { content_index } => {
            if let Some(parts) = item.get("content").and_then(serde_json::Value::as_array) {
                let text = parts
                    .iter()
                    .filter_map(|part| {
                        part.get("text")
                            .or_else(|| part.get("refusal"))
                            .and_then(serde_json::Value::as_str)
                    })
                    .collect::<String>();
                if let Some(Content::Text { text: current }) = content.get_mut(*content_index) {
                    if !text.is_empty() {
                        *current = text;
                    }
                }
            }
        }
        OutputSlot::Tool {
            content_index,
            item_id,
            call_id,
            name,
            arguments,
            started,
        } => {
            assign_if_present(item, "id", item_id);
            assign_if_present(item, "call_id", call_id);
            assign_if_present(item, "name", name);
            if let Some(final_arguments) = item.get("arguments").and_then(serde_json::Value::as_str)
            {
                arguments.clear();
                arguments.push_str(final_arguments);
            }
            let id = call_id.clone();
            if !*started {
                let _ = tx
                    .send(StreamEvent::ToolCallStart {
                        content_index: *content_index,
                        id: id.clone(),
                        name: name.clone(),
                    })
                    .await;
            }
            let parsed = try_repair_json(arguments).unwrap_or_else(|err| {
                tracing::warn!(
                    call_id = %id,
                    tool = %name,
                    raw_len = arguments.len(),
                    error = %err,
                    "tool-call arguments unparseable; substituting empty object so \
                     schema validation reports the missing fields"
                );
                serde_json::Value::Object(Default::default())
            });
            if let Some(Content::ToolCall {
                id: current_id,
                name: current_name,
                arguments: current_arguments,
                metadata,
            }) = content.get_mut(*content_index)
            {
                current_id.clone_from(&id);
                current_name.clone_from(name);
                current_arguments.clone_from(&parsed);
                *metadata = openai_tool_metadata(item_id);
            }
            let _ = tx
                .send(StreamEvent::ToolCallEnd {
                    content_index: *content_index,
                    id,
                    name: name.clone(),
                    arguments: parsed,
                })
                .await;
        }
    }
}

fn update_usage(response: &serde_json::Value, usage: &mut Usage) {
    let Some(value) = response.get("usage") else {
        return;
    };
    let input_total = u64_field(value, "input_tokens");
    let cache_read = value
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let cache_write = value
        .pointer("/input_tokens_details/cache_write_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    usage.input = input_total
        .saturating_sub(cache_read)
        .saturating_sub(cache_write);
    usage.cache_read = cache_read;
    usage.cache_write = cache_write;
    usage.output = u64_field(value, "output_tokens");
    usage.reasoning_output = value
        .pointer("/output_tokens_details/reasoning_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    usage.total_tokens = value
        .get("total_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| usage.component_total_tokens());
}

fn backfill_reasoning_metadata(response: &serde_json::Value, content: &mut [Content]) {
    let Some(output) = response.get("output").and_then(serde_json::Value::as_array) else {
        return;
    };
    for final_item in output {
        if string_field(final_item, "type") != "reasoning"
            || final_item.get("encrypted_content").is_none()
        {
            continue;
        }
        let final_id = string_field(final_item, "id");
        for block in content.iter_mut() {
            let Content::Thinking {
                metadata: Some(ThinkingMetadata::OpenAiResponses { item }),
                ..
            } = block
            else {
                continue;
            };
            if string_field(item, "id") == final_id && item.get("encrypted_content").is_none() {
                item["encrypted_content"] = final_item["encrypted_content"].clone();
            }
        }
    }
}

fn text_parts(parts: &[serde_json::Value], field: &str) -> String {
    parts
        .iter()
        .filter_map(|part| part.get(field).and_then(serde_json::Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn capture_response_metadata(
    response: &serde_json::Value,
    response_id: &mut Option<String>,
    response_model: &mut Option<String>,
) {
    if response_id.is_none() {
        *response_id = response
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
    }
    if response_model.is_none() {
        *response_model = response
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
    }
}

fn openai_tool_metadata(item_id: &str) -> Option<ToolCallMetadata> {
    if item_id.is_empty() {
        None
    } else {
        Some(ToolCallMetadata::OpenAiResponses {
            item_id: item_id.to_string(),
        })
    }
}

fn assign_if_present(value: &serde_json::Value, field: &str, target: &mut String) {
    if let Some(next) = value.get(field).and_then(serde_json::Value::as_str) {
        target.clear();
        target.push_str(next);
    }
}

fn usize_field(value: &serde_json::Value, field: &str) -> Result<usize, ProviderError> {
    value
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
        .ok_or_else(|| ProviderError::Api(format!("OpenAI Responses event missing {field}")))
}

fn u64_field(value: &serde_json::Value, field: &str) -> u64 {
    value
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn string_field<'a>(value: &'a serde_json::Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}
