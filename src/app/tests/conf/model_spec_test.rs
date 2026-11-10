//! Persisted `provider:model` specs survive catalog regrouping, and a cloud
//! group named by tier routes each model by its own wire protocol.

use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot_engine::provider::ApiProtocol;
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn cloud_profile(protocol: Protocol, models: &[&str]) -> ProviderProfile {
    ProviderProfile {
        protocol,
        api_key: "evot.scoped.token".into(),
        base_url: "https://auto.evot.ai/v1/llm".into(),
        models: models.iter().map(|m| (*m).to_string()).collect(),
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    }
}

fn byok_profile(models: &[&str]) -> ProviderProfile {
    ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "sk-user".into(),
        base_url: "https://openrouter.ai/api/v1".into(),
        models: models.iter().map(|m| (*m).to_string()).collect(),
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    }
}

/// Today's catalog: one `evot-pro` group mixing both protocols.
fn tier_named_config(dir: &TempDir) -> Config {
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert(
        "evot-pro".into(),
        cloud_profile(Protocol::Anthropic, &[
            "evot-fast",
            "claude-fable-5.1",
            "grok-4.7",
        ]),
    );
    config.cloud_providers.insert("evot-pro".into());
    config
        .cloud_model_protocols
        .insert("evot-fast".into(), Protocol::Anthropic);
    config
        .cloud_model_protocols
        .insert("claude-fable-5.1".into(), Protocol::Anthropic);
    config
        .cloud_model_protocols
        .insert("grok-4.7".into(), Protocol::OpenAi);
    config.llm.provider = "evot-pro".into();
    config
}

/// A model promoted to another tier keeps its saved spec resolvable.
#[test]
fn persisted_spec_follows_model_id_between_tiers() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = tier_named_config(&dir);
    config.providers.insert(
        "evot-free".into(),
        cloud_profile(Protocol::Anthropic, &["kimi-k3"]),
    );
    config.cloud_providers.insert("evot-free".into());

    let (provider, model) = config.resolve_persisted_model_spec("evot-free:evot-fast")?;
    assert_eq!(
        (provider.as_str(), model.as_str()),
        ("evot-pro", "evot-fast")
    );
    Ok(())
}

/// Specs saved while the server split a tier per protocol
/// (`evot-pro-anthropic`, `evot-pro-openai`) resolve against today's
/// tier-named group, and the other way round.
#[test]
fn persisted_spec_survives_cloud_group_renaming() -> TestResult {
    let dir = TempDir::new()?;
    let config = tier_named_config(&dir);
    assert_eq!(
        config.resolve_persisted_model_spec("evot-pro-anthropic:evot-fast")?,
        ("evot-pro".to_string(), "evot-fast".to_string())
    );
    assert_eq!(
        config.resolve_persisted_model_spec("evot-pro-openai:grok-4.7")?,
        ("evot-pro".to_string(), "grok-4.7".to_string())
    );

    let mut split = Config::new(dir.path().to_path_buf());
    split.providers.insert(
        "evot-pro-openai".into(),
        cloud_profile(Protocol::OpenAi, &["grok-4.7"]),
    );
    split.cloud_providers.insert("evot-pro-openai".into());
    assert_eq!(
        split.resolve_persisted_model_spec("evot-pro:grok-4.7")?,
        ("evot-pro-openai".to_string(), "grok-4.7".to_string())
    );
    Ok(())
}

#[test]
fn persisted_bare_model_id_resolves_to_its_provider() -> TestResult {
    let dir = TempDir::new()?;
    let config = tier_named_config(&dir);
    assert_eq!(
        config.resolve_persisted_model_spec("grok-4.7")?,
        ("evot-pro".to_string(), "grok-4.7".to_string())
    );
    Ok(())
}

#[test]
fn persisted_spec_that_still_resolves_is_kept_as_written() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = tier_named_config(&dir);
    config
        .providers
        .insert("openrouter".into(), byok_profile(&["evot-fast"]));

    // Both providers list the id; the saved one wins, no migration.
    let (provider, _) = config.resolve_persisted_model_spec("openrouter:evot-fast")?;
    assert_eq!(provider, "openrouter");
    let (provider, _) = config.resolve_persisted_model_spec("evot-pro:evot-fast")?;
    assert_eq!(provider, "evot-pro");
    Ok(())
}

/// A BYOK provider accepts any id, so it must never capture a cloud model
/// whose group went away.
#[test]
fn persisted_spec_does_not_migrate_into_byok_without_explicit_listing() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = tier_named_config(&dir);
    config
        .providers
        .insert("openrouter".into(), byok_profile(&["deepseek-chat"]));

    let error = match config.resolve_persisted_model_spec("evot-free:kimi-k3") {
        Ok(pair) => return Err(format!("unexpectedly resolved to {pair:?}").into()),
        Err(error) => error.to_string(),
    };
    assert!(
        error.contains("evot-free"),
        "error names the saved provider: {error}"
    );
    Ok(())
}

/// Cloud groups are one per tier; the protocol comes from the model.
#[test]
fn cloud_group_routes_each_model_by_its_own_protocol() -> TestResult {
    let dir = TempDir::new()?;
    let config = tier_named_config(&dir);

    let anthropic = config.build_llm("evot-pro", Some("claude-fable-5.1".into()))?;
    assert_eq!(anthropic.protocol, Protocol::Anthropic);
    assert_eq!(
        anthropic.model_config.protocol(),
        ApiProtocol::AnthropicMessages
    );

    let openai = config.build_llm("evot-pro", Some("grok-4.7".into()))?;
    assert_eq!(openai.protocol, Protocol::OpenAi);
    assert_eq!(
        openai.model_config.protocol(),
        ApiProtocol::OpenAiCompletions
    );
    // The gateway forwards reasoning_effort for OpenAI-protocol models.
    assert!(openai.model_config.honors_reasoning_effort());
    Ok(())
}

#[test]
fn cloud_model_without_published_protocol_falls_back_to_group_protocol() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = tier_named_config(&dir);
    config.cloud_model_protocols.remove("grok-4.7");

    let llm = config.build_llm("evot-pro", Some("grok-4.7".into()))?;
    assert_eq!(llm.protocol, Protocol::Anthropic);
    Ok(())
}

/// Per-model protocols are catalog state; a BYOK profile that happens to list
/// the same id keeps the protocol it was configured with.
#[test]
fn byok_profile_ignores_cloud_model_protocols() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = tier_named_config(&dir);
    config
        .providers
        .insert("openrouter".into(), byok_profile(&["claude-fable-5.1"]));

    let llm = config.build_llm("openrouter", Some("claude-fable-5.1".into()))?;
    assert_eq!(llm.protocol, Protocol::OpenAi);
    Ok(())
}
