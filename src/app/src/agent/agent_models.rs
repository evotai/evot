//! Model and thinking-level selection on the agent.

use super::agent::Agent;
use crate::agent::models::ModelSelection;
use crate::agent::models::SelectionReload;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::LlmConfig;

impl Agent {
    pub fn set_llm(&self, llm: LlmConfig) {
        self.selection.replace(llm);
    }

    /// Set the active thinking level for the current provider.
    pub fn set_thinking_level(&self, level: evot_engine::ThinkingLevel) {
        self.selection.set_thinking_level(level);
    }

    /// Apply a named thinking level when supported by the active model.
    /// Kept as a public API for callers that explicitly manage live state;
    /// session resume intentionally reloads the current configured value instead.
    pub fn restore_thinking_level(&self, name: &str) {
        self.selection.restore_thinking_level(name);
    }

    /// Thinking levels the current model can cycle through, in ascending order
    /// of effort. Empty when the model does not honor a reasoning effort (e.g.
    /// an OpenAI-compatible provider without the reasoning-effort capability).
    pub fn supported_thinking_levels(&self) -> Vec<evot_engine::ThinkingLevel> {
        self.selection.supported_thinking_levels()
    }

    /// The active model's resolved context window in tokens, after applying
    /// explicit overrides. Used to size and validate compaction so the retained
    /// context fits what the model actually accepts.
    pub fn resolved_context_window(&self) -> u32 {
        self.selection.resolved_context_window()
    }

    /// Advance the thinking level to the next supported tier, wrapping around.
    /// Returns the new level, or `None` when the model has no selectable levels.
    pub fn cycle_thinking_level(&self) -> Option<evot_engine::ThinkingLevel> {
        self.selection.cycle_thinking_level()
    }

    /// Set the active model by spec (e.g. "deepseek-chat" or "openrouter:google/gemini-2.5-pro").
    ///
    /// Resolution and provider config errors are returned before mutating the
    /// active LLM. Explicit `provider:model` remains the escape hatch for model
    /// ids not listed in config, as long as the provider itself exists.
    pub fn set_model_by_spec(&self, config: &Config, spec: &str) -> Result<()> {
        self.selection.select_by_spec(config, spec)
    }

    /// Select a model from the configured directory and return the exact
    /// snapshot to pin to a run. This does not persist configuration.
    pub fn select_configured_model(
        &self,
        config: &Config,
        provider: &str,
        model: &str,
        thinking_level: Option<&str>,
    ) -> Result<LlmConfig> {
        self.selection
            .select_configured(config, provider, model, thinking_level)
    }

    /// Re-resolve the live selection against a reloaded config, after login,
    /// logout, key recovery, or a settings write.
    ///
    /// The live (provider, model) is authoritative whenever the new config still
    /// serves it: re-minting a scoped key must not move a running session onto
    /// the catalog's landing model. Its thinking level rides along, clamped to
    /// what the model supports. Otherwise the config's own active selection
    /// takes over — a first login lands on the catalog default, and logout falls
    /// back to whatever BYOK remains, or to no model at all.
    ///
    /// Total by construction: every config maps to one of the three landings, so
    /// callers never have to invent a recovery of their own.
    pub fn reload_selection(&self, config: &Config) -> SelectionReload {
        self.selection.reload_selection(config)
    }

    /// Restore a resumed session's saved provider/model. Falls back to
    /// re-resolving the live selection when the saved one is gone (e.g. a
    /// provider dropped from config), so its thinking level still refreshes.
    /// Returns whether the saved selection was restored.
    pub fn reload_provider_for_resume(&self, config: &Config, spec: &str) -> Result<bool> {
        self.selection.reload_provider_for_resume(config, spec)
    }

    /// The session-facing label for the agent's current thinking level, or
    /// `None` when the level is not a selectable tier for the active model
    /// (e.g. a config-set level the model rejects). Resume restores this
    /// snapshot over the config default, so gating on membership keeps the
    /// metadata meaningful.
    pub(super) fn persisted_thinking_level_for(llm: &LlmConfig) -> Option<String> {
        let level = llm.thinking_level;
        if ModelSelection::supported_thinking_levels_for(llm).contains(&level) {
            Some(level.as_str().to_string())
        } else {
            None
        }
    }
}
