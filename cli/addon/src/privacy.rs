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

/// `/privacy untaint PATH`: stop judging that file (against `cwd`) as
/// holding a secret for the rest of this process. `true` when it was marked.
#[napi]
pub fn privacy_untaint(path: String, cwd: String) -> bool {
    evot::privacy::untaint(&path, std::path::Path::new(&cwd))
}
