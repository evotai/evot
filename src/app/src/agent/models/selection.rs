use evot_engine::ThinkingLevel;
use parking_lot::RwLock;

use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::LlmConfig;

/// Where the live model selection landed after a config reload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionReload {
    /// The live selection is still served, using fresh configuration.
    Kept,
    /// The same model id is now served by a different provider (the catalog
    /// moved it between groups); the selection followed the model.
    Followed,
    /// The live selection disappeared; the configured selection took over.
    Switched,
    /// No usable model remains configured.
    Unconfigured,
}

impl SelectionReload {
    pub fn has_model(self) -> bool {
        !matches!(self, Self::Unconfigured)
    }
}

/// Owns the application's live model selection, independently of sessions,
/// storage, execution and transport. Callers supply resolved configuration;
/// this service never loads or persists it.
///
/// Each transition holds one write lock so model metadata and thinking effort
/// are evaluated against the same selection. Snapshots are owned copies: an
/// admitted run or fork does not follow subsequent live changes.
pub struct ModelSelection {
    llm: RwLock<LlmConfig>,
    /// The selection replaced by the latest provider/model switch. Compaction
    /// uses it to summarize history the previous model produced.
    previous: RwLock<Option<LlmConfig>>,
}

impl ModelSelection {
    pub fn new(llm: LlmConfig) -> Self {
        Self {
            llm: RwLock::new(llm),
            previous: RwLock::new(None),
        }
    }

    /// The model selected before the current one, if they differ.
    pub fn previous_llm(&self) -> Option<LlmConfig> {
        self.previous.read().clone()
    }

    pub fn snapshot(&self) -> LlmConfig {
        self.llm.read().clone()
    }

    /// Replace with an already resolved configuration without inheriting effort.
    pub fn replace(&self, llm: LlmConfig) {
        let mut current = self.llm.write();
        self.remember_switch(&current, &llm);
        *current = llm;
    }

    fn remember_switch(&self, current: &LlmConfig, next: &LlmConfig) {
        if current.provider != next.provider || current.model != next.model {
            *self.previous.write() = Some(current.clone());
        }
    }

    /// Explicit override, preserving the existing Agent setter's semantics.
    pub fn set_thinking_level(&self, level: ThinkingLevel) {
        self.llm.write().thinking_level = level;
    }

    pub fn restore_thinking_level(&self, name: &str) {
        let Ok(level) = crate::conf::thinking_level_from_str(name) else {
            return;
        };
        let mut llm = self.llm.write();
        if Self::supported_thinking_levels_for(&llm).contains(&level) {
            llm.thinking_level = level;
        }
    }

    pub fn supported_thinking_levels(&self) -> Vec<ThinkingLevel> {
        Self::supported_thinking_levels_for(&self.llm.read())
    }

    pub fn supported_thinking_levels_for(llm: &LlmConfig) -> Vec<ThinkingLevel> {
        if llm.model_config.reasoning() {
            llm.model_config.supported_thinking_levels()
        } else {
            Vec::new()
        }
    }

    /// Abstract effort label for clients; omit the indicator for models with
    /// no selectable reasoning. Do not translate through provider effort maps.
    pub fn display_thinking_level_for(llm: &LlmConfig) -> String {
        if Self::supported_thinking_levels_for(llm).is_empty() {
            return String::new();
        }
        llm.thinking_level.as_str().to_string()
    }

    pub fn resolved_context_window(&self) -> u32 {
        self.llm.read().model_config.context_window()
    }

    pub fn cycle_thinking_level(&self) -> Option<ThinkingLevel> {
        let mut llm = self.llm.write();
        let levels = Self::supported_thinking_levels_for(&llm);
        if levels.is_empty() {
            return None;
        }
        let next_index = levels
            .iter()
            .position(|level| *level == llm.thinking_level)
            .map(|index| (index + 1) % levels.len())
            .unwrap_or(0);
        let next = levels[next_index];
        llm.thinking_level = next;
        Some(next)
    }

