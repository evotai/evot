//! Projection into the pinned pi viewer contract. No terminal formatting or I/O.
use serde_json::json;
use serde_json::Value;

use super::ShareUpload;
use crate::types::AssistantBlock;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::TranscriptImageSource;
use crate::types::TranscriptItem;
use crate::types::TranscriptUserContent;

pub fn export_session(
    meta: &SessionMeta,
    source: &[TranscriptEntry],
    version: &str,
) -> ShareUpload {
    let mut entries = Vec::new();
    let mut parent = Value::Null;
    let mut system_prompt = None;
    let mut tools = None;
    let mut model = None;
    let mut thinking_level = None;
    let mut retry_visible = false;

    // pi records initial settings as entries. Do the same so a session that
    // never changes model/effort still identifies both in the All tree filter.
    if let Some((provider, initial)) = super::settings::initial_model(meta, source) {
        append_entry(
            &mut entries,
            &mut parent,
            "initial-model".into(),
            &meta.created_at,
            model_change(&provider, &initial),
        );
        model = Some((provider, initial));
    }
    if let Some(level) = super::settings::initial_thinking(meta, source) {
        append_entry(
            &mut entries,
            &mut parent,
            "initial-thinking".into(),
            &meta.created_at,
            thinking_change(&level),
        );
        thinking_level = Some(level);
    }

    for (index, row) in source.iter().enumerate() {
        let base_id = format!("e{}", row.seq);
        match &row.item {
            TranscriptItem::Stats { kind, data } => match kind.as_str() {
                "llm_call_started" => {
                    if system_prompt.is_none() {
                        system_prompt = data
                            .get("system_prompt")
                            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                            .cloned();
                    }
                    if tools.is_none() {
                        tools = data
                            .get("tool_definitions")
                            .filter(|value| value.as_array().is_some_and(|rows| !rows.is_empty()))
                            .cloned();
                    }
                    if data.get("attempt").and_then(Value::as_u64).unwrap_or(0) == 0 {
                        retry_visible = false;
                    }
                    let effective = data
                        .get("thinking_level")
                        .and_then(Value::as_str)
                        .filter(|level| !level.is_empty());
                    if let Some(level) =
                        effective.filter(|level| thinking_level.as_deref() != Some(*level))
                    {
                        append_entry(
                            &mut entries,
                            &mut parent,
                            format!("{base_id}-thinking"),
                            &row.created_at,
                            thinking_change(level),
                        );
                        thinking_level = Some(level.to_owned());
                    }
                }
                "model_change" => {
                    let provider = stat_text(data, "to_provider", "provider");
                    let next_model = stat_text(data, "to_model", "model");
                    if let (Some(provider), Some(next_model)) = (provider, next_model) {
                        let next = (provider.to_owned(), next_model.to_owned());
                        if model.as_ref() != Some(&next) {
                            append_entry(
                                &mut entries,
                                &mut parent,
                                base_id,
                                &row.created_at,
                                model_change(provider, next_model),
                            );
                            model = Some(next);
                        }
                    }
                }
                "thinking_level_change" => {
                    if let Some(level) = data
                        .get("thinking_level")
                        .and_then(Value::as_str)
                        .filter(|level| !level.is_empty())
                    {
                        if thinking_level.as_deref() != Some(level) {
                            append_entry(
                                &mut entries,
                                &mut parent,
                                base_id,
                                &row.created_at,
                                thinking_change(level),
                            );
                            thinking_level = Some(level.to_owned());
                        }
                    }
                }
                "llm_call_retry" => {
                    // TUI announces one card for a retry storm; later attempts
                    // only update its spinner. Preserve that same cardinality.
                    if !retry_visible {
                        append_entry(
                            &mut entries,
                            &mut parent,
                            base_id,
                            &row.created_at,
                            retry_notice(data),
                        );
                        retry_visible = true;
                    }
                }
                "llm_call_completed" => {
                    if let Some(error) = data
                        .get("error")
                        .and_then(Value::as_str)
                        .filter(|error| !error.is_empty())
                    {
                        let represented = following_assistant_has_error(source, index, error);
                        if !represented && !retry_visible {
                            append_entry(
                                &mut entries,
                                &mut parent,
                                base_id,
                                &row.created_at,
                                assistant_error(error),
                            );
                        }
                    }
                }
                "run_finished" => {
                    if let Some(run) = run_footer(data) {
                        append_entry(&mut entries, &mut parent, base_id, &row.created_at, run);
                    }
                }
                "ui_notice" => {
                    let label = match data.get("level").and_then(Value::as_str) {
                        Some("error") => "evot.error",
                        Some("cancelled") => "evot.cancelled",
                        _ => "evot.notice",
                    };
                    append_entry(
                        &mut entries,
                        &mut parent,
                        base_id,
                        &row.created_at,
                        notice(
                            label,
                            data.get("text").and_then(Value::as_str).unwrap_or_default(),
                        ),
                    );
                }
                "tool_finished" => {
                    if let Some(status) = super::stats::tool_status(data) {
                        append_entry(&mut entries, &mut parent, base_id, &row.created_at, status);
                    }
                }
                "context_compaction_completed" => {
                    // Old sessions can contain completed stats without a Compact item.
                    let has_compact = source[..index]
                        .iter()
                        .rev()
                        .take_while(|previous| {
                            !matches!(&previous.item, TranscriptItem::Stats { kind, .. }
                            if kind == "context_compaction_completed")
                        })
                        .any(|previous| matches!(&previous.item, TranscriptItem::Compact { .. }));
                    if !has_compact {
                        if let Some(summary) = super::stats::compaction_fallback(data) {
                            append_entry(
                                &mut entries,
                                &mut parent,
                                base_id,
                                &row.created_at,
                                summary,
                            );
                        }
                    }
                }
                "context_pruned" => {
                    if let Some(notice) = super::stats::prune_notice(data) {
                        append_entry(&mut entries, &mut parent, base_id, &row.created_at, notice);
                    }
                }
                // Started/no-op diagnostics belong to the spinner or screen.log.
                "context_compaction_started" => {}
                _ => {}
            },
            item => {
                if let Some(entry) = project_semantic(item) {
                    append_entry(
                        &mut entries,
                        &mut parent,
                        base_id.clone(),
                        &row.created_at,
                        entry,
                    );
                }
                if let TranscriptItem::Assistant {
                    stop_reason,
                    error_message,
                    ..
                } = item
                {
                    if matches!(stop_reason.as_str(), "length" | "max_tokens") {
                        let warning = match error_message.as_deref().and_then(|text| text.strip_prefix("response incomplete:")) {
                        Some(reason) => format!("Provider returned an incomplete response ({}). Context recovery may compact and retry.", reason.trim()),
                        None => "Model stopped because it reached the maximum output token limit. The response may be incomplete.".into(),
                    };
                        append_entry(
                            &mut entries,
                            &mut parent,
                            format!("{base_id}-length"),
                            &row.created_at,
                            notice("evot.warning", &warning),
                        );
                    }
                }
            }
        }
    }

    ShareUpload {
        schema_version: 1,
        evot_version: version.into(),
        session_id: meta.session_id.clone(),
        title: meta.display_title().map(str::to_owned),
        data: json!({
            "header": {"type": "session", "version": 3, "id": meta.session_id,
                "timestamp": meta.created_at, "cwd": project_name(&meta.cwd)},
            "entries": entries, "leafId": parent, "systemPrompt": system_prompt, "tools": tools,
        }),
    }
}

