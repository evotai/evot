use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Barrier;

use evot::agent::models::ModelSelection;
use evot::agent::models::SelectionReload;
use evot::conf::Config;
use evot::conf::LlmConfig;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot_engine::ThinkingLevel;

type TestResult = Result<(), Box<dyn std::error::Error>>;

// Pure configuration: these tests construct neither Agent nor Storage and do
// not read user config, create state directories, or contact a provider.
fn config() -> Config {
    let mut config = Config::new(PathBuf::new());
    config
        .providers
        .insert("anthropic".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "fixture-key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-opus-4-6".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: Some(123_456),
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();
    config
}

fn assert_same_selection(actual: &LlmConfig, expected: &LlmConfig) {
    assert_eq!(actual.provider, expected.provider);
    assert_eq!(actual.model, expected.model);
    assert_eq!(actual.protocol, expected.protocol);
    assert_eq!(actual.api_key, expected.api_key);
    assert_eq!(actual.thinking_level, expected.thinking_level);
    assert_eq!(
        actual.model_config.context_window(),
        expected.model_config.context_window()
    );
}

#[test]
fn model_selection_snapshots_and_forks_are_independent() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(config.active_llm()?);
    let snapshot = selection.snapshot();
    let fork = ModelSelection::new(snapshot.clone());
    selection.set_thinking_level(ThinkingLevel::Low);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Low);
    assert_same_selection(&fork.snapshot(), &snapshot);
    assert_eq!(snapshot.thinking_level, ThinkingLevel::High);
    assert_eq!(selection.resolved_context_window(), 123_456);
    fork.set_thinking_level(ThinkingLevel::Max);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Low);
    Ok(())
}

#[test]
fn model_selection_failed_switch_and_resume_do_not_mutate() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(config.active_llm()?);
    selection.set_thinking_level(ThinkingLevel::Low);
    let before = selection.snapshot();
    for spec in ["missing", "missing:model"] {
        assert!(selection.select_by_spec(&config, spec).is_err());
        assert_same_selection(&selection.snapshot(), &before);
    }
    let empty = Config::new(PathBuf::new());
    assert!(selection
        .reload_provider_for_resume(&empty, "missing:model")
        .is_err());
    assert_same_selection(&selection.snapshot(), &before);
    Ok(())
}

#[test]
fn model_selection_switch_reload_and_resume_have_distinct_effort_policies() -> TestResult {
    let mut config = config();
    config
        .cloud_thinking_levels
        .insert("claude-opus-4-6".into(), ThinkingLevel::Max);
    let selection = ModelSelection::new(config.active_llm()?);
    selection.set_thinking_level(ThinkingLevel::Low);
    selection.select_by_spec(&config, "anthropic:claude-opus-4-6")?;
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Max);

    selection.set_thinking_level(ThinkingLevel::Low);
    let provider = config
        .providers
        .get_mut("anthropic")
        .ok_or("missing fixture provider")?;
    provider.api_key = "rotated-fixture-key".into();
    assert_eq!(selection.reload_selection(&config), SelectionReload::Kept);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Low);
    assert_eq!(selection.snapshot().api_key, "rotated-fixture-key");

    assert!(selection.reload_provider_for_resume(&config, "anthropic:claude-opus-4-6")?);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Max);
    selection.set_thinking_level(ThinkingLevel::Low);
    assert!(!selection.reload_provider_for_resume(&config, "missing:model")?);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Max);
    Ok(())
}

#[test]
fn model_selection_reload_can_land_configured_or_unconfigured() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(LlmConfig::unconfigured());
    assert_eq!(
        selection.reload_selection(&config),
        SelectionReload::Switched
    );
    assert_same_selection(&selection.snapshot(), &config.active_llm()?);
    let landing = selection.reload_selection(&Config::new(PathBuf::new()));
    assert_eq!(landing, SelectionReload::Unconfigured);
    assert!(!landing.has_model());
    assert_same_selection(&selection.snapshot(), &LlmConfig::unconfigured());
    Ok(())
}

