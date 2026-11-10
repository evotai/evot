use indexmap::IndexMap;

use super::source::ProviderSource;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::infer_protocol;
use crate::conf::parse_protocol;
use crate::conf::thinking_level_from_str;
use crate::conf::ProviderProfile;

pub(super) fn normalize_provider_name(name: &str) -> String {
    name.to_lowercase()
}

/// Validate that a provider name is legal (no `:` allowed).
pub(super) fn validate_provider_name(name: &str) -> Result<()> {
    if name.contains(':') {
        return Err(EvotError::Conf(format!(
            "provider name '{}' must not contain ':'",
            name
        )));
    }
    Ok(())
}

/// Merge a ProviderSource into the providers IndexMap.
/// If the provider already exists, only overwrite fields that are Some.
/// If new, insert with inferred protocol.
pub(super) fn merge_provider_source(
    providers: &mut IndexMap<String, ProviderProfile>,
    name: &str,
    src: ProviderSource,
) -> Result<()> {
    let name = normalize_provider_name(name);
    validate_provider_name(&name)?;
    if let Some(profile) = providers.get_mut(&name) {
        if let Some(protocol) = src.protocol {
            profile.protocol = parse_protocol(&protocol)?;
        }
        if let Some(api_key) = src.api_key {
            profile.api_key = api_key;
        }
        if let Some(base_url) = src.base_url {
            profile.base_url = base_url;
        }
        if let Some(model) = src.model {
            profile.models = model;
        }
        if let Some(capabilities) = src.compat_caps {
            profile.compat_caps = capabilities.transport;
            profile.route_capabilities = capabilities.route;
        }
        if let Some(level) = src.thinking_level {
            profile.thinking_level = Some(thinking_level_from_str(&level)?);
        }
        if let Some(context_window) = src.context_window {
            profile.context_window = Some(context_window);
        }
        if let Some(max_tokens) = src.max_tokens {
            profile.max_tokens = Some(max_tokens);
        }
        if let Some(supports_image) = src.supports_image {
            profile.supports_image = Some(supports_image);
        }
    } else {
        let protocol = match src.protocol {
            Some(p) => parse_protocol(&p)?,
            None => infer_protocol(&name),
        };
        let thinking_level = match src.thinking_level {
            Some(level) => Some(thinking_level_from_str(&level)?),
            None => None,
        };
        let capabilities = src.compat_caps.unwrap_or_default();
        providers.insert(name, ProviderProfile {
            protocol,
            api_key: src.api_key.unwrap_or_default(),
            base_url: src.base_url.unwrap_or_default(),
            models: src.model.unwrap_or_default(),
            compat_caps: capabilities.transport,
            route_capabilities: capabilities.route,
            thinking_level,
            context_window: src.context_window,
            max_tokens: src.max_tokens,
            supports_image: src.supports_image,
        });
    }
    Ok(())
}
