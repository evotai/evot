use std::cmp::Reverse;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;

use evot_engine::provider::CompatCaps;
use evot_engine::provider::RouteCapabilityOverrides;
use evot_engine::ThinkingLevel;
use indexmap::IndexMap;
use serde::Deserialize;
use serde::Serialize;

use crate::conf::channels::FeishuChannelConfig;
use crate::conf::paths;
use crate::error::EvotError;
use crate::error::Result;

// ---------------------------------------------------------------------------
// Protocol — determines which LLM provider implementation to use
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Protocol {
    #[serde(rename = "anthropic")]
    Anthropic,
    /// OpenAI-compatible Chat Completions API.
    #[serde(rename = "openai")]
    OpenAi,
    /// Native OpenAI Responses API.
    #[serde(rename = "openai_responses")]
    OpenAiResponses,
}

impl std::fmt::Display for Protocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Anthropic => write!(f, "anthropic"),
            Self::OpenAi => write!(f, "openai"),
            Self::OpenAiResponses => write!(f, "openai_responses"),
        }
    }
}

/// Infer the wire protocol from the provider name. Anthropic-named providers
/// default to Anthropic Messages; every other provider retains the historical
/// Chat Completions default. Responses must be selected explicitly.
pub fn infer_protocol(name: &str) -> Protocol {
    if name.starts_with("anthropic") {
        Protocol::Anthropic
    } else {
        Protocol::OpenAi
    }
}

