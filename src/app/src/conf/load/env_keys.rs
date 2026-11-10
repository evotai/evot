use evot_engine::provider::CompatCaps;
use evot_engine::provider::RouteCapabilityOverrides;
use indexmap::IndexMap;

use super::providers::validate_provider_name;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::infer_protocol;
use crate::conf::parse_protocol;
use crate::conf::thinking_level_from_str;
use crate::conf::ProviderProfile;

const GLOBAL_ENV_KEYS: &[&str] = &["EVOT_LLM_PROVIDER", "EVOT_LLM_THINKING_LEVEL"];

const PROVIDER_FIELDS: &[&str] = &[
    "_API_KEY",
    "_BASE_URL",
    "_MODEL",
    "_PROTOCOL",
    "_COMPAT_CAPS",
    "_THINKING_LEVEL",
    "_CONTEXT_WINDOW",
    "_MAX_TOKENS",
    "_SUPPORTS_IMAGE",
];

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct ConfiguredCapabilities {
    pub(super) transport: CompatCaps,
    pub(super) route: RouteCapabilityOverrides,
}

impl<'de> serde::Deserialize<'de> for ConfiguredCapabilities {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let names = Vec::<String>::deserialize(deserializer)?;
        parse_configured_capabilities(names.iter().map(String::as_str))
            .map_err(serde::de::Error::custom)
    }
}

/// Convert env NAME encoding to provider name: uppercase + underscore → lowercase + hyphen.
/// e.g. "MY_CORP" → "my-corp", "OPENROUTER" → "openrouter"
fn env_name_to_provider(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// Try to parse a key as EVOT_LLM_{NAME}_{FIELD}.
/// Returns (provider_name, field_suffix) if matched.
pub(super) fn parse_provider_env_key(key: &str) -> Option<(String, &'static str)> {
    let rest = key.strip_prefix("EVOT_LLM_")?;

    // Skip global keys
    for gk in GLOBAL_ENV_KEYS {
        if key == *gk {
            return None;
        }
    }

    // Try each field suffix (longest first to avoid partial matches)
    for suffix in PROVIDER_FIELDS {
        if let Some(name_part) = rest.strip_suffix(suffix) {
            if !name_part.is_empty() {
                return Some((env_name_to_provider(name_part), suffix));
            }
        }
    }
    None
}

/// Parse legacy EVOT_ANTHROPIC_* / EVOT_OPENAI_* keys.
pub(super) fn parse_legacy_env_key(key: &str) -> Option<(&'static str, &'static str)> {
    if let Some(field) = key.strip_prefix("EVOT_ANTHROPIC_") {
        let suffix = match field {
            "API_KEY" => "_API_KEY",
            "BASE_URL" => "_BASE_URL",
            "MODEL" => "_MODEL",
            _ => return None,
        };
        return Some(("anthropic", suffix));
    }
    if let Some(field) = key.strip_prefix("EVOT_OPENAI_") {
        let suffix = match field {
            "API_KEY" => "_API_KEY",
            "BASE_URL" => "_BASE_URL",
            "MODEL" => "_MODEL",
            _ => return None,
        };
        return Some(("openai", suffix));
    }
    None
}

fn parse_configured_capabilities<'a>(
    names: impl IntoIterator<Item = &'a str>,
) -> std::result::Result<ConfiguredCapabilities, String> {
    let mut capabilities = ConfiguredCapabilities::default();
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(cap) = CompatCaps::from_name(name) {
            capabilities.transport |= cap;
        } else if !capabilities.route.set_named(name) {
            return Err(format!("unknown compat cap: {name}"));
        }
    }
    Ok(capabilities)
}

fn parse_compat_caps(value: &str) -> Result<ConfiguredCapabilities> {
    parse_configured_capabilities(value.split(',')).map_err(EvotError::Conf)
}

pub(super) fn apply_provider_field(
    providers: &mut IndexMap<String, ProviderProfile>,
    name: &str,
    field: &str,
    value: &str,
) -> Result<()> {
    validate_provider_name(name)?;
    let profile = providers
        .entry(name.to_string())
        .or_insert_with(|| ProviderProfile {
            protocol: infer_protocol(name),
            api_key: String::new(),
            base_url: String::new(),
            models: Vec::new(),
            compat_caps: CompatCaps::default(),
            route_capabilities: RouteCapabilityOverrides::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    match field {
        "_API_KEY" => profile.api_key = value.to_string(),
        "_BASE_URL" => profile.base_url = value.to_string(),
        "_MODEL" => {
            profile.models = value
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        "_PROTOCOL" => profile.protocol = parse_protocol(value)?,
        "_COMPAT_CAPS" => {
            let capabilities = parse_compat_caps(value)?;
            profile.compat_caps = capabilities.transport;
            profile.route_capabilities = capabilities.route;
        }
        "_THINKING_LEVEL" => profile.thinking_level = Some(thinking_level_from_str(value)?),
        "_CONTEXT_WINDOW" => profile.context_window = Some(parse_token_count(name, field, value)?),
        "_MAX_TOKENS" => profile.max_tokens = Some(parse_token_count(name, field, value)?),
        "_SUPPORTS_IMAGE" => profile.supports_image = Some(parse_bool(name, field, value)?),
        _ => {}
    }
    Ok(())
}

/// Parse a positive token-count field (context window / max tokens).
fn parse_token_count(name: &str, field: &str, value: &str) -> Result<u32> {
    let parsed: u32 = value.trim().parse().map_err(|_| {
        EvotError::Conf(format!(
            "EVOT_LLM_{}{} must be a positive integer, got '{}'",
            name.to_uppercase().replace('-', "_"),
            field,
            value
        ))
    })?;
    if parsed == 0 {
        return Err(EvotError::Conf(format!(
            "EVOT_LLM_{}{} must be greater than 0",
            name.to_uppercase().replace('-', "_"),
            field
        )));
    }
    Ok(parsed)
}

/// Parse a boolean field (e.g. `_SUPPORTS_IMAGE`). Accepts common truthy/falsy
/// spellings so `true/false`, `1/0`, `yes/no`, and `on/off` all work.
fn parse_bool(name: &str, field: &str, value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(EvotError::Conf(format!(
            "EVOT_LLM_{}{} must be a boolean (true/false), got '{}'",
            name.to_uppercase().replace('-', "_"),
            field,
            value
        ))),
    }
}