#[test]
fn model_selection_explicit_unknown_byok_model_remains_supported() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(config.active_llm()?);
    selection.select_by_spec(&config, "anthropic:custom-model")?;
    assert_eq!(selection.snapshot().model, "custom-model");
    assert_eq!(selection.reload_selection(&config), SelectionReload::Kept);
    assert_eq!(selection.snapshot().model, "custom-model");
    Ok(())
}

#[test]
fn model_selection_restore_is_validated_but_explicit_setter_is_not() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(config.active_llm()?);
    selection.restore_thinking_level("low");
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Low);
    selection.restore_thinking_level("invalid");
    selection.restore_thinking_level("minimal");
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Low);
    selection.set_thinking_level(ThinkingLevel::Minimal);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::Minimal);
    selection.replace(config.active_llm()?);
    assert_eq!(selection.snapshot().thinking_level, ThinkingLevel::High);
    Ok(())
}

#[test]
fn model_selection_concurrent_cycles_are_not_lost() -> TestResult {
    let selection = Arc::new(ModelSelection::new(config().active_llm()?));
    selection.set_thinking_level(ThinkingLevel::Off);
    let levels = selection.supported_thinking_levels();
    let start = levels
        .iter()
        .position(|level| *level == ThinkingLevel::Off)
        .ok_or("missing off tier")?;
    let barrier = Arc::new(Barrier::new(4));
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let selection = Arc::clone(&selection);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..101 {
                    assert!(selection.cycle_thinking_level().is_some());
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().map_err(|_| "cycle worker panicked")?;
    }
    assert_eq!(
        selection.snapshot().thinking_level,
        levels[(start + 404) % levels.len()]
    );
    Ok(())
}

#[test]
fn configured_selection_rejects_invalid_input_without_mutation() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(config.active_llm()?);
    let before = selection.snapshot();
    for (provider, model, effort, error) in [
        (
            "missing",
            "claude-opus-4-6",
            None,
            "provider 'missing' is not configured",
        ),
        (
            "anthropic",
            "custom-model",
            None,
            "model 'custom-model' is not configured",
        ),
        (
            "anthropic",
            "claude-opus-4-6",
            Some("invalid"),
            "unknown thinking level",
        ),
        (
            "anthropic",
            "claude-opus-4-6",
            Some("minimal"),
            "thinking level 'minimal' is not supported",
        ),
    ] {
        let result = selection.select_configured(&config, provider, model, effort);
        let Err(actual) = result else {
            return Err("invalid configured selection succeeded".into());
        };
        assert!(actual.to_string().contains(error));
        assert_same_selection(&selection.snapshot(), &before);
    }
    // The interactive escape hatch is intentionally different from a picker.
    selection.select_by_spec(&config, "anthropic:custom-model")?;
    assert_eq!(selection.snapshot().model, "custom-model");
    Ok(())
}

#[test]
fn configured_selection_uses_defaults_or_explicit_effort_and_pins_snapshot() -> TestResult {
    let config = config();
    let selection = ModelSelection::new(config.active_llm()?);
    selection.set_thinking_level(ThinkingLevel::Low);
    let configured = selection.select_configured(&config, "anthropic", "claude-opus-4-6", None)?;
    assert_eq!(configured.thinking_level, ThinkingLevel::High);
    let pinned =
        selection.select_configured(&config, "anthropic", "claude-opus-4-6", Some("max"))?;
    assert_same_selection(&selection.snapshot(), &pinned);
    selection.set_thinking_level(ThinkingLevel::Low);
    assert_eq!(pinned.thinking_level, ThinkingLevel::Max);
    assert_eq!(configured.thinking_level, ThinkingLevel::High);
    Ok(())
}