pub fn parse_protocol(value: &str) -> Result<Protocol> {
    match value.to_lowercase().as_str() {
        "anthropic" => Ok(Protocol::Anthropic),
        "openai" => Ok(Protocol::OpenAi),
        "openai_responses" => Ok(Protocol::OpenAiResponses),
        other => Err(EvotError::Conf(format!(
            "unknown protocol: {other} (valid: anthropic, openai, openai_responses)"
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn resolve_model_config(
    protocol: Protocol,
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    compat_caps: CompatCaps,
    route_capabilities: RouteCapabilityOverrides,
    context_window: Option<u32>,
    max_tokens: Option<u32>,
    supports_image: Option<bool>,
) -> evot_engine::provider::ModelConfig {
    use evot_engine::provider::default_base_url;
    use evot_engine::provider::ApiProtocol;
    use evot_engine::provider::ModelOverrides;
    use evot_engine::provider::OpenAiCompat;
    use evot_engine::provider::ResolveModelRequest;
    use evot_engine::provider::RouteCapabilities;

    let api = match protocol {
        Protocol::Anthropic => ApiProtocol::AnthropicMessages,
        Protocol::OpenAi => ApiProtocol::OpenAiCompletions,
        Protocol::OpenAiResponses => ApiProtocol::OpenAiResponses,
    };
    let resolved_base = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_base_url(api, provider))
        .to_string();
    let mut compat = match protocol {
        Protocol::Anthropic => None,
        Protocol::OpenAi | Protocol::OpenAiResponses => Some(OpenAiCompat::for_provider(provider)),
    };
    if let Some(compat) = &mut compat {
        compat.caps |= compat_caps;
    }
    let route_capabilities =
        RouteCapabilities::for_route(api, provider, &resolved_base, route_capabilities);

    evot_engine::provider::ModelConfig::resolve(ResolveModelRequest {
        protocol: api,
        provider: provider.to_string(),
        model_id: model.to_string(),
        base_url: resolved_base,
        headers: Default::default(),
        compat,
        route_capabilities,
        overrides: ModelOverrides {
            context_window,
            max_output_tokens: max_tokens,
            supports_image,
            reasoning: None,
        },
    })
}

// ---------------------------------------------------------------------------
// ProviderProfile — static config for one provider
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProviderProfile {
    pub protocol: Protocol,
    pub api_key: String,
    pub base_url: String,
    /// Available models; `models[0]` is the default.
    pub models: Vec<String>,
    pub compat_caps: CompatCaps,
    pub route_capabilities: RouteCapabilityOverrides,
    /// Per-provider reasoning effort. When `None`, the global
    /// [`LlmSelection::thinking_level`] applies. Lets each provider run at a
    /// different effort (e.g. anthropic=xhigh, deepseek=off).
    pub thinking_level: Option<ThinkingLevel>,
    pub context_window: Option<u32>,
    pub max_tokens: Option<u32>,
    /// Whether the model accepts image input. `None` leaves the protocol
    /// default (Anthropic: vision; OpenAI-compatible: text-only). Set to
    /// `Some(false)` for text-only models so images are never sent, and
    /// `Some(true)` for vision-capable OpenAI-compatible models.
    pub supports_image: Option<bool>,
}

impl ProviderProfile {
    /// The default (first) model.
    pub fn model(&self) -> &str {
        self.models.first().map(|s| s.as_str()).unwrap_or("")
    }
}

// ---------------------------------------------------------------------------
// LlmSelection — which provider is active + runtime overrides
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct LlmSelection {
    pub provider: String,
    pub model_override: Option<String>,
    /// User-selected global override. `None` preserves the model-authored
    /// default from the catalog.
    pub thinking_level: Option<ThinkingLevel>,
}

// ---------------------------------------------------------------------------
// LlmConfig — resolved runtime config passed to Agent / Engine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub provider: String,
    pub protocol: Protocol,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub thinking_level: ThinkingLevel,
    pub model_config: evot_engine::provider::ModelConfig,
}

impl LlmConfig {
    /// An unresolved placeholder used when no provider/key is configured yet
    /// (e.g. a fresh install). Lets the agent construct and the server start;
    /// the missing configuration is surfaced at query time instead of blocking
    /// startup.
    pub fn unconfigured() -> Self {
        let model_config = resolve_model_config(
            Protocol::Anthropic,
            "",
            "",
            None,
            CompatCaps::default(),
            RouteCapabilityOverrides::default(),
            None,
            None,
            None,
        );
        Self {
            provider: String::new(),
            protocol: Protocol::Anthropic,
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            thinking_level: model_config.default_thinking_level(),
            model_config,
        }
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Config {
    pub id: Option<String>,
    pub llm: LlmSelection,
    pub providers: IndexMap<String, ProviderProfile>,
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub channels: ChannelsConfig,
    pub sandbox: SandboxConfig,
    pub skills_dirs: Vec<PathBuf>,
    /// The env file path actually used during config loading.
    pub env_file_path: PathBuf,
    /// Revision captured during load/save; not part of any published format.
    pub(crate) env_revision: Option<super::env_transaction::EnvRevision>,
    /// Server-pushed thinking defaults, keyed by cloud model id.
    pub cloud_thinking_levels: HashMap<String, ThinkingLevel>,
    /// Catalog tier per cloud model id (`base` / `special`).
    pub cloud_model_tiers: HashMap<String, String>,
    /// Server-pushed context window per cloud model id. A profile's own
    /// `_CONTEXT_WINDOW` wins over it; the engine's per-model default is the
    /// fallback when neither is set.
    pub cloud_context_windows: HashMap<String, u32>,
    /// Catalog display rank per cloud model id (higher shows earlier).
    pub cloud_model_sorts: HashMap<String, i64>,
    /// Wire protocol per cloud model id. A cloud group is named by tier and
    /// may mix Anthropic and OpenAI models, so the protocol is a property of
    /// the model, not the group. Missing ids fall back to the group protocol.
    pub cloud_model_protocols: HashMap<String, Protocol>,
    /// The account's pinned landing model from the server, if it set one and
    /// the model is currently served by a cloud provider.
    pub cloud_default_model: Option<String>,
    pub cloud_providers: HashSet<String>,
    /// The judge model the server published, if any: answers typed questions
    /// about the conversation and drives lossless context pruning. Never a
    /// chat provider; never in the picker.
    pub judge: Option<JudgeEndpoint>,
}

/// Where a judge model lives. It rides on the cloud gateway like any other
/// model, so the same key and protocol apply; only its use differs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeEndpoint {
    pub provider: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// Context window the server published for the judge model, if any.
    pub context_window: Option<u32>,
}

impl Config {
    pub fn new(state_root: PathBuf) -> Self {
        Self {
            id: None,
            llm: LlmSelection::default(),
            providers: IndexMap::new(),
            server: ServerConfig::default(),
            storage: StorageConfig::fs(state_root),
            channels: ChannelsConfig::default(),
            sandbox: SandboxConfig::default(),
            skills_dirs: Vec::new(),
            env_file_path: PathBuf::new(),
            env_revision: None,
            cloud_thinking_levels: HashMap::new(),
            cloud_model_tiers: HashMap::new(),
            cloud_context_windows: HashMap::new(),
            cloud_model_sorts: HashMap::new(),
            cloud_model_protocols: HashMap::new(),
            cloud_default_model: None,
            cloud_providers: HashSet::new(),
            judge: None,
        }
    }

    /// The (provider, model) pair an un-pinned request resolves to.
    ///
    /// An explicit pin (`--model`, a Models page chip) wins. Otherwise a cloud
    /// account follows catalog rank, and a BYOK provider its head model.
    pub fn active_selection(&self) -> Option<(String, String)> {
        if let Some(model) = &self.llm.model_override {
            return Some((self.llm.provider.clone(), model.clone()));
        }
        if self.llm.provider.is_empty() || self.cloud_providers.contains(&self.llm.provider) {
            if let Some(pair) = self.preferred_new_session_llm() {
                return Some(pair);
            }
        }
        let profile = self.providers.get(&self.llm.provider)?;
        Some((self.llm.provider.clone(), profile.model().to_string()))
    }

    /// Find another provider that explicitly lists `model` and can serve it.
    ///
    /// Used when a model moved between catalog groups (e.g. a free model
    /// promoted to a premium tier): the user's pick should follow the model,
    /// not fall back to the catalog default. Only explicit listings count, so
    /// a BYOK provider that accepts arbitrary ids is never chosen by accident.
    pub fn provider_listing_model(&self, model: &str, exclude: &str) -> Option<String> {
        if model.is_empty() {
            return None;
        }
        self.providers
            .iter()
            .filter(|(name, _)| name.as_str() != exclude)
            .filter(|(_, profile)| !profile.api_key.trim().is_empty())
            .find(|(_, profile)| profile.models.iter().any(|m| m == model))
            .map(|(name, _)| name.clone())
    }

    /// Whether this config can still serve a given (provider, model) pair.
    ///
    /// The single rule behind every reload: a provider must be configured with a
    /// usable key, and a cloud model must still be in the catalog, since the
    /// server owns that list. A BYOK provider keeps serving whatever model id
    /// its user pinned, including ids absent from the configured list.
    pub fn serves(&self, provider: &str, model: &str) -> bool {
        if model.is_empty() {
            return false;
        }
        let Some(profile) = self.providers.get(provider) else {
            return false;
        };
        if profile.api_key.trim().is_empty() {
            return false;
        }
        if self.cloud_providers.contains(provider) {
            return profile.models.iter().any(|m| m == model);
        }
        true
    }

    /// Resolve the active selection into a runtime LlmConfig.
    pub fn active_llm(&self) -> Result<LlmConfig> {
        match self.active_selection() {
            Some((provider, model)) => self.build_llm(&provider, Some(model)),
            // Nothing to resolve; let `build_llm` report why.
            None => self.build_llm(&self.llm.provider, self.llm.model_override.clone()),
        }
    }

    /// Build an LlmConfig for a given provider name and optional model override.
    pub fn build_llm(
        &self,
        provider_name: &str,
        model_override: Option<String>,
    ) -> Result<LlmConfig> {
        let profile = self.providers.get(provider_name).ok_or_else(|| {
            EvotError::Conf(format!(
                "provider '{}' not found, available: {}",
                provider_name,
                self.providers
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?;
        let model = model_override.unwrap_or_else(|| profile.model().to_string());
        let protocol = self.protocol_for(provider_name, profile, &model);
        let compat_caps = self.compat_caps_for(provider_name, profile, &protocol);
        let model_config = resolve_model_config(
            protocol.clone(),
            provider_name,
            &model,
            Some(&profile.base_url),
            compat_caps,
            profile.route_capabilities,
            profile
                .context_window
                .or_else(|| self.cloud_context_windows.get(&model).copied()),
            profile.max_tokens,
            profile.supports_image,
        );
        let requested_level = profile
            .thinking_level
            .or_else(|| self.cloud_thinking_levels.get(&model).copied())
            .or(self.llm.thinking_level)
            .unwrap_or_else(|| model_config.default_thinking_level());
        let thinking_level = model_config.effective_thinking_level(requested_level);

        Ok(LlmConfig {
            provider: provider_name.to_string(),
            protocol,
            api_key: profile.api_key.clone(),
            base_url: profile.base_url.clone(),
            model,
            thinking_level,
            model_config,
        })
    }

    /// The wire protocol `model` speaks under `provider`.
    ///
    /// A cloud group is one tier and may carry both Anthropic and OpenAI
    /// models, so the catalog's per-model protocol decides. A BYOK profile
    /// speaks exactly the protocol it was configured with.
    pub fn protocol_for(&self, provider: &str, profile: &ProviderProfile, model: &str) -> Protocol {
        if self.cloud_providers.contains(provider) {
            if let Some(protocol) = self.cloud_model_protocols.get(model) {
                return protocol.clone();
            }
        }
        profile.protocol.clone()
    }

    /// Transport quirks for one route.
    ///
    /// Cloud groups are named by the server, so they never match the
    /// first-party `openai` / `grok` transport profiles. The gateway forwards
    /// `reasoning_effort` for OpenAI-protocol models; without this cap the
    /// footer and Shift+Tab would treat such a model as having no selectable
    /// effort.
    fn compat_caps_for(
        &self,
        provider: &str,
        profile: &ProviderProfile,
        protocol: &Protocol,
    ) -> CompatCaps {
        if self.cloud_providers.contains(provider) && *protocol == Protocol::OpenAi {
            return profile.compat_caps | CompatCaps::REASONING_EFFORT;
        }
        profile.compat_caps
    }

    /// Sort key for one cloud model; the highest key is the default.
    /// Premium (`special`) beats Free, then the catalog rank (`sort_order`),
    /// then catalog order — the same order the pickers render.
    fn cloud_rank(
        &self,
        provider_idx: usize,
        model_idx: usize,
        model: &str,
    ) -> (bool, i64, Reverse<usize>, Reverse<usize>) {
        (
            self.cloud_model_tiers.get(model).map(String::as_str) == Some("special"),
            self.cloud_model_sorts.get(model).copied().unwrap_or(0),
            Reverse(provider_idx),
            Reverse(model_idx),
        )
    }

    /// Landing (provider, model) for a fresh cloud session: the catalog's
    /// top-ranked model. The account's server-side pin wins when a cloud
    /// provider still serves it; otherwise the server owns the outcome through
    /// tier and `sort_order`.
    pub fn preferred_new_session_llm(&self) -> Option<(String, String)> {
        if let Some(pinned) = self.cloud_default_model.as_deref() {
            let served = self
                .providers
                .iter()
                .find(|(name, profile)| {
                    self.cloud_providers.contains(*name)
                        && profile.models.iter().any(|m| m == pinned)
                })
                .map(|(name, _)| (name.clone(), pinned.to_string()));
            if served.is_some() {
                return served;
            }
        }
        self.providers
            .iter()
            .enumerate()
            .filter(|(_, (name, _))| self.cloud_providers.contains(*name))
            .flat_map(|(provider_idx, (name, profile))| {
                profile
                    .models
                    .iter()
                    .enumerate()
                    .map(move |(model_idx, model)| (provider_idx, model_idx, name, model))
            })
            .max_by_key(|(provider_idx, model_idx, _, model)| {
                self.cloud_rank(*provider_idx, *model_idx, model)
            })
            .map(|(_, _, provider, model)| (provider.clone(), model.clone()))
    }

    /// Parse a model spec and return (provider_name, model).
    ///
    /// The model is always returned as an explicit pin: naming a model is a
    /// deliberate choice, so it must survive catalog ranking.
    ///
    /// Formats:
    /// - `"deepseek-chat"` — find first provider whose model matches
    /// - `"tencent/hy3:free"` — exact model ids win even when they contain `:`
    /// - `"openrouter:google/gemini-2.5-pro"` — exact provider + model override
    ///
    /// A `provider:model` whose provider is no longer configured still resolves
    /// when exactly that model id is listed elsewhere: the cloud catalog
    /// regroups its providers under new names between refreshes, and a picker
    /// opened moments earlier hands back the old spec. A typo in the provider
    /// of a model nobody lists remains an error.
    pub fn resolve_model_spec(&self, spec: &str) -> Result<(String, Option<String>)> {
        let found = self
            .providers
            .iter()
            .find(|(_, p)| p.models.iter().any(|m| m == spec))
            .map(|(name, _)| (name.clone(), Some(spec.to_string())));
        if let Some(found) = found {
            return Ok(found);
        }

        if let Some((provider, model)) = spec.split_once(':') {
            if model.is_empty() {
                return Err(EvotError::Conf(format!(
                    "empty model in spec '{spec}', expected provider:model"
                )));
            }
            if !self.providers.contains_key(provider) {
                if let Some(listing) = self.provider_listing_model(model, provider) {
                    tracing::info!(%spec, provider = %listing, "model spec provider regrouped");
                    return Ok((listing, Some(model.to_string())));
                }
                return Err(EvotError::Conf(format!(
                    "provider '{}' not found, available: {}",
                    provider,
                    self.providers
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            Ok((provider.to_string(), Some(model.to_string())))
        } else {
            Err(EvotError::Conf(format!(
                "no provider with model '{}', available: {}",
                spec,
                self.providers
                    .iter()
                    .flat_map(|(n, p)| { p.models.iter().map(move |m| format!("{}:{}", n, m)) })
                    .collect::<Vec<_>>()
                    .join(", ")
            )))
        }
    }

    /// Apply `--model` CLI argument. Must be called before `validate()`.
    pub fn with_model(mut self, model: Option<String>) -> Result<Self> {
        let Some(value) = model else {
            return Ok(self);
        };
        let (provider, model_override) = self.resolve_model_spec(&value)?;
        self.llm.provider = provider;
        self.llm.model_override = model_override;
        Ok(self)
    }

    pub fn load() -> Result<Self> {
        super::load::load_config_inner(None)
    }

    pub fn load_with_env_file(env_file: Option<&str>) -> Result<Self> {
        super::load::load_config_inner(env_file)
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.server.port = port;
        self
    }

    pub fn validate(&self) -> Result<()> {
        let profile = self.providers.get(&self.llm.provider).ok_or_else(|| {
            EvotError::Conf(format!("provider '{}' not found", self.llm.provider))
        })?;
        if profile.api_key.is_empty() {
            return Err(EvotError::Conf(format!(
                "{}.api_key not set (env file: {})",
                self.llm.provider,
                self.env_file_path.display()
            )));
        }
        if profile.base_url.is_empty() {
            return Err(EvotError::Conf(format!(
                "{}.base_url not set (env file: {})",
                self.llm.provider,
                self.env_file_path.display()
            )));
        }
        if profile.models.is_empty() && self.llm.model_override.is_none() {
            return Err(EvotError::Conf(format!(
                "{}.model not set (env file: {})",
                self.llm.provider,
                self.env_file_path.display()
            )));
        }

        match self.storage.backend {
            StorageBackend::Fs => {
                if self.storage.fs.root_dir.as_os_str().is_empty() {
                    return Err(EvotError::Conf("storage.fs.root_dir not set".into()));
                }
            }
            StorageBackend::Cloud => {
                if self.storage.cloud.endpoint.is_empty() {
                    return Err(EvotError::Conf("storage.cloud.endpoint not set".into()));
                }
                if self.storage.cloud.api_key.is_empty() {
                    return Err(EvotError::Conf("storage.cloud.api_key not set".into()));
                }
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Server / Storage / Channels / Sandbox — unchanged
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 8082,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub backend: StorageBackend,
    pub fs: FsStorageConfig,
    pub cloud: CloudStorageConfig,
}

impl StorageConfig {
    pub fn fs(root_dir: PathBuf) -> Self {
        Self {
            backend: StorageBackend::Fs,
            fs: FsStorageConfig { root_dir },
            cloud: CloudStorageConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
    #[default]
    Fs,
    Cloud,
}

#[derive(Debug, Clone)]
pub struct FsStorageConfig {
    pub root_dir: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct CloudStorageConfig {
    pub endpoint: String,
    pub api_key: String,
    pub workspace: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn thinking_level_from_str(value: &str) -> Result<ThinkingLevel> {
    match value.to_lowercase().as_str() {
        "off" => Ok(ThinkingLevel::Off),
        "minimal" => Ok(ThinkingLevel::Minimal),
        "low" => Ok(ThinkingLevel::Low),
        "medium" => Ok(ThinkingLevel::Medium),
        "high" => Ok(ThinkingLevel::High),
        "xhigh" => Ok(ThinkingLevel::Xhigh),
        "max" => Ok(ThinkingLevel::Max),
        // `adaptive` used to mean "let the provider pick an effort". Every level
        // is now a real tier, so name the one you want instead.
        "adaptive" => Err(EvotError::Conf(
            "thinking level 'adaptive' was removed; use an explicit level \
             (off, minimal, low, medium, high, xhigh, max) — medium is the default"
                .to_string(),
        )),
        other => Err(EvotError::Conf(format!(
            "unknown thinking level: {other} (valid: off, minimal, low, medium, high, xhigh, max)"
        ))),
    }
}

pub fn default_config() -> Result<Config> {
    Ok(Config::new(paths::state_root_dir()?))
}

#[derive(Debug, Clone, Default)]
pub struct ChannelsConfig {
    pub feishu: Option<FeishuChannelConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct SandboxConfig {
    pub enabled: bool,
    pub allowed_dirs: Vec<PathBuf>,
}
