//! Tests for runtime thinking-level cycling (Agent::cycle_thinking_level)
//! and session-level persistence (Session thinking_level round-trip).

use std::sync::Arc;

use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::RunEventPayload;
use evot::agent::SubmitOutcome;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::conf::StorageConfig;
use evot::models::SelectionReload;
use evot::sessions::Session;
use evot::storage::open_storage;
use evot::storage::MemoryStorage;
use evot_engine::provider::CompatCaps;
use evot_engine::provider::MockProvider;
use evot_engine::ThinkingLevel;
use tempfile::TempDir;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

fn anthropic_config(dir: &TempDir) -> Config {
    let mut config = Config::new(dir.path().to_path_buf());
    config
        .providers
        .insert("anthropic".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "test-key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-opus-4-6".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();
    config
}

#[test]
fn cycle_thinking_level_anthropic_walks_full_ramp_and_wraps() -> TestResult {
    let dir = TempDir::new()?;
    let agent = Agent::new(&anthropic_config(&dir), "/work")?;

    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);
    // Opus 4.6 defaults to high and only exposes explicitly declared stops.
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Max));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Off));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Low));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Medium));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::High));
    Ok(())
}

#[test]
fn cycle_thinking_level_starts_from_current_level() -> TestResult {
    let dir = TempDir::new()?;
    let agent = Agent::new(&anthropic_config(&dir), "/work")?;

    agent.set_thinking_level(ThinkingLevel::Medium);
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::High));
    Ok(())
}

#[test]
fn cycle_thinking_level_openai_without_effort_capability_is_inert() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    // A "deepseek" OpenAI-compat provider does not advertise reasoning effort.
    config.providers.insert("deepseek".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "https://api.deepseek.com".into(),
        models: vec!["deepseek-chat".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "deepseek".into();
    let agent = Agent::new(&config, "/work")?;

    assert!(agent.supported_thinking_levels().is_empty());
    assert_eq!(agent.cycle_thinking_level(), None);
    Ok(())
}

#[test]
fn cycle_thinking_level_openai_with_effort_capability() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("openai".into(), ProviderProfile {
        protocol: Protocol::OpenAiResponses,
        api_key: "test-key".into(),
        base_url: "https://api.openai.com/v1".into(),
        models: vec!["gpt-5.5".into()],
        compat_caps: CompatCaps::REASONING_EFFORT,
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "openai".into();
    let agent = Agent::new(&config, "/work")?;

    // gpt-5.5 does not declare an off value; only its explicit effort ramp is selectable.
    assert_eq!(agent.supported_thinking_levels(), vec![
        ThinkingLevel::Low,
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Xhigh,
    ]);
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::High));
    Ok(())
}

#[test]
fn cycle_thinking_level_gpt_5_5_pro_cycles_medium_high_xhigh() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("openai".into(), ProviderProfile {
        protocol: Protocol::OpenAiResponses,
        api_key: "test-key".into(),
        base_url: "https://api.openai.com/v1".into(),
        models: vec!["gpt-5.5-pro".into()],
        compat_caps: CompatCaps::REASONING_EFFORT,
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "openai".into();
    let agent = Agent::new(&config, "/work")?;

    // gpt-5.5-pro rejects off/minimal/low; medium is the floor.
    assert_eq!(agent.supported_thinking_levels(), vec![
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Xhigh,
    ]);
    // Cycling wraps within the restricted ramp.
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::High));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Xhigh));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Medium));
    Ok(())
}

#[test]
fn cycle_thinking_level_gpt_5_6_cycles_xhigh_then_max() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("openai".into(), ProviderProfile {
        protocol: Protocol::OpenAiResponses,
        api_key: "test-key".into(),
        base_url: "https://api.openai.com/v1".into(),
        models: vec!["gpt-5.6-sol".into()],
        compat_caps: CompatCaps::REASONING_EFFORT,
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "openai".into();
    let agent = Agent::new(&config, "/work")?;

    assert_eq!(agent.supported_thinking_levels(), vec![
        ThinkingLevel::Off,
        ThinkingLevel::Low,
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Xhigh,
        ThinkingLevel::Max,
    ]);
    agent.set_thinking_level(ThinkingLevel::High);
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Xhigh));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Max));
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Off));
    Ok(())
}

