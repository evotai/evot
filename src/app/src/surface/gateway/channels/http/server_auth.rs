//! Cloud login endpoints.

use axum::response::IntoResponse;
use axum::Json;

use super::server::device_fingerprint;
use super::server::PendingLogin;
use super::server::Server;
use crate::base::error::Result;
use crate::conf::Config;

impl Server {
    /// Who the sidebar shows; `logged_in: false` renders the login row.
    pub(super) fn auth_session(&self) -> impl IntoResponse {
        match crate::auth::load_auth() {
            Ok(Some(state)) => Json(serde_json::json!({
                "logged_in": true,
                "name": state.user.name,
                "email": state.user.email,
            }))
            .into_response(),
            Ok(None) => Json(serde_json::json!({ "logged_in": false })).into_response(),
            Err(e) => {
                tracing::warn!("auth session read failed: {e}");
                Json(serde_json::json!({ "logged_in": false })).into_response()
            }
        }
    }

    /// Start a device login; the poll endpoint settles it in place.
    pub(super) async fn login_start(&self) -> impl IntoResponse {
        let fingerprint = device_fingerprint();
        let base_url = crate::auth::client::DEFAULT_SERVER_URL;
        match crate::auth::begin_login(base_url, &fingerprint).await {
            Ok(code) => {
                *self.login.lock() = Some(PendingLogin {
                    base_url: base_url.to_string(),
                    code: code.code.clone(),
                    expires_at: code.expires_at,
                });
                Json(serde_json::json!({
                    "login_url": code.login_url,
                    "code": code.code,
                    "interval_ms": code.interval_ms,
                }))
                .into_response()
            }
            Err(e) => (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Settle the pending login: persist auth, sync the catalog, hot-reload.
    pub(super) async fn login_poll(&self) -> impl IntoResponse {
        let pending = self.login.lock().clone();
        let Some(pending) = pending else {
            return Json(serde_json::json!({ "status": "idle" })).into_response();
        };
        match crate::auth::poll_status(&pending.base_url, &pending.code, pending.expires_at).await {
            Ok(crate::auth::PollOutcome::Pending) => {
                Json(serde_json::json!({ "status": "pending" })).into_response()
            }
            Ok(crate::auth::PollOutcome::Expired) => {
                *self.login.lock() = None;
                Json(serde_json::json!({ "status": "expired" })).into_response()
            }
            Ok(crate::auth::PollOutcome::Denied {
                reason,
                reason_code,
            }) => {
                *self.login.lock() = None;
                Json(serde_json::json!({
                    "status": "denied",
                    "reason": reason,
                    "reason_code": reason_code,
                }))
                .into_response()
            }
            Ok(crate::auth::PollOutcome::Success { user }) => {
                *self.login.lock() = None;
                let sync = async {
                    crate::auth::save_auth(&user)?;
                    let response = crate::auth::sync_models(&user).await?;
                    // The cache file is what config loading reads to register
                    // the cloud providers; skipping it makes login a no-op.
                    crate::auth::save_models_cache(&crate::auth::ModelsCache::new(
                        chrono::Utc::now().timestamp_millis(),
                        response,
                    ))?;
                    Ok::<(), crate::base::error::EvotError>(())
                };
                // Strictly ordered: the reload reads the cache file that the
                // sync just wrote, so these can never run concurrently.
                let sync = sync.await;
                let reload = self.reload_after_auth_change();
                match (sync, reload) {
                    (Ok(()), Ok(_)) => {
                        let providers = self
                            .config
                            .read()
                            .providers
                            .iter()
                            .filter(|(name, _)| self.config.read().cloud_providers.contains(*name))
                            .count();
                        Json(serde_json::json!({
                            "status": "success",
                            "name": user.user.name,
                            "email": user.user.email,
                            "providers": providers,
                        }))
                        .into_response()
                    }
                    (Ok(()), Err(e)) => Json(serde_json::json!({
                        "status": "success",
                        "name": user.user.name,
                        "email": user.user.email,
                        "reload_error": e.to_string(),
                    }))
                    .into_response(),
                    (Err(e), _) => (
                        axum::http::StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
                    )
                        .into_response(),
                }
            }
            Err(e) => (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Sign out: clear auth + catalog, drop cloud providers in place.
    pub(super) async fn auth_logout(&self) -> impl IntoResponse {
        match (crate::auth::logout(), self.reload_after_auth_change()) {
            (Ok(()), Ok(_)) => Json(serde_json::json!({ "ok": true })).into_response(),
            (Err(e), _) | (_, Err(e)) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Server-pushed notices (banner + ads), highest priority first.
    pub(super) fn notices(&self) -> impl IntoResponse {
        let items = match crate::auth::load_models_cache() {
            Ok(Some(cache)) => cache
                .response
                .notices
                .into_iter()
                .take(3)
                .map(|n| serde_json::json!({ "kind": n.kind, "title": n.title, "body": n.body_md }))
                .collect(),
            _ => Vec::new(),
        };
        Json(serde_json::json!({ "items": items })).into_response()
    }

    /// Swap in a fresh config after auth.json changed, then re-resolve the live
    /// model selection through the shared reload rule (`Agent::reload_selection`).
    fn reload_after_auth_change(&self) -> Result<()> {
        let env_path = self.config.read().env_file_path.clone();
        // A never-saved env file is not an error: fall back to the default
        // path, which creates its own baseline.
        let fresh = if env_path.exists() {
            Config::load_with_env_file(env_path.to_str())?
        } else {
            Config::load_with_env_file(None)?
        };
        *self.config.write() = fresh;
        let config = self.config.read().clone();
        self.agent.reload_selection(&config);
        Ok(())
    }
}
