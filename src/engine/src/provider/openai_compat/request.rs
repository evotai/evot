//! OpenAI-compatible request body building and content conversion.

use crate::provider::route::CompatCaps;
use crate::provider::route::MaxTokensField;
use crate::provider::route::OpenAiCompat;
use crate::provider::system_prompt::without_dynamic_boundary;
use crate::provider::traits::StreamConfig;
use crate::types::*;

#[derive(Default)]
pub struct ToolCallBuffer {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub content_index: Option<usize>,
    pub started: bool,
}

pub fn build_request_body(config: &StreamConfig, compat: &OpenAiCompat) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::new();

    // Whether the target model accepts image input. Text-only models get image
    // content replaced with a text placeholder, mirroring pi's
    // `model.input.includes("image")` gate. Absent model config, assume vision
    // is allowed (the request path had no way to know otherwise).
    let supports_image = config
        .model_config
        .as_ref()
        .map(|m| m.supports_image())
        .unwrap_or(true);

    // System prompt
    let system_prompt = without_dynamic_boundary(&config.system_prompt);
    if !system_prompt.is_empty() {
        messages.push(serde_json::json!({
            "role": "system",
            "content": system_prompt.as_ref(),
        }));
    }

    for msg in &config.messages {
        match msg {
            Message::User { content, .. } => {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": content_to_openai(content, supports_image),
                }));
            }
            Message::Assistant { content, .. } => {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                let mut tool_calls: Vec<serde_json::Value> = Vec::new();
                let mut reasoning_content = String::new();
                let mut reasoning = String::new();
                let mut reasoning_text = String::new();
                let mut reasoning_details: Vec<serde_json::Value> = Vec::new();

                for c in content {
                    match c {
                        Content::Text { text } if text.is_empty() => {}
                        Content::Text { text } => {
                            parts.push(serde_json::json!({"type": "text", "text": text}));
                        }
                        Content::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => {
                            tool_calls.push(serde_json::json!({
                                "id": id,
                                "type": "function",
                                "function": {"name": name, "arguments": arguments.to_string()},
                            }));
                        }
                        Content::Thinking { thinking, metadata } => match metadata {
                            Some(ThinkingMetadata::OpenAiCompletions {
                                details: Some(details),
                                ..
                            }) if !details.is_empty() => {
                                // Structured replay data usually carries the
                                // summary/text itself; only fall back to the
                                // plain field when every entry is opaque.
                                let has_visible_text = details.iter().any(|detail| {
                                    super::reasoning_details::visible_text(detail)
                                        .is_some_and(|text| !text.is_empty())
                                });
                                if !has_visible_text {
                                    reasoning_content.push_str(thinking);
                                }
                                reasoning_details.extend(details.iter().cloned());
                            }
                            Some(ThinkingMetadata::OpenAiCompletions {
                                field: ReasoningField::Reasoning,
                                ..
                            }) => reasoning.push_str(thinking),
                            Some(ThinkingMetadata::OpenAiCompletions {
                                field: ReasoningField::ReasoningText,
                                ..
                            }) => reasoning_text.push_str(thinking),
                            _ => reasoning_content.push_str(thinking),
                        },
                        _ => {}
                    }
                }

                // Skip empty assistant messages that have neither content nor tool_calls
                // nor reasoning_content.
                // Some providers (e.g. mimo-v2.5-pro) reject assistant messages without
                // at least one of content, reasoning_content, or tool_calls.
                if parts.is_empty()
                    && tool_calls.is_empty()
                    && reasoning_content.is_empty()
                    && reasoning.is_empty()
                    && reasoning_text.is_empty()
                    && reasoning_details.is_empty()
                {
                    continue;
                }

                let mut msg_obj = serde_json::json!({"role": "assistant"});
                if !parts.is_empty() {
                    msg_obj["content"] = serde_json::json!(parts);
                }
                if !tool_calls.is_empty() {
                    msg_obj["tool_calls"] = serde_json::json!(tool_calls);
                }
                apply_assistant_compat(
                    &mut msg_obj,
                    compat,
                    &reasoning_content,
                    &reasoning,
                    &reasoning_text,
                    reasoning_details,
                );
                messages.push(msg_obj);
            }
            Message::ToolResult {
                tool_call_id,
                tool_name,
                content,
                ..
            } => {
                let has_image = content.iter().any(|c| matches!(c, Content::Image { .. }));
                // Only surface image content to vision-capable models. For
                // text-only models the image is dropped and the tool result
                // text carries a note, so the request never sends an
                // `image_url` block a text-only endpoint would reject.
                let attach_image = has_image && supports_image;
                let text = content
                    .iter()
                    .find_map(|c| match c {
                        Content::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .unwrap_or_else(|| {
                        if attach_image {
                            "Image output is attached in the next user message.".into()
                        } else if has_image {
                            "[Image output omitted: the current model does not support image input.]".into()
                        } else {
                            String::new()
                        }
                    });

                let mut msg_obj = serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": text,
                });
                apply_tool_result_compat(&mut msg_obj, compat, tool_name);
                messages.push(msg_obj);

                if attach_image {
                    let image_content = tool_result_images_as_user_content(tool_name, content);
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": content_to_openai(&image_content, supports_image),
                    }));
                }
            }
        }
    }

    let max_tokens_val = config.resolved_max_tokens();
    let mut body = serde_json::json!({
        "model": config.model,
        "stream": true,
        "messages": messages,
    });

    if compat.has_cap(CompatCaps::USAGE_IN_STREAMING) {
        body["stream_options"] = serde_json::json!({"include_usage": true});
    }

    if compat.has_cap(CompatCaps::PROMPT_CACHE_KEY) {
        if let Some(key) = &config.prompt_cache_key {
            body["prompt_cache_key"] = serde_json::json!(key);
        }
    }

    match compat.max_tokens_field {
        MaxTokensField::MaxCompletionTokens => {
            body["max_completion_tokens"] = serde_json::json!(max_tokens_val);
        }
        MaxTokensField::MaxTokens => {
            body["max_tokens"] = serde_json::json!(max_tokens_val);
        }
    }

    if !config.tools.is_empty() {
        let tools: Vec<serde_json::Value> = config
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();
        body["tools"] = serde_json::json!(tools);
    }

    if let Some(verbosity) = config
        .model_config
        .as_ref()
        .and_then(|model| model.effective_verbosity())
    {
        body["verbosity"] = serde_json::json!(verbosity);
    }

    apply_reasoning_effort(&mut body, config, compat);

    body
}

