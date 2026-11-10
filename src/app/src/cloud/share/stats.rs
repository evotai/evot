//! Explicit presentation of persisted stats. Never serialize raw stats payloads.
use serde_json::json;
use serde_json::Value;

pub fn tool_status(data: &Value) -> Option<Value> {
    let name = data.get("tool_name")?.as_str()?;
    let duration = data.get("duration_ms")?.as_u64()?;
    let failed = data
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // pi's built-in tool renderer has no duration field. Keep this compact
    // status separate without duplicating arguments, output, errors or usage.
    Some(
        json!({"type":"custom_message", "customType":"evot.tool", "display":true,
        "content":format!("{} {name} · {duration}ms", if failed { "✗" } else { "✓" })}),
    )
}

pub fn compaction_fallback(data: &Value) -> Option<Value> {
    let result = data.get("result")?;
    if result.get("type")?.as_str()? != "compacted" {
        return None;
    }
    Some(
        json!({"type":"compaction", "tokensBefore":result.get("before_tokens")?.as_u64()?,
        "summary":compaction_text(result, data.get("reason").and_then(Value::as_str).unwrap_or("threshold"))}),
    )
}

pub fn compaction_text(result: &Value, reason: &str) -> String {
    let method = match result.get("method").and_then(Value::as_str) {
        Some("remote") => "remote",
        Some("remote_failed_local") => "remote failed → local",
        _ => "local",
    };
    let mut text = format!("{method} · {reason}");
    for (before, after, unit) in [
        ("before_tokens", "after_tokens", "tokens"),
        ("before_message_count", "after_message_count", "messages"),
    ] {
        if let (Some(before), Some(after)) = (
            result.get(before).and_then(Value::as_u64),
            result.get(after).and_then(Value::as_u64),
        ) {
            text.push_str(&format!(" · {before} → {after} {unit}"));
        }
    }
    if let Some(bytes) = result.get("remote_blob_bytes").and_then(Value::as_u64) {
        text.push_str(&format!(" · blob {bytes} B"));
    }
    if let Some(reason) = result
        .get("fallback_reason")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        text.push_str(&format!("\nFallback: {reason}"));
    }
    text
}