    /// Interactive model/provider switches share resolution and effort policy.
    /// Resolve before mutation; unknown explicit model ids remain supported
    /// when their provider is configured. Cloud defaults override live effort.
    pub fn select_by_spec(&self, config: &Config, spec: &str) -> Result<()> {
        let (provider, model) = config.resolve_model_spec(spec)?;
        let mut next = config.build_llm(&provider, model)?;
        let mut current = self.llm.write();
        if !config.cloud_thinking_levels.contains_key(&next.model) {
            next.thinking_level = next
                .model_config
                .effective_thinking_level(current.thinking_level);
        }
        self.remember_switch(&current, &next);
        *current = next;
        Ok(())
    }

    /// Select from the configured model directory, applying configured effort
    /// unless explicitly overridden. Unlike `select_by_spec`, arbitrary BYOK
    /// model ids are rejected and the previous live effort is not inherited.
    /// Validation must finish before publication. The returned owned snapshot
    /// pins the caller's next run even if the live selection changes afterward.
    pub fn select_configured(
        &self,
        config: &Config,
        provider: &str,
        model: &str,
        thinking_level: Option<&str>,
    ) -> Result<LlmConfig> {
        let profile = config
            .providers
            .get(provider)
            .ok_or_else(|| EvotError::Conf(format!("provider '{provider}' is not configured")))?;
        if !profile.models.iter().any(|configured| configured == model) {
            return Err(EvotError::Conf(format!(
                "model '{model}' is not configured for provider '{provider}'"
            )));
        }
        let mut next = config.build_llm(provider, Some(model.to_string()))?;
        if let Some(name) = thinking_level {
            let level = crate::conf::thinking_level_from_str(name)?;
            if !next
                .model_config
                .supported_thinking_levels()
                .contains(&level)
            {
                return Err(EvotError::Conf(format!(
                    "thinking level '{name}' is not supported by {provider}/{model}"
                )));
            }
            next.thinking_level = level;
        }
        self.replace(next.clone());
        Ok(next)
    }

    /// Keep a still-served live selection on fresh configuration, inheriting
    /// and clamping effort. The model id is what the user chose: if the
    /// catalog moved that id to another provider (free → premium), follow it
    /// there. Otherwise land on the configured default or clear the
    /// selection. This is distinct from an interactive model switch.
    pub fn reload_selection(&self, config: &Config) -> SelectionReload {
        let mut current = self.llm.write();
        if config.serves(&current.provider, &current.model) {
            if let Some(next) = Self::rebuild_with_effort(config, &current.provider, &current) {
                *current = next;
                return SelectionReload::Kept;
            }
        }
        if let Some(provider) = config.provider_listing_model(&current.model, &current.provider) {
            if let Some(next) = Self::rebuild_with_effort(config, &provider, &current) {
                *current = next;
                return SelectionReload::Followed;
            }
        }
        match config.active_llm() {
            Ok(next) => {
                *current = next;
                SelectionReload::Switched
            }
            Err(_) => {
                *current = LlmConfig::unconfigured();
                SelectionReload::Unconfigured
            }
        }
    }

    /// Rebuild `current.model` under `provider`, inheriting and clamping the
    /// live thinking effort. `None` when the provider cannot build it.
    fn rebuild_with_effort(
        config: &Config,
        provider: &str,
        current: &LlmConfig,
    ) -> Option<LlmConfig> {
        let mut next = config
            .build_llm(provider, Some(current.model.clone()))
            .ok()?;
        next.thinking_level = next
            .model_config
            .effective_thinking_level(current.thinking_level);
        Some(next)
    }

    /// Restore the saved model using current configured effort. The spec is
    /// persisted state, so it follows the model id when the catalog regrouped
    /// it. If resolution fails, refresh the live model instead. Failure leaves
    /// the state intact.
    pub fn reload_provider_for_resume(&self, config: &Config, spec: &str) -> Result<bool> {
        let mut current = self.llm.write();
        match config.resolve_persisted_model_spec(spec) {
            Ok((provider, model)) => {
                let next = config.build_llm(&provider, Some(model))?;
                *current = next;
                Ok(true)
            }
            Err(saved_error) => {
                let current_spec = format!("{}:{}", current.provider, current.model);
                let (provider, model) = config
                    .resolve_persisted_model_spec(&current_spec)
                    .map_err(|_| saved_error)?;
                let next = config.build_llm(&provider, Some(model))?;
                *current = next;
                Ok(false)
            }
        }
    }
}