#[test]
fn configured_selection_without_reasoning_rejects_effort() -> TestResult {
    let mut config = config();
    let profile = config
        .providers
        .get_mut("anthropic")
        .ok_or("missing fixture provider")?;
    profile.protocol = Protocol::OpenAi;
    profile.models = vec!["deepseek-chat".into()];
    profile.base_url = "https://api.deepseek.com".into();
    let selection = ModelSelection::new(config.active_llm()?);
    let snapshot = selection.select_configured(&config, "anthropic", "deepseek-chat", None)?;
    assert!(ModelSelection::supported_thinking_levels_for(&snapshot).is_empty());
    assert_eq!(ModelSelection::display_thinking_level_for(&snapshot), "");
    assert!(selection
        .select_configured(&config, "anthropic", "deepseek-chat", Some("high"))
        .is_err());
    assert_same_selection(&selection.snapshot(), &snapshot);
    Ok(())
}

#[test]
fn reasoning_label_uses_abstract_effort_and_does_not_clamp_explicit_overrides() -> TestResult {
    let selection = ModelSelection::new(config().active_llm()?);
    for level in [
        ThinkingLevel::Off,
        ThinkingLevel::High,
        ThinkingLevel::Max,
        ThinkingLevel::Minimal,
    ] {
        selection.set_thinking_level(level);
        assert_eq!(
            ModelSelection::display_thinking_level_for(&selection.snapshot()),
            level.as_str()
        );
    }
    Ok(())
}

#[test]
fn model_selection_dependency_boundary() {
    let service = include_str!("../../src/agent/models/selection.rs");
    for forbidden in [
        "crate::agent",
        "crate::session::storage",
        "crate::surface::gateway",
        "std::fs",
        "Config::load",
    ] {
        assert!(
            !service.contains(forbidden),
            "model selection depends on {forbidden}"
        );
    }
    let agent = include_str!("../../src/agent/agent.rs");
    assert!(agent.contains("selection: ModelSelection"));
    for source in [agent, include_str!("../../src/agent/agent_models.rs")] {
        assert!(!source.contains("llm: RwLock<LlmConfig>"));
        assert!(!source.contains("self.llm.read()"));
        assert!(!source.contains("self.llm.write()"));
    }
    let http = [
        include_str!("../../src/surface/gateway/channels/http/server.rs"),
        include_str!("../../src/surface/gateway/channels/http/server_chat.rs"),
        include_str!("../../src/surface/gateway/channels/http/server_settings.rs"),
    ]
    .concat();
    let http_compact: String = http.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(http_compact.contains("self.agent.select_configured_model("));
    assert!(!http.contains("thinking_level_from_str("));
    assert!(!http.contains("thinking level '{name}' is not supported"));
    let napi = include_str!("../../../../cli/addon/src/agent.rs");
    assert!(napi.contains("ModelSelection::display_thinking_level_for"));
    for source in [
        napi,
        include_str!("../../../../cli/addon/src/agent_models.rs"),
    ] {
        assert!(!source.contains("fn display_thinking_level("));
    }
}

#[test]
fn model_switch_remembers_the_replaced_selection_for_compaction() -> TestResult {
    let mut config = config();
    config
        .providers
        .get_mut("anthropic")
        .ok_or("missing fixture provider")?
        .models
        .push("claude-sonnet-4-6".into());
    let selection = ModelSelection::new(config.active_llm()?);
    assert!(selection.previous_llm().is_none());

    // Effort-only changes are not a model switch.
    selection.set_thinking_level(ThinkingLevel::Low);
    assert!(selection.previous_llm().is_none());

    selection.select_by_spec(&config, "anthropic:claude-sonnet-4-6")?;
    let previous = selection.previous_llm().ok_or("switch not remembered")?;
    assert_eq!(previous.model, "claude-opus-4-6");
    assert_eq!(previous.thinking_level, ThinkingLevel::Low);
    assert_eq!(selection.snapshot().model, "claude-sonnet-4-6");

    // Re-selecting the same model keeps the earlier switch.
    selection.select_configured(&config, "anthropic", "claude-sonnet-4-6", None)?;
    assert_eq!(
        selection.previous_llm().map(|llm| llm.model),
        Some("claude-opus-4-6".into())
    );

    selection.select_configured(&config, "anthropic", "claude-opus-4-6", None)?;
    assert_eq!(
        selection.previous_llm().map(|llm| llm.model),
        Some("claude-sonnet-4-6".into())
    );
    Ok(())
}