fn append_entry(
    entries: &mut Vec<Value>,
    parent: &mut Value,
    id: String,
    timestamp: &str,
    mut entry: Value,
) {
    entry["id"] = json!(id);
    entry["parentId"] = parent.clone();
    entry["timestamp"] = json!(timestamp);
    *parent = json!(id);
    entries.push(entry);
}

fn stat_text<'a>(data: &'a Value, current: &str, legacy: &str) -> Option<&'a str> {
    data.get(current)
        .or_else(|| data.get(legacy))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn following_assistant_has_error(source: &[TranscriptEntry], index: usize, error: &str) -> bool {
    let boundary = |row: &&TranscriptEntry| {
        !matches!(&row.item, TranscriptItem::User { .. })
            && !matches!(&row.item, TranscriptItem::Stats { kind, .. } if kind == "llm_call_started" || kind == "run_finished")
    };
    // Providers can publish the assistant either before or after accounting.
    source[..index]
        .iter()
        .rev()
        .take_while(boundary)
        .chain(source[index + 1..].iter().take_while(boundary))
        .any(|other| {
            matches!(&other.item,
            TranscriptItem::Assistant { error_message: Some(message), .. } if message == error)
        })
}

fn model_change(provider: &str, model: &str) -> Value {
    json!({"type": "model_change", "provider": provider, "modelId": model})
}

fn thinking_change(level: &str) -> Value {
    json!({"type": "thinking_level_change", "thinkingLevel": level})
}

fn retry_notice(data: &Value) -> Value {
    let attempt = data.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let max = data.get("max_retries").and_then(Value::as_u64).unwrap_or(0);
    let delay_ms = data.get("delay_ms").and_then(Value::as_u64).unwrap_or(0);
    let seconds = delay_ms.div_ceil(1000);
    let timing = if seconds == 1 {
        "1 second".into()
    } else {
        format!("{seconds} seconds")
    };
    let error = data
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default();
    notice(
        "evot.llm_retry",
        &format!("Retrying in {timing} · attempt {attempt}/{max}\n{error}"),
    )
}

fn assistant_error(error: &str) -> Value {
    json!({"type": "message", "message": {"role": "assistant", "content": [],
        "stopReason": "error", "errorMessage": error}})
}

