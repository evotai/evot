//! OpenRouter-style `reasoning_details` handling for Chat Completions.
//!
//! `reasoning_details` is the structured companion to the plain
//! `reasoning_content` text: a list of entries that a reasoning model needs
//! replayed verbatim on the next turn to continue its internal state across
//! tool calls. Three entry shapes exist:
//!
//! - `reasoning.summary` — `{ "summary": "..." }` human-readable summary
//! - `reasoning.text` — `{ "text": "...", "signature"?: "..." }` raw text
//! - `reasoning.encrypted` — `{ "data": "..." }` opaque encrypted state
//!
//! All carry optional `id`, `format` and `index`. Streaming endpoints send
//! them as deltas: consecutive text/summary entries are fragments of one
//! logical entry and must be merged, while encrypted entries are discrete.
//! The merged list is stored as-is on the thinking block and sent back
//! unchanged, so unknown extra keys survive the round trip.

use serde_json::Value;

const TYPE_SUMMARY: &str = "reasoning.summary";
const TYPE_TEXT: &str = "reasoning.text";
const TYPE_ENCRYPTED: &str = "reasoning.encrypted";

/// Whether `detail` is a well-formed reasoning detail entry.
pub fn is_reasoning_detail(detail: &Value) -> bool {
    let Some(obj) = detail.as_object() else {
        return false;
    };
    let common_ok = obj.get("id").is_none_or(|v| v.is_string() || v.is_null())
        && obj.get("format").is_none_or(|v| v.is_string())
        && obj.get("index").is_none_or(|v| v.is_number());
    if !common_ok {
        return false;
    }
    match obj.get("type").and_then(Value::as_str) {
        Some(TYPE_SUMMARY) => obj.get("summary").is_some_and(Value::is_string),
        Some(TYPE_ENCRYPTED) => obj.get("data").is_some_and(Value::is_string),
        Some(TYPE_TEXT) => {
            obj.get("text").is_some_and(Value::is_string)
                && obj
                    .get("signature")
                    .is_none_or(|v| v.is_string() || v.is_null())
        }
        _ => false,
    }
}

/// Append one streamed detail delta, merging text/summary fragments into the
/// trailing entry of the same type.
pub fn append_reasoning_detail(details: &mut Vec<Value>, detail: Value) {
    if !is_reasoning_detail(&detail) {
        return;
    }
    let detail_type = detail
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let merge_key = match detail_type.as_str() {
        TYPE_TEXT => Some("text"),
        TYPE_SUMMARY => Some("summary"),
        _ => None,
    };
    if let Some(key) = merge_key {
        if let Some(last) = details.last_mut() {
            if last.get("type").and_then(Value::as_str) == Some(detail_type.as_str()) {
                merge_fragment(last, &detail, key);
                return;
            }
        }
    }
    details.push(detail);
}

fn merge_fragment(target: &mut Value, source: &Value, key: &str) {
    let fragment = source.get(key).and_then(Value::as_str).unwrap_or_default();
    let existing = target.get(key).and_then(Value::as_str).unwrap_or_default();
    target[key] = Value::String(format!("{existing}{fragment}"));
    if key == "text" {
        let has_signature = target
            .get("signature")
            .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
        if !has_signature {
            if let Some(sig) = source.get("signature").filter(|v| v.is_string()) {
                target["signature"] = sig.clone();
            }
        }
    }
    for common in ["id", "format", "index"] {
        let missing = target
            .get(common)
            .is_none_or(|v| v.is_null() || v.as_str().is_some_and(str::is_empty));
        if missing {
            if let Some(value) = source.get(common).filter(|v| !v.is_null()) {
                target[common] = value.clone();
            }
        }
    }
}

/// Extract the visible text carried by a detail entry, if any.
pub fn visible_text(detail: &Value) -> Option<&str> {
    match detail.get("type").and_then(Value::as_str) {
        Some(TYPE_SUMMARY) => detail.get("summary").and_then(Value::as_str),
        Some(TYPE_TEXT) => detail.get("text").and_then(Value::as_str),
        _ => None,
    }
}

/// Keep only well-formed entries; `None` when nothing survives.
pub fn sanitize(details: Vec<Value>) -> Option<Vec<Value>> {
    let kept: Vec<Value> = details.into_iter().filter(is_reasoning_detail).collect();
    (!kept.is_empty()).then_some(kept)
}
