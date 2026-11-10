//! Historical settings must never be backfilled with the session's final value.
use serde_json::Value;

use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

pub fn initial_model(meta: &SessionMeta, rows: &[TranscriptEntry]) -> Option<(String, String)> {
    for row in rows {
        match &row.item {
            TranscriptItem::Stats { kind, data } if kind == "model_change" => {
                return Some((
                    text(data, "from_provider")?.into(),
                    text(data, "from_model")?.into(),
                ));
            }
            TranscriptItem::Assistant {
                provider, model, ..
            } if !provider.is_empty() && !model.is_empty() => {
                return Some((provider.clone(), model.clone()));
            }
            _ => {}
        }
    }
    if meta.provider.is_empty() || meta.model.is_empty() {
        return None;
    }
    Some((meta.provider.clone(), meta.model.clone()))
}

pub fn initial_thinking(meta: &SessionMeta, rows: &[TranscriptEntry]) -> Option<String> {
    for row in rows {
        if let TranscriptItem::Stats { kind, data } = &row.item {
            match kind.as_str() {
                // No evidence of the level preceding an interactive switch.
                "thinking_level_change" => return None,
                "llm_call_started" => {
                    if let Some(level) = text(data, "thinking_level") {
                        return Some(level.into());
                    }
                }
                _ => {}
            }
        }
    }
    // Legacy-only snapshot: this is the recorded level, not a reconstructed history.
    meta.thinking_level
        .clone()
        .filter(|level| !level.is_empty())
}

fn text<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}