fn run_footer(data: &Value) -> Option<Value> {
    let duration_ms = data.get("duration_ms").and_then(Value::as_u64)?;
    if duration_ms < 1000 {
        return None;
    }
    let turns = data.get("turn_count").and_then(Value::as_u64).unwrap_or(0);
    let suffix = match turns {
        0 => String::new(),
        1 => " · 1 turn".into(),
        count => format!(" · {count} turns"),
    };
    Some(notice(
        "evot.run",
        &format!("✳ Ran for {}{suffix}", format_elapsed(duration_ms)),
    ))
}

fn format_elapsed(ms: u64) -> String {
    let total = ms.saturating_add(500) / 1000;
    if total < 60 {
        return format!("{total}s");
    }
    let minutes = total / 60;
    let seconds = total % 60;
    if minutes < 60 {
        return if seconds == 0 {
            format!("{minutes}m")
        } else {
            format!("{minutes}m {seconds}s")
        };
    }
    let hours = minutes / 60;
    let rest = minutes % 60;
    if rest == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {rest}m")
    }
}

/// The viewer only labels the project, so the absolute path — which carries the
/// user's home directory and account name — never leaves the machine.
fn project_name(cwd: &str) -> &str {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(cwd)
}

fn viewer_tool_name(name: &str) -> String {
    let lower = name.to_lowercase();
    if matches!(lower.as_str(), "bash" | "read" | "write" | "edit" | "ls") {
        lower
    } else {
        name.to_owned()
    }
}

fn notice(kind: &str, text: &str) -> Value {
    json!({"type": "custom_message", "customType": kind, "content": text, "display": true})
}

fn project_semantic(item: &TranscriptItem) -> Option<Value> {
    Some(match item {
        TranscriptItem::User { text, content, .. } => {
            let blocks: Vec<Value> = if content.is_empty() {
                vec![json!({"type": "text", "text": text})]
            } else {
                content.iter().map(|block| match block {
                    TranscriptUserContent::Text { text } => json!({"type": "text", "text": text}),
                    TranscriptUserContent::Image { mime_type, source: TranscriptImageSource::Base64 { data } } =>
                        json!({"type": "image", "mimeType": mime_type, "data": data}),
                    // Never read arbitrary local paths during export.
                    TranscriptUserContent::Image { .. } => json!({"type": "text", "text": "[Local image not embedded in this share]"}),
                }).collect()
            };
            json!({"type": "message", "message": {"role": "user", "content": blocks}})
        }
        TranscriptItem::Assistant {
            content,
            stop_reason,
            usage,
            model,
            provider,
            timestamp,
            error_message,
        } => {
            let blocks: Vec<Value> = content.iter().map(|block| match block {
                AssistantBlock::Text { text } => json!({"type": "text", "text": text}),
                AssistantBlock::Thinking { text, .. } => json!({"type": "thinking", "thinking": text}),
                AssistantBlock::ToolCall { id, name, input, .. } => json!({"type": "toolCall", "id": id, "name": viewer_tool_name(name), "arguments": input}),
            }).collect();
            let stop = match stop_reason.as_str() {
                "tool_use" | "tool_calls" | "toolUse" => "toolUse",
                "max_tokens" | "length" => "length",
                "error" => "error",
                "aborted" | "cancelled" => "aborted",
                _ if error_message.is_some() => "error",
                _ => "stop",
            };
            json!({"type": "message", "message": {"role": "assistant", "content": blocks,
                "model": model, "provider": provider, "timestamp": timestamp,
                "stopReason": stop, "errorMessage": error_message,
                "usage": {"input": usage.input, "output": usage.output,
                    "cacheRead": usage.cache_read, "cacheWrite": usage.cache_write,
                    "totalTokens": usage.input + usage.output + usage.cache_read + usage.cache_write}}})
        }
        TranscriptItem::ToolResult {
            tool_call_id,
            tool_name,
            content,
            is_error,
            details,
        } => {
            json!({"type": "message", "message": {"role": "toolResult", "toolCallId": tool_call_id,
                "toolName": viewer_tool_name(tool_name), "content": [{"type": "text", "text": content}],
                "isError": is_error, "details": details}})
        }
        TranscriptItem::System { text } => notice("evot.system", text),
        TranscriptItem::Compact {
            summary,
            reason,
            tokens_before,
            tokens_after,
            messages_before,
            messages_after,
            details,
            ..
        } => {
            let reason = serde_json::to_value(reason).unwrap_or_default();
            let method = serde_json::to_value(details.method).unwrap_or_default();
            let metadata = super::stats::compaction_text(
                &json!({
                    "method": method, "before_tokens": tokens_before, "after_tokens": tokens_after,
                    "before_message_count": messages_before, "after_message_count": messages_after,
                    "fallback_reason": details.fallback_reason, "remote_blob_bytes": details.remote_blob_bytes,
                }),
                reason.as_str().unwrap_or("threshold"),
            );
            json!({"type": "compaction", "summary": format!("{metadata}\n\n{summary}"), "tokensBefore": tokens_before})
        }
        TranscriptItem::Stats { .. }
        | TranscriptItem::Extension { .. }
        | TranscriptItem::Marker { .. } => return None,
    })
}
