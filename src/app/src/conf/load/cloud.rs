use evot_engine::provider::CompatCaps;
use evot_engine::provider::RouteCapabilityOverrides;

use super::env_keys::parse_provider_env_key;
use super::providers::normalize_provider_name;
use super::providers::validate_provider_name;
use crate::conf::parse_protocol;
use crate::conf::provider_to_env_name;
use crate::conf::thinking_level_from_str;
use crate::conf::Config;
use crate::conf::Protocol;
use crate::conf::ProviderProfile;
use crate::error::EvotError;
use crate::error::Result;

fn url_host(url: &str) -> &str {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))
        .unwrap_or_else(|| url.trim());
    rest.split(['/', '?'])
        .next()
        .unwrap_or("")
        .trim_matches('.')
}

fn is_cloud_base_url(base_url: &str) -> bool {
    let host = url_host(base_url);
    if host.is_empty() {
        return false;
    }
    let default_host = url_host(crate::auth::DEFAULT_SERVER_URL);
    if host.eq_ignore_ascii_case(default_host) {
        return true;
    }
    std::env::var("EVOT_SERVER_URL")
        .ok()
        .is_some_and(|configured| host.eq_ignore_ascii_case(url_host(&configured)))
}

fn is_stale_cloud_profile(profile: &ProviderProfile) -> bool {
    // Endpoint alone is not ownership: a user may deliberately route a custom
    // provider through the same host. Only credentials issued by evot plus a
    // cloud endpoint identify a provider persisted by an older client.
    is_cloud_base_url(&profile.base_url) && profile.api_key.trim().starts_with("evot.")
}

pub(super) fn reconcile_cloud_env(
    config: &mut Config,
    env_file_vars: &[(String, String)],
    transaction: &crate::conf::env_transaction::EnvTransaction,
) {
    let stale: Vec<String> = env_file_vars
        .iter()
        .filter_map(|(key, _)| parse_provider_env_key(key).map(|(name, _)| name))
        .filter(|name| {
            config.cloud_providers.contains(name)
                || config
                    .providers
                    .get(name)
                    .is_some_and(is_stale_cloud_profile)
        })
        .collect();
    if stale.is_empty() {
        return;
    }

    for name in &stale {
        if !config.cloud_providers.contains(name) {
            config.providers.shift_remove(name);
        }
    }

    let prefixes: Vec<String> = stale
        .iter()
        .map(|name| format!("EVOT_LLM_{}_", provider_to_env_name(name)))
        .collect();
    match crate::conf::env_writer::remove_keys_locked(transaction, |key| {
        prefixes.iter().any(|prefix| key.starts_with(prefix))
    }) {
        Ok(true) => tracing::info!(
            "removed server-managed provider keys from {}: {}",
            config.env_file_path.display(),
            stale.join(", ")
        ),
        Ok(false) => {}
        Err(error) => tracing::warn!(
            "could not clean server-managed provider keys from {}: {error}",
            config.env_file_path.display()
        ),
    }
}

