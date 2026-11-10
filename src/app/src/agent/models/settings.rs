use crate::agent::models::ModelSelection;
use crate::agent::Agent;
use crate::base::error::Result;
use crate::conf::Config;

/// Change the live selection, then best-effort persist the default for future
/// sessions. Failure to save must not undo a successful live selection change.
pub fn cycle_thinking_level(agent: &Agent, env_file: &str) -> Option<String> {
    let level = agent.cycle_thinking_level()?;
    persist_default(agent, env_file, level);
    Some(ModelSelection::display_thinking_level_for(&agent.llm()))
}

/// Reject unsupported levels without changing either the live or saved state.
pub fn set_thinking_level(agent: &Agent, env_file: &str, level: &str) -> Option<String> {
    let parsed = crate::conf::thinking_level_from_str(level).ok()?;
    if !agent.supported_thinking_levels().contains(&parsed) {
        return None;
    }
    agent.set_thinking_level(parsed);
    persist_default(agent, env_file, parsed);
    Some(ModelSelection::display_thinking_level_for(&agent.llm()))
}

/// Outcome of asking to make a model the account default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinOutcome {
    /// The server accepted the pin and the local catalog cache reflects it.
    Pinned(String),
    /// The model is BYOK (or nobody is logged in): a server pin does not
    /// apply. Local `EVOT_LLM_PROVIDER` already keeps that choice.
    NotCloud,
}

/// Make a cloud model the account's landing model for future sessions. The
/// live selection is untouched: pinning is a preference for *next* time, not
/// a switch now.
///
/// Double write, like thinking levels: the server owns the preference (so every
/// machine follows it), and the local `models.cache.json` is patched so the very
/// next `evot` start honours the pin without waiting for a catalog resync.
pub async fn pin_default_model(env_file: &str, provider: &str, model: &str) -> Result<PinOutcome> {
    let config = Config::load_with_env_file(Some(env_file))?;
    if !config.cloud_providers.iter().any(|p| p == provider) {
        return Ok(PinOutcome::NotCloud);
    }
    let Some(auth) = crate::auth::load_auth()? else {
        return Ok(PinOutcome::NotCloud);
    };
    crate::auth::client::set_default_model(&auth, model).await?;
    if let Some(mut cache) = crate::auth::load_models_cache()? {
        cache.response.default_model = model.to_string();
        crate::auth::save_models_cache(&cache)?;
    }
    Ok(PinOutcome::Pinned(model.to_string()))
}

fn persist_default(agent: &Agent, env_file: &str, level: evot_engine::ThinkingLevel) {
    if let Ok(mut config) = Config::load_with_env_file(Some(env_file)) {
        let provider = agent.llm().provider.clone();
        let _ = crate::conf::persist_default_thinking_level(&mut config, &provider, level);
    }
}
