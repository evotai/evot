//! Rewrite legacy transcript formats into the current JSONL representation.
//!
//! REMOVE-BY: v0.4.0. This compatibility path was introduced in v0.1.0.
//! Before removal, publish a release note asking users with older transcripts
//! to open them once with evot <= v0.3. The removal includes this file, both
//! `migrate_if_needed` call sites in `storage.rs`, and the legacy fixtures in
//! `tests/storage_test.rs`.

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;

use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::types::CompactDetails;
use crate::types::CompactReason;
use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;
use crate::types::UsageSummary;

#[derive(Deserialize)]
struct StoredEntry {
    session_id: String,
    #[serde(default)]
    run_id: Option<String>,
    seq: u64,
    turn: u32,
    item: serde_json::Value,
    created_at: String,
}

/// Rewrite an old or mixed transcript once, preserving the original as a backup.
/// Current transcripts return unchanged and never enter the compatibility decoder.
pub(super) fn migrate_if_needed(path: &Path, content: Vec<u8>) -> Result<Vec<u8>> {
    if !needs_migration(&content) {
        return Ok(content);
    }

    let decoded = decode_legacy_transcript(&content);
    if decoded.is_empty() && content.iter().any(|byte| !byte.is_ascii_whitespace()) {
        return Err(EvotError::Store(format!(
            "cannot migrate unsupported transcript: {}",
            path.display()
        )));
    }

    let session_id = decoded
        .first()
        .map(|entry| entry.session_id.clone())
        .unwrap_or_default();
    let turn = decoded.iter().map(|entry| entry.turn).max().unwrap_or(0);
    let context = crate::session::conversation::context_view::resolve_context_items(&decoded);
    let entries = context
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            TranscriptEntry::new(
                session_id.clone(),
                None,
                index.saturating_add(1) as u64,
                turn,
                item,
            )
        })
        .collect::<Vec<_>>();
    let migrated = if entries.is_empty() {
        Vec::new()
    } else {
        let mut bytes = serde_json::to_vec(&entries)?;
        bytes.push(b'\n');
        bytes
    };

    write_migration(path, &content, &migrated)?;
    tracing::info!(
        path = %path.display(),
        entries = entries.len(),
        "migrated legacy transcript"
    );
    Ok(migrated)
}

fn needs_migration(content: &[u8]) -> bool {
    let mut expected_seq = 0_u64;
    for line in content.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(entries) = serde_json::from_slice::<Vec<TranscriptEntry>>(line) else {
            return true;
        };
        for entry in entries {
            expected_seq = expected_seq.saturating_add(1);
            if entry.seq != expected_seq {
                return true;
            }
        }
    }
    false
}

fn write_migration(path: &Path, original: &[u8], migrated: &[u8]) -> Result<()> {
    let backup = appended_path(path, ".v1.bak");
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&backup)
    {
        Ok(mut file) => {
            file.write_all(original)?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(EvotError::Io(error)),
    }

    let temporary = appended_path(path, ".migrate.tmp");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(migrated)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, path)?;
    Ok(())
}

fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn decode_legacy_transcript(content: &[u8]) -> Vec<TranscriptEntry> {
    let mut entries: Vec<TranscriptEntry> = Vec::new();

    for line in content.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        let is_batch = matches!(value, serde_json::Value::Array(_));
        let values = match value {
            serde_json::Value::Array(values) => values,
            value @ serde_json::Value::Object(_) => vec![value],
            _ => continue,
        };

        let initial_len = entries.len();
        let seq_offset = reset_batch_offset(is_batch, &values, &entries);
        let mut valid = true;
        for value in values {
            match decode_entry(value, &entries) {
                Ok(mut entry) => {
                    entry.seq = entry.seq.saturating_add(seq_offset);
                    entries.push(entry);
                }
                Err(()) => {
                    valid = false;
                    break;
                }
            }
        }
        if !valid {
            entries.truncate(initial_len);
        }
    }

    entries
}

fn reset_batch_offset(
    is_batch: bool,
    values: &[serde_json::Value],
    entries: &[TranscriptEntry],
) -> u64 {
    if !is_batch {
        return 0;
    }
    let Some(first_seq) = values
        .first()
        .and_then(|value| value.get("seq"))
        .and_then(serde_json::Value::as_u64)
    else {
        return 0;
    };
    let Some(max_seq) = entries.iter().map(|entry| entry.seq).max() else {
        return 0;
    };
    if first_seq > max_seq {
        return 0;
    }
    max_seq.saturating_add(1).saturating_sub(first_seq)
}

fn decode_entry(
    value: serde_json::Value,
    previous: &[TranscriptEntry],
) -> std::result::Result<TranscriptEntry, ()> {
    let stored: StoredEntry = serde_json::from_value(value).map_err(|_| ())?;
    let item = decode_item(stored.item, stored.seq, previous)?;
    Ok(TranscriptEntry {
        session_id: stored.session_id,
        run_id: stored.run_id,
        seq: stored.seq,
        turn: stored.turn,
        item,
        created_at: stored.created_at,
    })
}

fn decode_item(
    mut value: serde_json::Value,
    seq: u64,
    previous: &[TranscriptEntry],
) -> std::result::Result<TranscriptItem, ()> {
    normalize_nested_items(&mut value)?;
    let item_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or(())?;

    if item_type == "compact" && value.get("first_kept_seq").is_some() {
        return decode_legacy_compact(&value, seq, previous);
    }
    if item_type == "compact" && value.get("engine_messages").is_none() {
        return decode_legacy_snapshot(&value, seq);
    }

    serde_json::from_value(value).map_err(|_| ())
}