#[test]
fn model_switch_preserves_or_clamps_thinking_and_fails_fast() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = anthropic_config(&dir);
    config.providers.insert("openai".into(), ProviderProfile {
        protocol: Protocol::OpenAiResponses,
        api_key: "test-key".into(),
        base_url: "https://api.openai.com/v1".into(),
        models: vec!["gpt-5.5-pro".into()],
        compat_caps: CompatCaps::REASONING_EFFORT,
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.providers.insert("deepseek".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "https://api.deepseek.com".into(),
        models: vec!["deepseek-chat".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });

    let agent = Agent::new(&config, "/work")?;

    // gpt-5.5-pro has a Medium floor. Pi-compatible clamping searches upward
    // first, so an inherited Low becomes Medium rather than a config default.
    agent.set_thinking_level(ThinkingLevel::Low);
    agent.set_model_by_spec(&config, "gpt-5.5-pro")?;
    assert_eq!(agent.llm().provider, "openai");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Medium);

    // A supported session preference survives a provider/model switch.
    agent.set_thinking_level(ThinkingLevel::High);
    agent.set_model_by_spec(&config, "claude-opus-4-6")?;
    assert_eq!(agent.llm().provider, "anthropic");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);

    // Models without selectable reasoning clamp to Off.
    agent.set_model_by_spec(&config, "deepseek-chat")?;
    assert_eq!(agent.llm().provider, "deepseek");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Off);

    // Unknown model specs fail before mutating active state, whether bare or
    // provider-qualified.
    let before = agent.llm();
    assert!(agent.set_model_by_spec(&config, "missing-model").is_err());
    assert!(agent
        .set_model_by_spec(&config, "missing-provider:model")
        .is_err());
    assert_eq!(agent.llm().provider, before.provider);
    assert_eq!(agent.llm().model, before.model);
    Ok(())
}

#[test]
fn select_by_spec_follows_model_after_provider_regroup() -> TestResult {
    // A /model picker built against `evot-pro-openai:gpt-6.1-sol` hands that
    // spec back after the catalog merged the group into `evot-pro`. The exact
    // model id is what the user chose, so it must land there, while a
    // qualified spec whose model nobody lists still fails.
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("evot-pro".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "evot.scoped.key".into(),
        base_url: "https://auto.evot.ai/v1/llm".into(),
        models: vec!["gpt-6.1-sol".into(), "claude-opus-4-6".into()],
        compat_caps: CompatCaps::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.cloud_providers.insert("evot-pro".into());
    config.llm.provider = "evot-pro".into();
    config.llm.model_override = Some("claude-opus-4-6".into());

    let agent = Agent::new(&config, "/work")?;
    assert_eq!(agent.llm().model, "claude-opus-4-6");
    agent.set_model_by_spec(&config, "evot-pro-openai:gpt-6.1-sol")?;
    assert_eq!(agent.llm().provider, "evot-pro");
    assert_eq!(agent.llm().model, "gpt-6.1-sol");

    assert!(agent
        .set_model_by_spec(&config, "evot-pro-openai:gpt-6.1-nowhere")
        .is_err());
    assert_eq!(agent.llm().model, "gpt-6.1-sol");
    Ok(())
}

#[test]
fn cloud_catalog_thinking_level_wins_on_model_switch() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = anthropic_config(&dir);
    config
        .providers
        .insert("evot-free".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "evot.scoped.key".into(),
            base_url: "http://localhost:8787/v1/llm".into(),
            models: vec!["ox-alpha".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config
        .cloud_thinking_levels
        .insert("ox-alpha".into(), ThinkingLevel::Max);

    let built = config.build_llm("evot-free", Some("ox-alpha".into()))?;
    assert_eq!(built.thinking_level, ThinkingLevel::Max);

    let agent = Agent::new(&config, "/work")?;
    agent.set_thinking_level(ThinkingLevel::Low);
    agent.set_model_by_spec(&config, "evot-free:ox-alpha")?;
    assert_eq!(agent.llm().provider, "evot-free");
    assert_eq!(agent.llm().model, "ox-alpha");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Max);
    Ok(())
}

#[test]
fn cloud_openai_grok_cycles_thinking_levels() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config
        .providers
        .insert("evot-pro-openai".into(), ProviderProfile {
            protocol: Protocol::OpenAi,
            api_key: "evot.scoped.key".into(),
            base_url: "https://auto.evot.ai/v1/llm".into(),
            models: vec!["grok-4.6".into()],
            compat_caps: CompatCaps::REASONING_EFFORT,
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.cloud_providers.insert("evot-pro-openai".into());
    config
        .cloud_thinking_levels
        .insert("grok-4.6".into(), ThinkingLevel::Max);
    config.llm.provider = "evot-pro-openai".into();

    let agent = Agent::new(&config, "/work")?;
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Xhigh);
    assert_eq!(agent.supported_thinking_levels(), vec![
        ThinkingLevel::Low,
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Xhigh,
    ]);
    assert_eq!(agent.cycle_thinking_level(), Some(ThinkingLevel::Low));
    Ok(())
}

#[test]
fn resume_reload_reapplies_current_configured_thinking_level() -> TestResult {
    let dir = TempDir::new()?;
    let mut initial = anthropic_config(&dir);
    initial
        .providers
        .get_mut("anthropic")
        .ok_or("missing anthropic provider")?
        .thinking_level = Some(ThinkingLevel::Low);
    let agent = Agent::new(&initial, "/work")?;
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Low);

    // Simulate the historical value carried by a session, then an external
    // config edit made before that session is resumed.
    agent.set_thinking_level(ThinkingLevel::Minimal);
    let mut reloaded = initial;
    reloaded
        .providers
        .get_mut("anthropic")
        .ok_or("missing anthropic provider")?
        .thinking_level = Some(ThinkingLevel::High);

    assert!(agent.reload_provider_for_resume(&reloaded, "anthropic:claude-opus-4-6")?);
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);

    // If the session's saved selection disappeared, refresh the current live
    // selection from the same config snapshot instead of retaining stale effort.
    agent.set_thinking_level(ThinkingLevel::Minimal);
    assert!(!agent.reload_provider_for_resume(&reloaded, "missing:model")?);
    assert_eq!(agent.llm().provider, "anthropic");
    assert_eq!(agent.llm().model, "claude-opus-4-6");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);

    // If neither saved nor live selection resolves, fail without mutation.
    let empty = Config::new(dir.path().to_path_buf());
    let before = agent.llm();
    assert!(agent
        .reload_provider_for_resume(&empty, "missing:model")
        .is_err());
    assert_eq!(agent.llm().provider, before.provider);
    assert_eq!(agent.llm().model, before.model);
    assert_eq!(agent.llm().thinking_level, before.thinking_level);
    Ok(())
}

