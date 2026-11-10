use std::sync::Arc;

use super::ShareNotice;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::session::storage::Storage;
use crate::session::Session;
use crate::types::TranscriptItem;

/// A display event this build cannot represent is dropped, not escalated: one
/// unknown kind from a newer client must not reject the whole share batch.
fn to_item(notice: ShareNotice) -> Option<Result<TranscriptItem>> {
    if notice.schema_version > 1
        || !matches!(notice.level.as_str(), "error" | "system" | "cancelled")
    {
        return None;
    }
    let kind = notice.kind.clone().unwrap_or_else(|| "ui_notice".into());
    if kind == "thinking_level_change" {
        let level = notice
            .data
            .get("thinking_level")
            .and_then(|value| value.as_str())?;
        if crate::conf::thinking_level_from_str(level).is_err() {
            return None;
        }
        return Some(Ok(TranscriptItem::Stats {
            kind,
            data: serde_json::json!({ "thinking_level": level }),
        }));
    }
    if kind == "model_change" {
        let provider = notice
            .data
            .get("provider")
            .and_then(|value| value.as_str())?;
        let model = notice.data.get("model").and_then(|value| value.as_str())?;
        if provider.is_empty() || model.is_empty() {
            return None;
        }
        return Some(Ok(TranscriptItem::Stats {
            kind,
            data: serde_json::json!({ "to_provider": provider, "to_model": model }),
        }));
    }
    if kind != "ui_notice" {
        return None;
    }
    Some(
        serde_json::to_value(notice)
            .map(|data| TranscriptItem::Stats { kind, data })
            .map_err(|error| EvotError::Session(error.to_string())),
    )
}

pub async fn record_notices(
    storage: Arc<dyn Storage>,
    session_id: &str,
    notices: Vec<ShareNotice>,
) -> Result<()> {
    let mut items = Vec::with_capacity(notices.len());
    for item in notices.into_iter().filter_map(to_item) {
        items.push(item?);
    }
    if items.is_empty() {
        return Ok(());
    }
    let session = Session::open(session_id, storage)
        .await?
        .ok_or_else(|| EvotError::Session("session not found".into()))?;
    session.write_items(items).await
}