fn normalize_nested_items(value: &mut serde_json::Value) -> std::result::Result<(), ()> {
    let object = value.as_object_mut().ok_or(())?;
    match object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or(())?
    {
        "assistant" => normalize_legacy_assistant(object),
        "user" => normalize_legacy_user(object),
        "compact" | "marker" => {
            if let Some(messages) = object
                .get_mut("messages")
                .and_then(serde_json::Value::as_array_mut)
            {
                for message in messages {
                    normalize_nested_items(message)?;
                }
            }
            if object.get("type").and_then(serde_json::Value::as_str) == Some("marker") {
                let kind = object.get("kind").and_then(serde_json::Value::as_str);
                if matches!(kind, Some("compact" | "goto")) {
                    object.insert("kind".to_string(), serde_json::json!("clear"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_legacy_assistant(object: &mut serde_json::Map<String, serde_json::Value>) {
    if object.contains_key("content") || object.contains_key("content_blocks") {
        return;
    }

    let mut content = Vec::new();
    if let Some(thinking) = object.get("thinking").and_then(serde_json::Value::as_str) {
        if !thinking.is_empty() {
            content.push(serde_json::json!({ "type": "thinking", "text": thinking }));
        }
    }
    if let Some(text) = object.get("text").and_then(serde_json::Value::as_str) {
        if !text.is_empty() {
            content.push(serde_json::json!({ "type": "text", "text": text }));
        }
    }
    if let Some(tool_calls) = object
        .get("tool_calls")
        .and_then(serde_json::Value::as_array)
    {
        for call in tool_calls {
            content.push(serde_json::json!({
                "type": "tool_call",
                "id": call.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "name": call.get("name").cloned().unwrap_or(serde_json::Value::Null),
                "input": call.get("input").cloned().unwrap_or_else(|| serde_json::json!({})),
            }));
        }
    }
    object.insert("content".to_string(), serde_json::Value::Array(content));
}

fn normalize_legacy_user(object: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(content) = object
        .get_mut("content")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for block in content {
        let Some(block) = block.as_object_mut() else {
            continue;
        };
        if block.get("type").and_then(serde_json::Value::as_str) != Some("image")
            || block.contains_key("source")
        {
            continue;
        }
        if let Some(data) = block.get("data").cloned() {
            block.insert(
                "source".to_string(),
                serde_json::json!({ "type": "base64", "data": data }),
            );
        }
    }
}

fn decode_legacy_compact(
    value: &serde_json::Value,
    seq: u64,
    previous: &[TranscriptEntry],
) -> std::result::Result<TranscriptItem, ()> {
    let summary = string_field(value, "summary");
    let first_kept_seq = value
        .get("first_kept_seq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(seq);
    let mut messages =
        vec![crate::session::conversation::context_view::compact_summary_item(&summary)];
    messages.extend(
        previous
            .iter()
            .filter(|entry| entry.seq >= first_kept_seq && entry.seq < seq)
            .filter(|entry| entry.item.is_context_item())
            .map(|entry| clear_assistant_usage(entry.item.clone())),
    );
    let state = evot_engine::CompactionState {
        generation: 1,
        last_summary: Some(summary.clone()),
        context_summary_message: Some(
            crate::session::conversation::context_view::compact_summary_text(&summary),
        ),
        ..Default::default()
    };
    let engine_messages = crate::session::conversation::convert::into_agent_messages(&messages);

    Ok(TranscriptItem::Compact {
        id: value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("legacy-{seq}")),
        created_at: usize_field(value, "created_at") as u64,
        reason: reason_field(value),
        summary,
        tokens_before: usize_field(value, "tokens_before"),
        tokens_after: usize_field(value, "tokens_after"),
        messages_before: usize_field(value, "messages_before"),
        messages_after: usize_field(value, "messages_after"),
        messages,
        engine_messages,
        state: Box::new(state),
        details: details_field(value),
    })
}

fn decode_legacy_snapshot(
    value: &serde_json::Value,
    seq: u64,
) -> std::result::Result<TranscriptItem, ()> {
    let messages: Vec<TranscriptItem> = value
        .get("messages")
        .cloned()
        .ok_or(())
        .and_then(|messages| serde_json::from_value(messages).map_err(|_| ()))?;
    let engine_messages = crate::session::conversation::convert::into_agent_messages(&messages);
    Ok(TranscriptItem::Compact {
        id: format!("legacy-{seq}"),
        created_at: 0,
        reason: CompactReason::Threshold,
        summary: String::new(),
        tokens_before: 0,
        tokens_after: 0,
        messages_before: 0,
        messages_after: messages.len(),
        messages,
        engine_messages,
        state: Box::default(),
        details: CompactDetails::default(),
    })
}

fn clear_assistant_usage(item: TranscriptItem) -> TranscriptItem {
    match item {
        TranscriptItem::Assistant {
            content,
            stop_reason,
            model,
            provider,
            timestamp,
            error_message,
            ..
        } => TranscriptItem::Assistant {
            content,
            stop_reason,
            usage: UsageSummary::default(),
            model,
            provider,
            timestamp,
            error_message,
        },
        other => other,
    }
}

fn string_field(value: &serde_json::Value, field: &str) -> String {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn usize_field(value: &serde_json::Value, field: &str) -> usize {
    value
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
        .unwrap_or(0)
}

fn reason_field(value: &serde_json::Value) -> CompactReason {
    value
        .get("reason")
        .cloned()
        .and_then(|reason| serde_json::from_value(reason).ok())
        .unwrap_or(CompactReason::Threshold)
}

fn details_field(value: &serde_json::Value) -> CompactDetails {
    value
        .get("details")
        .cloned()
        .and_then(|details| serde_json::from_value(details).ok())
        .unwrap_or_default()
}
