//! Make path-backed message images portable before publishing.
//!
//! Only typed transcript and engine message content is rewritten, including
//! compacted context. Tool arguments, details and extension data are opaque.
//! An unreadable image (e.g. a deleted temp file) is replaced by a text block
//! naming the file, so the share never publishes a dangling local path.

use base64::Engine;
use serde_json::Value;

use crate::error::EvotError;
use crate::error::Result;
use crate::types::TranscriptEntry;

pub(super) fn portable_entries(entries: &[TranscriptEntry]) -> Result<Vec<TranscriptEntry>> {
    entries.iter().map(portable_entry).collect()
}

pub(super) fn has_path_images(entry: &TranscriptEntry) -> Result<bool> {
    let value = serde_json::to_value(entry)?;
    Ok(value.get("item").is_some_and(item_has_path_images))
}

fn is_path_image(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("image")
        && block
            .get("source")
            .and_then(|source| source.get("type"))
            .and_then(Value::as_str)
            == Some("path")
}

fn content_has_path_images(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| blocks.iter().any(is_path_image))
}

fn item_has_path_images(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str) {
        Some("user") => content_has_path_images(item),
        Some("compact") => {
            item.get("messages")
                .and_then(Value::as_array)
                .is_some_and(|messages| messages.iter().any(item_has_path_images))
                || item
                    .get("engine_messages")
                    .and_then(Value::as_array)
                    .is_some_and(|messages| messages.iter().any(engine_message_has_path_images))
        }
        Some("marker") => item
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| messages.iter().any(item_has_path_images)),
        _ => false,
    }
}

fn engine_message_has_path_images(message: &Value) -> bool {
    matches!(
        message.get("role").and_then(Value::as_str),
        Some("user" | "assistant" | "toolResult")
    ) && content_has_path_images(message)
}

fn portable_entry(entry: &TranscriptEntry) -> Result<TranscriptEntry> {
    let mut value = serde_json::to_value(entry)?;
    let changed = match value.get_mut("item") {
        Some(item) => embed_item_images(item)?,
        None => false,
    };
    if changed {
        Ok(serde_json::from_value(value)?)
    } else {
        Ok(entry.clone())
    }
}

fn embed_item_images(item: &mut Value) -> Result<bool> {
    match item.get("type").and_then(Value::as_str) {
        Some("user") => embed_content_images(item),
        Some("compact") => {
            let mut changed = embed_nested_items(item, "messages")?;
            if let Some(messages) = item
                .get_mut("engine_messages")
                .and_then(Value::as_array_mut)
            {
                for message in messages {
                    if matches!(
                        message.get("role").and_then(Value::as_str),
                        Some("user" | "assistant" | "toolResult")
                    ) {
                        changed |= embed_content_images(message)?;
                    }
                }
            }
            Ok(changed)
        }
        Some("marker") => embed_nested_items(item, "messages"),
        _ => Ok(false),
    }
}

fn embed_nested_items(item: &mut Value, field: &str) -> Result<bool> {
    let mut changed = false;
    if let Some(items) = item.get_mut(field).and_then(Value::as_array_mut) {
        for nested in items {
            changed |= embed_item_images(nested)?;
        }
    }
    Ok(changed)
}

fn embed_content_images(message: &mut Value) -> Result<bool> {
    let mut changed = false;
    if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
        for block in blocks {
            if !is_path_image(block) {
                continue;
            }
            let Some(source) = block.get_mut("source").and_then(Value::as_object_mut) else {
                continue;
            };
            let path = source
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| EvotError::Conf("image source has no file path".into()))?
                .to_owned();
            match std::fs::read(&path) {
                Ok(bytes) => {
                    source.insert("type".into(), Value::String("base64".into()));
                    source.remove("path");
                    source.insert(
                        "data".into(),
                        Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
                    );
                }
                Err(_) => *block = unavailable_image_placeholder(&path),
            }
            changed = true;
        }
    }
    Ok(changed)
}

/// Text block shown in place of an image whose file no longer exists.
/// Only the file name is kept so local directory layout is not published.
fn unavailable_image_placeholder(path: &str) -> Value {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    serde_json::json!({
        "type": "text",
        "text": format!("[image unavailable: {name}]"),
    })
}