/// The shared reload rule: a still-served selection is kept (so re-minting a
/// scoped key cannot move a running session), a dropped one yields to the
/// config's active selection, and an empty config leaves no model at all.
#[test]
fn reload_selection_keeps_served_switches_dropped_and_clears_empty() -> TestResult {
    let dir = TempDir::new()?;
    let initial = anthropic_config(&dir);
    let agent = Agent::new(&initial, "/work")?;

    // Same provider, re-read with a rotated key: the live model must survive
    // even though another model now heads the provider's list.
    let mut rotated = anthropic_config(&dir);
    if let Some(profile) = rotated.providers.get_mut("anthropic") {
        profile.api_key = "rotated-key".into();
        profile.models = vec!["claude-haiku-4-6".into(), "claude-opus-4-6".into()];
    }
    assert_eq!(agent.reload_selection(&rotated), SelectionReload::Kept);
    assert_eq!(agent.llm().model, "claude-opus-4-6");
    assert_eq!(agent.llm().api_key, "rotated-key");

    let mut replacement = Config::new(dir.path().to_path_buf());
    replacement
        .providers
        .insert("deepseek".into(), ProviderProfile {
            protocol: Protocol::OpenAi,
            api_key: "replacement-key".into(),
            base_url: "https://api.deepseek.com".into(),
            models: vec!["deepseek-chat".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    replacement.llm.provider = "deepseek".into();

    assert_eq!(
        agent.reload_selection(&replacement),
        SelectionReload::Switched
    );
    assert_eq!(agent.llm().provider, "deepseek");
    assert_eq!(agent.llm().model, "deepseek-chat");

    // Logged out with no BYOK left: a model that can only 401 is worse than
    // none, so the agent reports it has nothing.
    let empty = Config::new(dir.path().to_path_buf());
    let landing = agent.reload_selection(&empty);
    assert_eq!(landing, SelectionReload::Unconfigured);
    assert!(!landing.has_model());
    assert_eq!(agent.llm().provider, "");
    assert_eq!(agent.llm().model, "");
    Ok(())
}

/// A cloud selection is only kept while the catalog still lists it: the server
/// owns that list, so a retired model must not linger on a key refresh.
#[test]
fn reload_selection_drops_cloud_models_the_catalog_retired() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config
        .providers
        .insert("evot-free".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "evot.scoped.token".into(),
            base_url: "https://auto.evot.ai/v1/llm".into(),
            models: vec!["landing-model".into(), "grok-4-6".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.cloud_providers.insert("evot-free".into());
    config.cloud_model_sorts.insert("landing-model".into(), 100);
    config.llm.provider = "evot-free".into();

    let agent = Agent::new(&config, "/work")?;
    // A fresh session lands on the top-ranked model, then the user switches.
    assert_eq!(agent.llm().model, "landing-model");
    agent.set_model_by_spec(&config, "grok-4-6")?;

    // Key recovery re-reads the same catalog: the chosen model stays put.
    assert_eq!(agent.reload_selection(&config), SelectionReload::Kept);
    assert_eq!(agent.llm().model, "grok-4-6");

    // The catalog drops that model: now the landing spot legitimately wins.
    let mut retired = config.clone();
    if let Some(profile) = retired.providers.get_mut("evot-free") {
        profile.models = vec!["landing-model".into()];
    }
    assert_eq!(agent.reload_selection(&retired), SelectionReload::Switched);
    assert_eq!(agent.llm().model, "landing-model");
    Ok(())
}

fn cloud_profile(models: &[&str]) -> ProviderProfile {
    ProviderProfile {
        protocol: Protocol::Anthropic,
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

/// The user picks a model id, not a catalog group. When the server moves that
/// id from the free group to a premium group the account can use, a reload
/// must follow the id there instead of jumping to the premium default.
#[test]
fn reload_selection_follows_model_id_moved_between_cloud_groups() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert(
        "evot-free".into(),
        cloud_profile(&["stealth/union-alpha", "kimi-k3"]),
    );
    config.providers.insert(
        "evot-pro-anthropic".into(),
        cloud_profile(&["gpt-5.6-sol", "claude-fable-5.1"]),
    );
    config.cloud_providers.insert("evot-free".into());
    config.cloud_providers.insert("evot-pro-anthropic".into());
    config.cloud_model_sorts.insert("gpt-5.6-sol".into(), 100);
    config.llm.provider = "evot-pro-anthropic".into();

    let agent = Agent::new(&config, "/work")?;
    assert_eq!(agent.llm().model, "gpt-5.6-sol");
    agent.set_model_by_spec(&config, "kimi-k3")?;
    agent.set_thinking_level(ThinkingLevel::High);
    assert_eq!(agent.llm().provider, "evot-free");

    // Catalog sync: kimi-k3 leaves the free group and lands in the premium one.
    let mut moved = config.clone();
    if let Some(profile) = moved.providers.get_mut("evot-free") {
        profile.models = vec!["stealth/union-alpha".into()];
    }
    if let Some(profile) = moved.providers.get_mut("evot-pro-anthropic") {
        profile.models.push("kimi-k3".into());
    }
    assert_eq!(agent.reload_selection(&moved), SelectionReload::Followed);
    assert_eq!(agent.llm().provider, "evot-pro-anthropic");
    assert_eq!(agent.llm().model, "kimi-k3");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);

    // The next sync repeats the same catalog: nothing moves again.
    assert_eq!(agent.reload_selection(&moved), SelectionReload::Kept);
    assert_eq!(agent.llm().provider, "evot-pro-anthropic");

    // Only a real retirement of the id falls back to the ranked default.
    let mut retired = moved.clone();
    if let Some(profile) = retired.providers.get_mut("evot-pro-anthropic") {
        profile.models.retain(|m| m != "kimi-k3");
    }
    assert_eq!(agent.reload_selection(&retired), SelectionReload::Switched);
    assert_eq!(agent.llm().model, "gpt-5.6-sol");
    Ok(())
}

/// A BYOK provider accepts arbitrary model ids, so it must not "capture" a
/// retired cloud id merely because it is configured with a key.
#[test]
fn reload_selection_does_not_follow_into_byok_without_explicit_listing() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = anthropic_config(&dir);
    config
        .providers
        .insert("evot-free".into(), cloud_profile(&["kimi-k3"]));
    config.cloud_providers.insert("evot-free".into());
    let agent = Agent::new(&config, "/work")?;
    agent.set_model_by_spec(&config, "kimi-k3")?;
    assert_eq!(agent.llm().provider, "evot-free");

    let mut retired = config.clone();
    if let Some(profile) = retired.providers.get_mut("evot-free") {
        profile.models.clear();
    }
    assert_eq!(agent.reload_selection(&retired), SelectionReload::Switched);
    assert_ne!(agent.llm().model, "kimi-k3");
    Ok(())
}

#[test]
fn explicit_thinking_restore_api_remains_supported() -> TestResult {
    let dir = TempDir::new()?;
    let agent = Agent::new(&anthropic_config(&dir), "/work")?;

    agent.restore_thinking_level("high");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);
    agent.restore_thinking_level("invalid");
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);
    Ok(())
}

#[tokio::test]
async fn session_thinking_level_round_trips_through_storage() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    // A fresh session has no recorded level.
    let session = Session::new_with_source(
        "sess-think".into(),
        "/work".into(),
        "claude-opus-4-6".into(),
        "repl",
        storage.clone(),
    )
    .await?;
    assert_eq!(session.meta().await.thinking_level, None);

    // Stamp + persist, mirroring what a run does via resolve_session + save.
    session.set_thinking_level(Some("high".into())).await;
    session.save().await?;

    // Re-open from storage: the level survives.
    let reopened = Session::open("sess-think", storage)
        .await?
        .ok_or("session missing after save")?;
    assert_eq!(
        reopened.meta().await.thinking_level,
        Some("high".to_string())
    );
    Ok(())
}

