//! SSE event builders for OpenAI streaming format.

pub fn combined_text_and_tool_chunk(text: &str, id: &str, name: &str) -> String {
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "content": text,
                    "tool_calls": [{
                        "index": 0,
                        "id": id,
                        "type": "function",
                        "function": {"name": name}
                    }]
                },
                "finish_reason": null
            }]
        })
    )
}

/// A text content delta chunk.
pub fn text_chunk(text: &str, finish_reason: Option<&str>) -> String {
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {"content": text},
                "finish_reason": finish_reason
            }]
        })
    )
}

/// A text chunk that also reports the upstream served model.
pub fn text_chunk_with_model(text: &str, model: &str, finish_reason: Option<&str>) -> String {
    format!(
        "data: {}",
        serde_json::json!({
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"content": text},
                "finish_reason": finish_reason
            }]
        })
    )
}

pub fn reasoning_chunk(
    reasoning_content: Option<&str>,
    reasoning: Option<&str>,
    reasoning_text: Option<&str>,
) -> String {
    let mut delta = serde_json::Map::new();
    if let Some(value) = reasoning_content {
        delta.insert("reasoning_content".into(), serde_json::json!(value));
    }
    if let Some(value) = reasoning {
        delta.insert("reasoning".into(), serde_json::json!(value));
    }
    if let Some(value) = reasoning_text {
        delta.insert("reasoning_text".into(), serde_json::json!(value));
    }
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": null
            }]
        })
    )
}

/// A delta carrying OpenRouter-style `reasoning_details` entries, optionally
/// alongside plain `reasoning_content` text.
pub fn reasoning_details_chunk(
    reasoning_content: Option<&str>,
    details: Vec<serde_json::Value>,
) -> String {
    let mut delta = serde_json::Map::new();
    if let Some(value) = reasoning_content {
        delta.insert("reasoning_content".into(), serde_json::json!(value));
    }
    delta.insert(
        "reasoning_details".into(),
        serde_json::Value::Array(details),
    );
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": null
            }]
        })
    )
}

pub fn tool_call_chunk(
    index: u32,
    id: Option<&str>,
    name: Option<&str>,
    arguments: Option<&str>,
) -> String {
    let mut tool_call = serde_json::Map::new();
    tool_call.insert("index".into(), serde_json::json!(index));
    if let Some(id) = id {
        tool_call.insert("id".into(), serde_json::json!(id));
    }
    if name.is_some() || arguments.is_some() {
        let mut function = serde_json::Map::new();
        if let Some(name) = name {
            function.insert("name".into(), serde_json::json!(name));
        }
        if let Some(arguments) = arguments {
            function.insert("arguments".into(), serde_json::json!(arguments));
        }
        tool_call.insert("function".into(), serde_json::Value::Object(function));
    }
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": [tool_call]},
                "finish_reason": null
            }]
        })
    )
}

/// A tool call start chunk.
pub fn tool_call_start(index: u32, id: &str, name: &str) -> String {
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": index,
                        "id": id,
                        "function": {"name": name}
                    }]
                },
                "finish_reason": null
            }]
        })
    )
}

/// A tool call argument delta chunk.
pub fn tool_call_args(index: u32, args: &str) -> String {
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": index,
                        "function": {"arguments": args}
                    }]
                },
                "finish_reason": null
            }]
        })
    )
}

/// A finish chunk with usage.
pub fn finish_with_usage(
    finish_reason: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> String {
    finish_with_cache_usage(finish_reason, prompt_tokens, completion_tokens, 0, 0)
}

/// A finish chunk with detailed cache usage.
pub fn finish_with_cache_usage(
    finish_reason: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
    cached_tokens: u64,
    cache_write_tokens: u64,
) -> String {
    format!(
        "data: {}",
        serde_json::json!({
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": finish_reason
            }],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
                "prompt_tokens_details": {
                    "cached_tokens": cached_tokens,
                    "cache_write_tokens": cache_write_tokens
                }
            }
        })
    )
}

/// [DONE] marker.
pub fn done() -> String {
    "data: [DONE]".into()
}

/// Join events into an SSE body.
pub fn body(events: Vec<String>) -> String {
    events.join("\n\n") + "\n\n"
}