fn apply_assistant_compat(
    msg_obj: &mut serde_json::Value,
    compat: &OpenAiCompat,
    reasoning_content: &str,
    reasoning: &str,
    reasoning_text: &str,
    reasoning_details: Vec<serde_json::Value>,
) {
    if !reasoning_content.is_empty() || compat.has_cap(CompatCaps::REASONING_CONTENT_REQUIRED) {
        msg_obj["reasoning_content"] = serde_json::json!(reasoning_content);
    }
    if !reasoning_details.is_empty() {
        msg_obj["reasoning_details"] = serde_json::Value::Array(reasoning_details);
    }
    if !reasoning.is_empty() {
        msg_obj["reasoning"] = serde_json::json!(reasoning);
    }
    if !reasoning_text.is_empty() {
        msg_obj["reasoning_text"] = serde_json::json!(reasoning_text);
    }
}

fn apply_tool_result_compat(
    msg_obj: &mut serde_json::Value,
    compat: &OpenAiCompat,
    tool_name: &str,
) {
    if compat.has_cap(CompatCaps::TOOL_RESULT_NAME) {
        msg_obj["name"] = serde_json::json!(tool_name);
    }
}

fn apply_reasoning_effort(
    body: &mut serde_json::Value,
    config: &StreamConfig,
    compat: &OpenAiCompat,
) {
    let model = config.model_config.as_ref();
    if !model.map(|m| m.reasoning()).unwrap_or(true) {
        return;
    }

    let level = crate::provider::thinking::effective_thinking_level(config.thinking_level, model);
    let policy = model
        .map(|model| model.thinking_level_policy(level))
        .unwrap_or(crate::provider::model::ThinkingLevelPolicy::ProtocolDefault);
    let effort = match policy {
        crate::provider::model::ThinkingLevelPolicy::WireValue(effort) => Some(effort.to_string()),
        crate::provider::model::ThinkingLevelPolicy::Unsupported => None,
        crate::provider::model::ThinkingLevelPolicy::ProtocolDefault => match level {
            ThinkingLevel::Minimal => Some("minimal".into()),
            ThinkingLevel::Low => Some("low".into()),
            ThinkingLevel::Medium => Some("medium".into()),
            ThinkingLevel::High => Some("high".into()),
            ThinkingLevel::Xhigh => Some("xhigh".into()),
            ThinkingLevel::Max => Some("max".into()),
            ThinkingLevel::Off => model
                .filter(|model| model.can_disable_thinking())
                .map(|_| "none".into()),
        },
    };

    match compat.thinking_format {
        crate::provider::route::ThinkingFormat::OpenRouter => {
            if let Some(effort) = effort {
                body["reasoning"] = serde_json::json!({ "effort": effort });
            }
        }
        crate::provider::route::ThinkingFormat::DeepSeek => {
            body["thinking"] = if level == ThinkingLevel::Off {
                serde_json::json!({ "type": "disabled" })
            } else {
                serde_json::json!({ "type": "enabled" })
            };
            if level != ThinkingLevel::Off && compat.has_cap(CompatCaps::REASONING_EFFORT) {
                if let Some(effort) = effort {
                    body["reasoning_effort"] = serde_json::json!(effort);
                }
            }
        }
        crate::provider::route::ThinkingFormat::OpenAi
            if compat.has_cap(CompatCaps::REASONING_EFFORT) =>
        {
            // OpenAI-style transports only send an off value when the model map
            // explicitly supplies one. An absent mapping means omit the field.
            if level != ThinkingLevel::Off
                || matches!(
                    policy,
                    crate::provider::model::ThinkingLevelPolicy::WireValue(_)
                )
            {
                if let Some(effort) = effort {
                    body["reasoning_effort"] = serde_json::json!(effort);
                }
            }
        }
        _ => {}
    }
}

