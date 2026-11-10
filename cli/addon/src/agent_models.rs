//! Model, provider and thinking-level selection on `NapiAgent`.

use evot::api::SelectionReload;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::agent::NapiAgent;

#[napi]
impl NapiAgent {
    /// Get configured models as provider-qualified specs. Provider qualification
    /// keeps entries distinct when multiple providers expose the same model id;
    /// config info also carries each provider's wire protocol.
    #[napi]
    pub fn available_models(&self) -> Result<Vec<String>> {
        let config = self.load_config()?;
        Ok(self
            .collect_models(&config)
            .into_iter()
            .filter_map(|entry| entry.get("spec")?.as_str().map(str::to_string))
            .collect())
    }

    /// Switch the active provider by model spec.
    #[napi]
    pub fn set_provider(&self, provider: String) -> Result<()> {
        let config = self.load_config()?;
        self.agent
            .set_model_by_spec(&config, &provider)
            .map_err(|e| Error::from_reason(format!("invalid provider: {e}")))
    }

    /// Re-resolve the live model selection after login, logout, or key
    /// recovery. Returns false only when nothing is configured any more, i.e.
    /// the one case that needs `/login`.
    #[napi]
    pub fn reload_selection(&self) -> Result<bool> {
        let config = self.load_config()?;
        Ok(self.agent.reload_selection(&config).has_model())
    }

    /// Like `reload_selection`, but reports where the selection landed:
    /// `kept`, `followed` (same model id, new provider), `switched`
    /// (different model), or `unconfigured`. Lets the UI announce only real
    /// movement instead of diffing display state.
    #[napi]
    pub fn reload_selection_outcome(&self) -> Result<String> {
        let config = self.load_config()?;
        let outcome = match self.agent.reload_selection(&config) {
            SelectionReload::Kept => "kept",
            SelectionReload::Followed => "followed",
            SelectionReload::Switched => "switched",
            SelectionReload::Unconfigured => "unconfigured",
        };
        Ok(outcome.to_string())
    }

    /// Reload provider/model selection from disk for session resume. Unlike an
    /// interactive switch, this reapplies the current configured thinking level.
    /// Returns false when the saved selection is unavailable and the current
    /// live selection was refreshed instead.
    #[napi]
    pub fn reload_provider(&self, provider: String) -> Result<bool> {
        let config = self.load_config()?;
        self.agent
            .reload_provider_for_resume(&config, &provider)
            .map_err(|e| Error::from_reason(format!("invalid provider: {e}")))
    }

    /// Advance the thinking level to the next tier the current model supports,
    /// wrapping around, and persist it as the default for future sessions
    /// (pi-style double write: the session records its own level per run).
    /// Returns the new level's display label, or `null` when the model has no
    /// selectable reasoning levels.
    #[napi]
    pub fn cycle_thinking_level(&self) -> Option<String> {
        evot::api::cycle_thinking_level(&self.agent, &self.env_file_path)
    }

    /// Apply a named thinking level and persist it as the default, the same
    /// double write `cycle_thinking_level` performs. Unlike `cycle`, the caller
    /// names the tier, so the model picker can commit a model and its effort in
    /// one gesture. Returns the new display label, or `null` when the level is
    /// unknown or the active model does not offer it — the caller then leaves
    /// the live selection untouched rather than silently clamping.
    #[napi]
    pub fn set_thinking_level(&self, level: String) -> Option<String> {
        evot::api::set_thinking_level(&self.agent, &self.env_file_path, &level)
    }

    /// Make a cloud model the account's default for future sessions, on this
    /// and every other machine, without touching the live selection. Returns
    /// the pinned model id, or `null` when the model is BYOK / nobody is
    /// logged in (local config already remembers those). Errors when the
    /// server refuses the pin.
    #[napi]
    pub async fn pin_default_model(
        &self,
        provider: String,
        model: String,
    ) -> Result<Option<String>> {
        match evot::api::pin_default_model(&self.env_file_path, &provider, &model).await {
            Ok(evot::api::PinOutcome::Pinned(model)) => Ok(Some(model)),
            Ok(evot::api::PinOutcome::NotCloud) => Ok(None),
            Err(e) => Err(Error::from_reason(format!("pin default model: {e}"))),
        }
    }

    /// Apply a named thinking level when supported by the active model.
    /// Used on session resume so the session's recorded effort wins over the
    /// config default applied by `reload_provider`.
    #[napi]
    pub fn restore_thinking_level(&self, level: String) {
        self.agent.restore_thinking_level(&level);
    }
}