/// Register the cloud providers from the models cache when the user is logged
/// in. Cached-only: no network at config load time; `evot login` refreshes the
/// cache. Never overrides an explicit BYOK selection.
///
/// The server names, orders, and groups its own providers, one per tier
/// (`evot-free`, `evot-pro`). A tier may mix Anthropic and OpenAI models: the
/// protocol is published per model and [`Config::protocol_for`] routes by it,
/// so the group name stays a stable identity for saved sessions and tasks.
/// Older servers split a mixed tier into `<tier>-<protocol>` groups; those
/// register under the name they arrive with, and a saved spec follows its
/// model id via [`Config::resolve_persisted_model_spec`]. Which model a fresh
/// session lands on is decided by catalog rank in
/// [`Config::preferred_new_session_llm`], not here.
pub(super) fn apply_cloud_provider(config: &mut Config) -> Result<()> {
    if crate::auth::load_auth()?.is_none() {
        return Ok(());
    }
    let Some(cache) = crate::auth::load_models_cache()? else {
        return Ok(());
    };

    let mut thinking_levels = std::collections::HashMap::new();
    let mut model_tiers = std::collections::HashMap::new();
    let mut model_sorts = std::collections::HashMap::new();
    let mut model_capabilities = std::collections::HashMap::new();
    let context_windows = context_windows(&cache.response);
    let model_protocols = model_protocols(&cache.response);
    let non_chat_models: std::collections::HashSet<String> = cache
        .response
        .models
        .iter()
        .filter(|model| !model.is_chat())
        .map(|model| model.id.clone())
        .collect();
    for model in &cache.response.models {
        if let Ok(level) = thinking_level_from_str(&model.thinking_level) {
            thinking_levels.insert(model.id.clone(), level);
        }
        if !model.tier.is_empty() {
            model_tiers.insert(model.id.clone(), model.tier.clone());
        }
        model_sorts.insert(model.id.clone(), model.sort_order);
        model_capabilities.insert(
            model.id.clone(),
            crate::conf::config::CloudModelCapabilities {
                profile: model.capability_profile.trim().to_string(),
                max_output_tokens: model.max_output_tokens.filter(|value| *value > 0),
            },
        );
    }
    // Providers are stored in server rank order, so ties in catalog rank fall
    // back to the order the server wants its groups shown in.
    let mut groups = cache.response.providers;
    groups.sort_by_key(|group| group.sort_order);
    for mut group in groups {
        let name = normalize_provider_name(&group.name);
        validate_provider_name(&name)?;
        let protocol = parse_protocol(&group.protocol).map_err(|_| {
            EvotError::Conf(format!("unsupported cloud protocol: {}", group.protocol))
        })?;
        // Ignore retired auxiliary endpoints even when an old catalog still
        // publishes them. Unannotated historical chat entries remain usable.
        group
            .models
            .retain(|model| !non_chat_models.contains(model));
        if group.models.is_empty() {
            continue;
        }
        // A catalog routing name is not ownership. If the user already has a
        // custom provider with that name, keep it; only replace a profile that
        // is identifiable as cloud state persisted by an older client.
        let custom_collision = config
            .providers
            .get(&name)
            .is_some_and(|profile| !is_stale_cloud_profile(profile));
        if custom_collision {
            tracing::warn!(provider = %name, "cloud provider name collides with custom provider; keeping custom config");
            continue;
        }

        // The group protocol is only the fallback for a model the catalog
        // did not annotate; transport quirks are decided per route in
        // `Config::build_llm`.
        let profile = ProviderProfile {
            protocol,
            api_key: group.api_key,
            base_url: group.base_url,
            models: group.models,
            compat_caps: CompatCaps::default(),
            route_capabilities: RouteCapabilityOverrides::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        };
        config.providers.insert(name.clone(), profile);
        config.cloud_providers.insert(name);
    }
    config.cloud_thinking_levels = thinking_levels;
    config.cloud_model_tiers = model_tiers;
    config.cloud_context_windows = context_windows;
    config.cloud_model_capabilities = model_capabilities;
    config.cloud_model_sorts = model_sorts;
    config.cloud_model_protocols = model_protocols;
    config.cloud_default_model =
        Some(cache.response.default_model.trim().to_string()).filter(|model| !model.is_empty());

    // The catalog owns the landing spot, so a stale cloud selection (e.g. a
    // Free provider left in the env file) yields to it. BYOK always wins: a
    // configured provider with its own key keeps serving.
    let byok_active = !config.cloud_providers.contains(&config.llm.provider)
        && config
            .providers
            .get(&config.llm.provider)
            .is_some_and(|profile| !profile.api_key.trim().is_empty());
    if byok_active {
        return Ok(());
    }
    if let Some((provider, _)) = config.preferred_new_session_llm() {
        config.llm.provider = provider;
        config.llm.model_override = None;
    }
    Ok(())
}

/// Context windows the server published, by model id.
fn context_windows(
    response: &crate::auth::ModelsResponse,
) -> std::collections::HashMap<String, u32> {
    response
        .models
        .iter()
        .filter_map(|model| Some((model.id.clone(), model.context_window()?)))
        .collect()
}

/// Wire protocols the server published, by model id. Models an older server
/// left unannotated are absent and inherit their group's protocol.
fn model_protocols(
    response: &crate::auth::ModelsResponse,
) -> std::collections::HashMap<String, Protocol> {
    response
        .models
        .iter()
        .filter_map(|model| Some((model.id.clone(), parse_protocol(&model.protocol).ok()?)))
        .collect()
}