fn tool_result_images_as_user_content(tool_name: &str, content: &[Content]) -> Vec<Content> {
    let mut user_content = vec![Content::Text {
        text: format!("Image output from tool `{}`:", tool_name),
    }];
    user_content.extend(content.iter().filter_map(|c| match c {
        Content::Image { .. } => Some(c.clone()),
        _ => None,
    }));
    user_content
}

pub fn content_to_openai(content: &[Content], supports_image: bool) -> serde_json::Value {
    if content.len() == 1 {
        if let Content::Text { text } = &content[0] {
            if !text.is_empty() {
                return serde_json::json!(text);
            }
        }
    }
    let parts: Vec<serde_json::Value> = content
        .iter()
        .filter(|c| !matches!(c, Content::Text { text } if text.is_empty()))
        .filter_map(|c| match c {
            Content::Text { text } => Some(serde_json::json!({"type": "text", "text": text})),
            Content::Image { .. } if !supports_image => Some(serde_json::json!({
                "type": "text",
                "text": "[Image omitted: the current model does not support image input.]",
            })),
            Content::Image { .. } => c.resolve_image_data().map(|(data, mime_type)| {
                serde_json::json!({
                    "type": "image_url",
                    "image_url": {"url": format!("data:{};base64,{}", mime_type, data)},
                })
            }),
            _ => None,
        })
        .collect();
    serde_json::json!(parts)
}
