use crate::provider::system_prompt::without_dynamic_boundary;
use crate::provider::traits::StreamConfig;
use crate::types::*;

pub fn build_request_body(config: &StreamConfig) -> serde_json::Value {
    let supports_image = config
        .model_config
        .as_ref()
        .map(|model| model.supports_image())
        .unwrap_or(false);
    let reasoning = config
        .model_config
        .as_ref()
        .map(|model| model.reasoning())
        .unwrap_or(true);
    let mut input = Vec::new();

    let system_prompt = without_dynamic_boundary(&config.system_prompt);
    if !system_prompt.is_empty() {
        let role = if reasoning
            && config
                .model_config
                .as_ref()
                .and_then(|model| model.compat())
                .is_some_and(|compat| compat.has_cap(crate::provider::CompatCaps::DEVELOPER_ROLE))
        {
            "developer"
        } else {
            "system"
        };
        input.push(serde_json::json!({
            "role": role,
            "content": system_prompt.as_ref(),
        }));
    }

    for (message_index, message) in config.messages.iter().enumerate() {
        match message {
            Message::User { content, .. } => {
                let content = input_content(content, supports_image);
                if !content.is_empty() {
                    input.push(serde_json::json!({"role": "user", "content": content}));
                }
            }
            Message::Assistant { content, .. } => {
                for (block_index, block) in content.iter().enumerate() {
                    match block {
                        Content::Text { text } if !text.is_empty() => input.push(serde_json::json!({
                            "type": "message",
                            "id": format!("msg_evot_{message_index}_{block_index}"),
                            "role": "assistant",
                            "status": "completed",
                            "content": [{"type": "output_text", "text": text, "annotations": []}],
                        })),
                        Content::Thinking {
                            metadata: Some(ThinkingMetadata::OpenAiResponses { item }),
                            ..
                        } => input.push(item.clone()),
                        Content::ToolCall {
                            id,
                            name,
                            arguments,
                            metadata,
                        } => {
                            let mut item = serde_json::json!({
                                "type": "function_call",
                                "call_id": id,
                                "name": name,
                                "arguments": arguments.to_string(),
                            });
                            if let Some(ToolCallMetadata::OpenAiResponses { item_id }) = metadata {
                                item["id"] = serde_json::json!(item_id);
                            }
                            input.push(item);
                        }
                        // Reasoning from other APIs has no Responses replay item;
                        // omitting it is valid and mirrors pi's cross-provider fallback.
                        _ => {}
                    }
                }
            }
            Message::ToolResult {
                tool_call_id,
                content,
                ..
            } => {
                input.push(serde_json::json!({
                    "type": "function_call_output",
                    "call_id": tool_call_id,
                    "output": tool_output(content, supports_image),
                }));
            }
        }
    }

    let mut body = serde_json::json!({
        "model": config.model,
        "input": input,
        "stream": true,
    });
    if config
        .model_config
        .as_ref()
        .and_then(|model| model.compat())
        .is_some_and(|compat| compat.has_cap(crate::provider::CompatCaps::STORE))
    {
        body["store"] = serde_json::json!(false);
    }
    // Codex-style GPT Responses upstreams reject the text-generation budget;
    // they determine the output cap server-side. Other Responses-compatible
    // models retain evot's explicit budget.
    if !is_gpt_or_codex(&config.model) {
        body["max_output_tokens"] = serde_json::json!(config.resolved_max_tokens());
    }

    if !config.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(
            config
                .tools
                .iter()
                .map(|tool| {
                    serde_json::json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                        "strict": false,
                    })
                })
                .collect(),
        );
    }

    if let Some(verbosity) = config
        .model_config
        .as_ref()
        .and_then(|model| model.effective_verbosity())
    {
        body["text"] = serde_json::json!({"verbosity": verbosity});
    }

    if config
        .model_config
        .as_ref()
        .and_then(|model| model.compat())
        .is_some_and(|compat| compat.has_cap(crate::provider::CompatCaps::PROMPT_CACHE_KEY))
    {
        if let Some(key) = &config.prompt_cache_key {
            body["prompt_cache_key"] = serde_json::json!(key);
        }
    }
    apply_reasoning(&mut body, config, reasoning);
    body
}

fn is_gpt_or_codex(model: &str) -> bool {
    model.starts_with("gpt-") || model.starts_with("codex-")
}

fn apply_reasoning(body: &mut serde_json::Value, config: &StreamConfig, enabled: bool) {
    if !enabled {
        return;
    }
    let model = config.model_config.as_ref();
    let level = crate::provider::thinking::effective_thinking_level(config.thinking_level, model);
    let policy = model
        .map(|model| model.thinking_level_policy(level))
        .unwrap_or(crate::provider::model::ThinkingLevelPolicy::ProtocolDefault);
    let effort = match policy {
        crate::provider::model::ThinkingLevelPolicy::WireValue(effort) => Some(effort.to_string()),
        crate::provider::model::ThinkingLevelPolicy::Unsupported => None,
        crate::provider::model::ThinkingLevelPolicy::ProtocolDefault => match level {
            ThinkingLevel::Off => None,
            ThinkingLevel::Minimal => Some("minimal".into()),
            ThinkingLevel::Low => Some("low".into()),
            ThinkingLevel::Medium => Some("medium".into()),
            ThinkingLevel::High => Some("high".into()),
            ThinkingLevel::Xhigh => Some("xhigh".into()),
            ThinkingLevel::Max => Some("max".into()),
        },
    };
    if let Some(effort) = effort {
        if effort == "none" {
            body["reasoning"] = serde_json::json!({"effort": effort});
        } else {
            body["reasoning"] = serde_json::json!({"effort": effort, "summary": "auto"});
            body["include"] = serde_json::json!(["reasoning.encrypted_content"]);
        }
    }
}

fn input_content(content: &[Content], supports_image: bool) -> Vec<serde_json::Value> {
    content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text } if !text.is_empty() => {
                Some(serde_json::json!({"type": "input_text", "text": text}))
            }
            Content::Image { .. } if supports_image => {
                block.resolve_image_data().map(|(data, mime_type)| {
                    serde_json::json!({
                        "type": "input_image",
                        "detail": "auto",
                        "image_url": format!("data:{mime_type};base64,{data}"),
                    })
                })
            }
            Content::Image { .. } => Some(serde_json::json!({
                "type": "input_text",
                "text": "[Image omitted: the current model does not support image input.]",
            })),
            _ => None,
        })
        .collect()
}

fn tool_output(content: &[Content], supports_image: bool) -> serde_json::Value {
    let text = content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let images = content
        .iter()
        .filter_map(|block| match block {
            Content::Image { .. } if supports_image => block.resolve_image_data(),
            _ => None,
        })
        .collect::<Vec<_>>();
    if images.is_empty() {
        return serde_json::json!(if text.trim().is_empty() {
            "(no tool output)"
        } else {
            &text
        });
    }

    let mut output = Vec::new();
    if !text.trim().is_empty() {
        output.push(serde_json::json!({"type": "input_text", "text": text}));
    }
    for (data, mime_type) in images {
        output.push(serde_json::json!({
            "type": "input_image",
            "detail": "auto",
            "image_url": format!("data:{mime_type};base64,{data}"),
        }));
    }
    serde_json::Value::Array(output)
}
