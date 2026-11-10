//! Settings endpoints: models and channel configuration.

use axum::response::IntoResponse;
use axum::Json;

use super::server::Server;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::FeishuSettings;
use crate::conf::ModelSettings;

impl Server {
    /// Provider + model state with secrets masked, for the Models page.
    ///
    /// Reloads from the env file on disk first, so the page reflects edits made
    /// outside the dashboard (e.g. a hand-edited `evot.env`) rather than a stale
    /// in-memory snapshot. This also keeps the next save's "leave blank to keep"
    /// behavior anchored to the real on-disk secrets.
    pub(super) fn get_models(&self) -> impl IntoResponse {
        if let Err(e) = self.reload_config_from_disk() {
            // Fall back to the in-memory config rather than failing the page; a
            // transient read error shouldn't blank out the page.
            tracing::warn!("models: reload from disk failed, serving cached config: {e}");
        }
        Json(crate::conf::models_snapshot(&self.config.read()))
    }

    /// Feishu channel state with the secret masked, for the Feishu page.
    pub(super) fn get_feishu(&self) -> impl IntoResponse {
        if let Err(e) = self.reload_config_from_disk() {
            tracing::warn!("feishu: reload from disk failed, serving cached config: {e}");
        }
        Json(crate::conf::feishu_snapshot(&self.config.read()))
    }

    /// Re-read the env file from disk and replace the shared config. Uses the
    /// path the process was started with so a custom `--env-file` is honored.
    pub(super) fn reload_config_from_disk(&self) -> Result<()> {
        let mut config = self.config.write();
        let path_arg = config.env_file_path.to_str();
        let fresh = Config::load_with_env_file(path_arg)?;
        *config = fresh;
        Ok(())
    }

    /// Validate, persist, and hot-apply a provider/model update. Takes effect on
    /// the next message: the agent's `LlmConfig` is rebuilt here.
    pub(super) fn update_models(&self, update: ModelSettings) -> impl IntoResponse {
        match self
            .apply_and_persist(|candidate| crate::conf::apply_model_settings(candidate, &update))
        {
            Ok(()) => (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "models": crate::conf::models_snapshot(&self.config.read()),
                })),
            )
                .into_response(),
            Err(e) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Persist settings; the gateway supervisor applies transport changes live.
    pub(super) fn update_feishu(&self, update: FeishuSettings) -> impl IntoResponse {
        match self
            .apply_and_persist(|candidate| crate::conf::apply_feishu_settings(candidate, &update))
        {
            Ok(()) => (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "restart_required": false,
                    "channel": crate::conf::feishu_snapshot(&self.config.read()),
                })),
            )
                .into_response(),
            Err(e) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Apply `mutate` to a copy of the shared config, persist the result to the
    /// env file, and push the rebuilt active LLM into the running agent. Holds
    /// the write lock for the whole operation so concurrent edits from separate
    /// pages cannot interleave and lose each other's changes.
    fn apply_and_persist(&self, mutate: impl FnOnce(&mut Config) -> Result<()>) -> Result<()> {
        let mut config = self.config.write();
        let llm = crate::conf::update_config(&mut config, |candidate| {
            mutate(candidate)?;
            candidate.active_llm()
        })?;
        self.agent.set_llm(llm);
        Ok(())
    }
}
