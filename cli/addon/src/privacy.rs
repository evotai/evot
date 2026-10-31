use napi::Result as NapiResult;
use napi_derive::napi;

fn failure(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// Settings, the kinds and packs in force, and the last `days` days of
/// records, for `/privacy`.
#[napi]
pub async fn privacy_status(days: u32) -> NapiResult<String> {
    let settings = evot::privacy::settings().await.map_err(failure)?;
    let summary = evot::privacy::summary(days).await.map_err(failure)?;
    let (kinds, packs) = evot::privacy::rules_status().await.map_err(failure)?;
    serde_json::to_string(&serde_json::json!({
        "settings": settings,
        "summary": summary,
        "kinds": kinds,
        "packs": packs,
    }))
    .map_err(failure)
}

/// Validate and save settings; returns them as saved.
#[napi]
pub async fn privacy_save(settings_json: String) -> NapiResult<String> {
    let settings = evot::privacy::PrivacySettings::parse(&settings_json).map_err(failure)?;
    let saved = evot::privacy::save_settings(settings)
        .await
        .map_err(failure)?;
    serde_json::to_string(&saved).map_err(failure)
}

/// Records this process made after `after` (a `cursor` from an earlier
/// call; 0 for all kept), oldest first, as `{ cursor, notices }`. In-memory
/// only: the TUI asks after each step to show masking as it happens.
#[napi]
pub fn privacy_live(after: u32) -> NapiResult<String> {
    let (cursor, notices) = evot::privacy::live_notices(u64::from(after));
    serde_json::to_string(&serde_json::json!({ "cursor": cursor, "notices": notices }))
        .map_err(failure)
}

/// Placeholder tags already recorded for `session` (last `days` days), so a
/// resumed session's first request does not report its history as new.
#[napi]
pub async fn privacy_session_tags(session: String, days: u32) -> NapiResult<String> {
    let tags = evot::privacy::session_tags(session, days)
        .await
        .map_err(failure)?;
    serde_json::to_string(&tags).map_err(failure)
}