#[tokio::test]
async fn pinned_request_model_survives_live_model_changes() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = anthropic_config(&dir);
    let profile = config
        .providers
        .get_mut("anthropic")
        .ok_or("missing anthropic profile")?;
    profile.models = vec!["claude-opus-4-6".into(), "claude-sonnet-4-6".into()];

    let storage = Arc::new(MemoryStorage::new());
    let agent =
        Agent::new_with_provider_for_test(&config, "/work", storage, MockProvider::text("ok"))?;
    let pinned =
        agent.select_configured_model(&config, "anthropic", "claude-opus-4-6", Some("max"))?;
    let live = config.build_llm("anthropic", Some("claude-sonnet-4-6".into()))?;

    // Simulate another Chat request changing the live default after this
    // request captured its selection but before submit starts its run.
    let request = QueryRequest::text("keep the pinned model").llm(pinned);
    agent.set_llm(live);
    let outcome = agent.submit(request).await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(format!("unexpected command outcome: {message}").into());
        }
    };
    let session_id = run.session_id.clone();
    let mut started_model = None;
    while let Some(event) = run.next().await {
        if let RunEventPayload::LlmCallStarted { model, .. } = event.payload {
            started_model = Some(model);
        }
    }

    assert_eq!(started_model.as_deref(), Some("claude-opus-4-6"));
    let meta = agent
        .sessions()
        .find(&session_id)
        .await?
        .ok_or("pinned run did not persist its session")?;
    assert_eq!(meta.provider, "anthropic");
    assert_eq!(meta.model, "claude-opus-4-6");
    assert_eq!(meta.thinking_level.as_deref(), Some("max"));
    let transcript = agent.sessions().transcript(&session_id).await?;
    assert!(transcript.iter().any(|item| matches!(item,
        evot::types::TranscriptItem::Stats { kind, data }
            if kind == "llm_call_started" && data["thinking_level"] == "max")));
    // The live selection remains available as the next request's default.
    assert_eq!(agent.llm().model, "claude-sonnet-4-6");
    Ok(())
}

/// Sessions persisted before the `thinking_level` field existed deserialize
/// with `None` rather than failing (serde default).
#[test]
fn session_meta_without_thinking_level_deserializes() -> TestResult {
    use evot::types::SessionMeta;
    let legacy = r#"{
        "session_id": "old",
        "cwd": "/work",
        "model": "claude-opus-4-6",
        "title": null,
        "turns": 0,
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z"
    }"#;
    let meta: SessionMeta = serde_json::from_str(legacy)?;
    assert_eq!(meta.thinking_level, None);
    let _ = Arc::new(meta);
    Ok(())
}
