use std::path::Path;

use indexmap::IndexMap;

use super::env_keys::ConfiguredCapabilities;
use super::providers::merge_provider_source;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::base::paths;
use crate::conf::channels::FeishuChannelConfig;
use crate::conf::thinking_level_from_str;
use crate::conf::ChannelsConfig;
use crate::conf::Config;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(super) struct ConfigSource {
    llm: LlmSelectionSource,
    providers: IndexMap<String, ProviderSource>,
    server: ServerSource,
    storage: StorageSource,
    channel: ChannelSource,
    sandbox: SandboxSource,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ChannelSource {
    feishu: Option<FeishuChannelConfig>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct LlmSelectionSource {
    provider: Option<String>,
    thinking_level: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(super) struct ProviderSource {
    pub(super) protocol: Option<String>,
    pub(super) api_key: Option<String>,
    pub(super) base_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_one_or_many")]
    pub(super) model: Option<Vec<String>>,
    pub(super) compat_caps: Option<ConfiguredCapabilities>,
    pub(super) thinking_level: Option<String>,
    pub(super) context_window: Option<u32>,
    pub(super) max_tokens: Option<u32>,
    pub(super) supports_image: Option<bool>,
}

/// Deserialize a TOML value as either a single string or an array of strings.
fn deserialize_one_or_many<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Vec<String>>, D::Error>
where D: serde::Deserializer<'de> {
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    let val = Option::<OneOrMany>::deserialize(deserializer)?;
    Ok(val.map(|v| match v {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
    }))
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ServerSource {
    host: Option<String>,
    port: Option<u16>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct StorageSource {
    fs: FsStorageSource,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct FsStorageSource {
    root_dir: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct SandboxSource {
    enabled: Option<bool>,
    allowed_dirs: Option<Vec<String>>,
}

impl ConfigSource {
    pub(super) fn apply(self, config: &mut Config) -> Result<()> {
        if let Some(provider) = self.llm.provider {
            config.llm.provider = provider;
        }
        if let Some(level) = self.llm.thinking_level {
            config.llm.thinking_level = Some(thinking_level_from_str(&level)?);
        }

        // Apply [providers.*] from TOML — preserves declaration order
        for (name, src) in self.providers {
            merge_provider_source(&mut config.providers, &name, src)?;
        }

        if let Some(host) = self.server.host {
            config.server.host = host;
        }
        if let Some(port) = self.server.port {
            config.server.port = port;
        }

        if let Some(root_dir) = self.storage.fs.root_dir {
            config.storage.fs.root_dir = paths::expand_home_path(&root_dir)?;
        }

        if self.channel.feishu.is_some() {
            config.channels = ChannelsConfig {
                feishu: self.channel.feishu,
            };
        }

        if let Some(enabled) = self.sandbox.enabled {
            config.sandbox.enabled = enabled;
        }
        if let Some(dirs) = self.sandbox.allowed_dirs {
            let mut expanded = Vec::new();
            for d in dirs {
                let d = d.trim().to_string();
                if !d.is_empty() {
                    expanded.push(paths::expand_home_path(&d)?);
                }
            }
            if !expanded.is_empty() {
                config.sandbox.allowed_dirs = expanded;
            }
        }

        Ok(())
    }
}

/// Normalize a provider name to lowercase kebab-case.
pub(super) fn load_file_source(path: &Path) -> Result<ConfigSource> {
    if !path.exists() {
        return Ok(ConfigSource::default());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| EvotError::Conf(format!("failed to read {}: {e}", path.display())))?;
    if content.trim().is_empty() {
        return Ok(ConfigSource::default());
    }
    let source: ConfigSource = toml::from_str(&content)
        .map_err(|e| EvotError::Conf(format!("failed to parse {}: {e}", path.display())))?;
    Ok(source)
}
