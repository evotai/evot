use std::collections::HashMap;

use evotengine::provider::*;
use evotengine::ThinkingLevel;

fn resolved(
    protocol: ApiProtocol,
    provider: &str,
    model_id: &str,
    base_url: &str,
    compat: Option<OpenAiCompat>,
    route_capabilities: RouteCapabilities,
    overrides: ModelOverrides,
) -> ModelConfig {
    ModelConfig::resolve(ResolveModelRequest {
        protocol,
        provider: provider.into(),
        model_id: model_id.into(),
        base_url: base_url.into(),
        headers: HashMap::new(),
        compat,
        route_capabilities,
        overrides,
    })
}

#[test]
fn model_config_presets_resolve_expected_routes() {
    let anthropic = ModelConfig::anthropic("claude-sonnet-4-20250514", "Claude Sonnet 4");
    assert_eq!(anthropic.protocol(), ApiProtocol::AnthropicMessages);
    assert_eq!(anthropic.provider(), "anthropic");
    assert!(anthropic.compat().is_none());

    let openai = ModelConfig::openai("gpt-4o", "GPT-4o");
    assert_eq!(openai.protocol(), ApiProtocol::OpenAiCompletions);
    assert_eq!(openai.context_window(), 128_000);
    let Some(compat) = openai.compat() else {
        panic!("OpenAI preset must carry compatibility metadata");
    };
    assert!(compat.caps.contains(CompatCaps::STORE));
    assert!(compat.caps.contains(CompatCaps::DEVELOPER_ROLE));
    assert_eq!(compat.max_tokens_field, MaxTokensField::MaxCompletionTokens);

    let responses = ModelConfig::openai_responses("gpt-5.5", "GPT-5.5");
    assert_eq!(responses.protocol(), ApiProtocol::OpenAiResponses);
    assert_eq!(responses.provider(), "openai");
}

#[test]
fn route_resolution_is_endpoint_aware_and_explicitly_overridable() {
    let official = OpenAiCompat::for_provider("openai");
    assert!(official.caps.contains(CompatCaps::STORE));
    assert!(official.caps.contains(CompatCaps::DEVELOPER_ROLE));

    let proxy = OpenAiCompat::for_provider("openai");
    assert!(proxy.caps.contains(CompatCaps::STORE));
    assert!(proxy.caps.contains(CompatCaps::DEVELOPER_ROLE));
    assert!(proxy.caps.contains(CompatCaps::REASONING_EFFORT));

    let official_route = RouteCapabilities::for_route(
        ApiProtocol::OpenAiResponses,
        "openai",
        "https://api.openai.com/v1",
        RouteCapabilityOverrides::default(),
    );
    assert!(official_route.verbosity);
    assert!(official_route.remote_compaction);

    let databend_route = RouteCapabilities::for_route(
        ApiProtocol::OpenAiResponses,
        "openai",
        "https://openrouter.databend.cloud/openai/v1/",
        RouteCapabilityOverrides::default(),
    );
    assert!(databend_route.verbosity);
    assert!(databend_route.remote_compaction);

    let proxy_route = RouteCapabilities::for_route(
        ApiProtocol::OpenAiResponses,
        "openai",
        "https://proxy.example.com/v1",
        RouteCapabilityOverrides {
            verbosity: true,
            remote_compaction: true,
        },
    );
    assert!(proxy_route.verbosity);
    assert!(proxy_route.remote_compaction);

    let chat_route = RouteCapabilities::for_route(
        ApiProtocol::OpenAiCompletions,
        "openai",
        "https://proxy.example.com/v1",
        RouteCapabilityOverrides {
            verbosity: false,
            remote_compaction: true,
        },
    );
    assert!(!chat_route.remote_compaction);
}

#[test]
fn route_and_model_capabilities_are_intersected() {
    let official = ModelConfig::openai_responses("gpt-5.6-sol", "GPT-5.6 Sol");
    assert_eq!(official.effective_verbosity(), Some(Verbosity::Low));
    assert!(official.can_remote_compact());

    let proxy = resolved(
        ApiProtocol::OpenAiResponses,
        "proxy",
        "gpt-5.6-sol",
        "https://proxy.example.com/v1",
        Some(OpenAiCompat::openai()),
        RouteCapabilities::default(),
        ModelOverrides::default(),
    );
    assert_eq!(proxy.effective_verbosity(), None);
    assert!(!proxy.can_remote_compact());

    let verbosity_only = resolved(
        ApiProtocol::OpenAiResponses,
        "proxy",
        "gpt-5.6-sol",
        "https://proxy.example.com/v1",
        Some(OpenAiCompat::openai()),
        RouteCapabilities {
            verbosity: true,
            remote_compaction: false,
        },
        ModelOverrides::default(),
    );
    assert_eq!(verbosity_only.effective_verbosity(), Some(Verbosity::Low));
    assert!(!verbosity_only.can_remote_compact());
}

#[test]
fn remote_compaction_is_allowlisted_by_model_and_route() {
    for id in ["gpt-5.6-sol", "gpt-5.5", "gpt-6-astra"] {
        assert!(
            ModelConfig::openai_responses(id, id).can_remote_compact(),
            "{id}"
        );
    }
    for id in [
        "o3",
        "codex-mini",
        "gpt-5.7-nova",
        "grok-4.5",
        "grok-4.6",
        "claude-opus-4-6",
        "unknown-model",
    ] {
        assert!(
            !ModelConfig::openai_responses(id, id).can_remote_compact(),
            "{id}"
        );
    }
}

#[test]
fn date_suffixed_anthropic_ids_match_family_capabilities() {
    for (bare, dated) in [
        ("claude-opus-4-6", "claude-opus-4-6-20251101"),
        ("claude-opus-4-8", "anthropic/claude-opus-4-8-20260115"),
        ("claude-opus-5", "anthropic/claude-opus-5-20260301"),
        ("claude-sonnet-4-6", "claude-sonnet-4-6-20251201"),
        ("claude-sonnet-5", "claude-sonnet-5-20260101"),
    ] {
        let bare = ModelConfig::anthropic(bare, bare);
        let dated = ModelConfig::anthropic(dated, dated);
        assert_eq!(
            bare.context_window(),
            dated.context_window(),
            "{}",
            dated.id()
        );
        assert_eq!(bare.max_tokens(), dated.max_tokens(), "{}", dated.id());
        assert_eq!(
            bare.supported_thinking_levels(),
            dated.supported_thinking_levels(),
            "{}",
            dated.id()
        );
        assert_eq!(
            bare.can_disable_thinking(),
            dated.can_disable_thinking(),
            "{}",
            dated.id()
        );
    }
}

#[test]
fn grok_profiles_match_xai_contracts() {
    use evotengine::ThinkingLevel::*;

    let grok_4_5 = ModelConfig::openai_responses("grok-4.5", "Grok 4.5");
    assert_eq!(grok_4_5.context_window(), 500_000);
    assert_eq!(grok_4_5.max_tokens(), 63_356);
    assert_eq!(grok_4_5.input(), [
        InputModality::Text,
        InputModality::Image
    ]);
    assert_eq!(grok_4_5.supported_thinking_levels(), vec![
        Low, Medium, High
    ]);
    assert_eq!(grok_4_5.default_thinking_level(), High);
    assert!(!grok_4_5.can_disable_thinking());

    let grok_4_6 = ModelConfig::openai_responses("grok-4.6", "Grok 4.6");
    assert_eq!(grok_4_6.context_window(), 500_000);
    assert_eq!(grok_4_6.max_tokens(), 500_000);
    assert_eq!(grok_4_6.input(), [
        InputModality::Text,
        InputModality::Image
    ]);
    assert_eq!(grok_4_6.supported_thinking_levels(), vec![
        Low, Medium, High, Xhigh
    ]);
    assert_eq!(grok_4_6.default_thinking_level(), High);
    assert!(!grok_4_6.can_disable_thinking());
    assert_eq!(grok_4_6.profile_compaction_limit(Xhigh), None);
}

#[test]
fn kimi_profiles_match_catalog_contracts() {
    for id in ["k2p7", "kimi-for-coding", "kimi-for-coding-highspeed"] {
        let config = ModelConfig::anthropic(id, id);
        assert_eq!(config.context_window(), 196_608, "{id}");
        assert_eq!(config.advertised_context_window(), 256_000, "{id}");
        assert_eq!(config.max_tokens(), 65_536, "{id}");
        assert_eq!(
            config.input(),
            [InputModality::Text, InputModality::Image],
            "{id}"
        );
        assert_eq!(config.default_thinking_level(), ThinkingLevel::High, "{id}");
    }

    use evotengine::ThinkingLevel::*;
    let k3 = ModelConfig::anthropic("k3", "Kimi K3");
    // 1M window minus the 131_072 default max_completion_tokens; K3 always
    // thinks, so Off is not offered and the official default effort is max.
    assert_eq!(k3.context_window(), 917_504);
    assert_eq!(k3.advertised_context_window(), 1_000_000);
    assert_eq!(k3.max_tokens(), 131_072);
    assert_eq!(k3.supported_thinking_levels(), vec![Low, High, Max]);
    assert!(!k3.can_disable_thinking());
    assert_eq!(k3.default_thinking_level(), Max);
    // No profile limit: compaction follows the window (pi-style trigger).
    assert_eq!(k3.profile_compaction_limit(Max), None);

    let thinking = ModelConfig::anthropic("kimi-k2-thinking", "Kimi K2 Thinking");
    assert_eq!(thinking.context_window(), 196_608);
    assert_eq!(thinking.advertised_context_window(), 256_000);
    assert_eq!(thinking.max_tokens(), 65_536);
    assert_eq!(thinking.input(), [InputModality::Text]);
}

#[test]
fn current_openai_profiles_expose_limits_and_verbosity() {
    for id in ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro"] {
        let config = ModelConfig::openai(id, id);
        assert_eq!(config.context_window(), 922_000, "{id}");
        assert_eq!(config.advertised_context_window(), 1_000_000, "{id}");
        assert_eq!(config.max_tokens(), 128_000, "{id}");
        assert_eq!(
            config.default_thinking_level(),
            ThinkingLevel::Medium,
            "{id}"
        );
    }
    for id in [
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6.1-sol",
    ] {
        assert_eq!(
            ModelConfig::openai(id, id).effective_verbosity(),
            Some(Verbosity::Low),
            "{id}"
        );
    }
    for id in ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5-pro", "gpt-5.7-nova"] {
        assert_eq!(
            ModelConfig::openai(id, id).effective_verbosity(),
            None,
            "{id}"
        );
    }
}

/// GPT-5.6 and newer mirror Codex `models.json` and pi: 272k default
/// context window (the long-context pricing threshold), auto-compaction at
/// 90%, low..max reasoning and remote compaction on the first-party route.
#[test]
fn gpt_5_6_plus_profiles_follow_codex_and_pi() {
    use evotengine::ThinkingLevel::*;

    for id in [
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6.1-sol",
    ] {
        let config = ModelConfig::openai(id, id);
        assert_eq!(config.context_window(), 272_000, "{id}");
        assert_eq!(config.advertised_context_window(), 272_000, "{id}");
        assert_eq!(config.max_tokens(), 128_000, "{id}");
        assert_eq!(
            config.profile_compaction_limit(ThinkingLevel::Medium),
            Some(244_800),
            "{id}"
        );
        assert_eq!(config.default_thinking_level(), Medium, "{id}");
        assert_eq!(config.clamp_thinking_level(Max), Max, "{id}");
        assert!(
            ModelConfig::openai_responses(id, id).can_remote_compact(),
            "{id}"
        );
    }

    // `effort: none` is still accepted on these.
    for id in [
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-luna",
        "gpt-6-sol",
    ] {
        let config = ModelConfig::openai(id, id);
        assert_eq!(
            config.supported_thinking_levels(),
            vec![Off, Low, Medium, High, Xhigh, Max],
            "{id}"
        );
        assert!(config.can_disable_thinking(), "{id}");
    }

    // GPT-6 Astra and GPT-6.1 Sol reject `effort: none`.
    for id in ["gpt-6-astra", "gpt-6.1-sol"] {
        let config = ModelConfig::openai(id, id);
        assert_eq!(
            config.supported_thinking_levels(),
            vec![Low, Medium, High, Xhigh, Max],
            "{id}"
        );
        assert!(!config.can_disable_thinking(), "{id}");
        assert_eq!(config.clamp_thinking_level(Off), Low, "{id}");
    }
}

#[test]
fn unknown_openai_families_keep_reasoning_fallback_without_extensions() {
    use evotengine::ThinkingLevel::*;

    for id in ["codex-mini", "gpt-5.3-mini"] {
        let config = ModelConfig::openai(id, id);
        assert!(config.reasoning(), "{id}");
        assert_eq!(
            config.supported_thinking_levels(),
            vec![Off, Low, Medium, High],
            "{id}"
        );
        assert_eq!(config.effective_verbosity(), None, "{id}");
        assert!(!config.can_remote_compact(), "{id}");
    }

    // GPT-5.6+ successors inherit the 272k window and low..max ladder (no
    // `none`, which newer models reject) but not the first-party allowlists
    // (verbosity, remote compaction).
    let nova = ModelConfig::openai("gpt-5.7-nova", "GPT-5.7 Nova");
    assert_eq!(nova.supported_thinking_levels(), vec![
        Low, Medium, High, Xhigh, Max
    ]);
    assert_eq!(nova.effective_verbosity(), None);
    assert!(!nova.can_remote_compact());
}

#[test]
fn anthropic_version_rules_cover_current_and_future_models() {
    for id in ["claude-opus-4-6", "claude-opus-4-8", "claude-opus-5-0"] {
        let config = ModelConfig::anthropic(id, id);
        assert_eq!(config.context_window(), 867_000, "{id}");
        assert_eq!(config.advertised_context_window(), 1_000_000, "{id}");
        assert_eq!(config.max_tokens(), 128_000, "{id}");
        assert_eq!(config.default_thinking_level(), ThinkingLevel::High, "{id}");
    }
    for id in [
        "claude-sonnet-4-20250514",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
    ] {
        let config = ModelConfig::anthropic(id, id);
        assert_eq!(config.context_window(), 200_000, "{id}");
        assert_eq!(config.advertised_context_window(), 200_000, "{id}");
        assert_eq!(config.max_tokens(), 64_000, "{id}");
    }
    let opus_4_5 = ModelConfig::anthropic("claude-opus-4-5", "Claude Opus 4.5");
    assert_eq!(opus_4_5.context_window(), 200_000);
    assert_eq!(opus_4_5.max_tokens(), 64_000);
}

/// Fable 5.x and Opus/Sonnet 5.5+ are always-on adaptive reasoning (`off`
/// is rejected) on their regular long-context windows; Haiku 5 joins the
/// adaptive 1M tier with `off` still available.
#[test]
fn anthropic_mandatory_reasoning_profiles_follow_pi() {
    use evotengine::ThinkingLevel::*;

    for (id, window) in [
        ("claude-fable-5", 867_000),
        ("claude-fable-5-1", 867_000),
        ("claude-opus-5-5", 867_000),
        ("claude-opus-5-6", 867_000),
        ("claude-sonnet-5-5", 872_000),
        ("claude-sonnet-5-7", 872_000),
    ] {
        let config = ModelConfig::anthropic(id, id);
        assert_eq!(config.context_window(), window, "{id}");
        assert_eq!(config.advertised_context_window(), 1_000_000, "{id}");
        assert_eq!(config.max_tokens(), 128_000, "{id}");
        assert_eq!(config.default_thinking_level(), High, "{id}");
        assert_eq!(
            config.supported_thinking_levels(),
            vec![Low, Medium, High, Xhigh, Max],
            "{id}"
        );
        assert!(!config.can_disable_thinking(), "{id}");
        assert_eq!(config.clamp_thinking_level(Off), Low, "{id}");
    }

    // Opus/Sonnet 5.0 keep `off`.
    for id in ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5"] {
        let config = ModelConfig::anthropic(id, id);
        assert_eq!(config.max_tokens(), 128_000, "{id}");
        assert!(config.can_disable_thinking(), "{id}");
        assert_eq!(config.clamp_thinking_level(Xhigh), Xhigh, "{id}");
    }
    assert_eq!(
        ModelConfig::anthropic("claude-haiku-5", "Haiku 5").context_window(),
        872_000
    );
}

/// Haiku 5.5 bills the whole request at 5x once input passes 100k, so the
/// default window stays in the cheap tier while advertising the 1M ceiling.
#[test]
fn anthropic_haiku_5_5_caps_input_at_pricing_threshold() {
    use evotengine::ThinkingLevel::*;

    for id in ["claude-haiku-5-5", "claude-haiku-5-6"] {
        let config = ModelConfig::anthropic(id, id);
        assert_eq!(config.context_window(), 100_000, "{id}");
        assert_eq!(config.advertised_context_window(), 1_000_000, "{id}");
        assert_eq!(config.max_tokens(), 128_000, "{id}");
        assert_eq!(
            config.profile_compaction_limit(Medium),
            Some(90_000),
            "{id}"
        );
        assert!(config.can_disable_thinking(), "{id}");
        assert_eq!(config.clamp_thinking_level(Max), Max, "{id}");
    }
}

#[test]
fn compaction_limits_come_only_from_explicit_profiles() {
    // Large-window models carry no profile limit: compaction triggers near
    // the real window (pi-style `window - reserve`), not a proactive cap.
    let gpt = ModelConfig::openai("gpt-5.5", "GPT-5.5");
    assert_eq!(gpt.context_window(), 922_000);
    assert_eq!(gpt.profile_compaction_limit(ThinkingLevel::Medium), None);

    let adaptive = ModelConfig::anthropic("claude-opus-4-6", "Claude Opus 4.6");
    assert_eq!(adaptive.context_window(), 867_000);
    assert_eq!(adaptive.profile_compaction_limit(ThinkingLevel::High), None);

    // Anthropic 200k models keep their explicit 180k profile threshold.
    let budget_based = ModelConfig::anthropic("claude-sonnet-4-20250514", "Claude Sonnet 4");
    assert_eq!(budget_based.context_window(), 200_000);
    assert_eq!(
        budget_based.profile_compaction_limit(ThinkingLevel::High),
        Some(180_000)
    );

    let kimi = ModelConfig::anthropic("kimi-for-coding", "Kimi for Coding");
    assert_eq!(kimi.context_window(), 196_608);
    assert_eq!(kimi.profile_compaction_limit(ThinkingLevel::High), None);

    // xAI documents 500k as the model window; 200k is only its higher-price
    // prompt tier boundary.
    let grok = ModelConfig::openai("grok-4.5", "Grok 4.5");
    assert_eq!(grok.context_window(), 500_000);
    assert_eq!(grok.profile_compaction_limit(ThinkingLevel::High), None);
}

#[test]
fn explicit_overrides_apply_after_catalog_resolution() {
    let config = resolved(
        ApiProtocol::OpenAiCompletions,
        "custom",
        "gpt-5.6-sol",
        "https://example.com/v1",
        Some(OpenAiCompat::default()),
        RouteCapabilities::default(),
        ModelOverrides {
            context_window: Some(64_000),
            max_output_tokens: Some(4_096),
            supports_image: Some(false),
            reasoning: Some(false),
        },
    );
    assert_eq!(config.context_window(), 64_000);
    assert_eq!(config.max_tokens(), 4_096);
    assert!(!config.supports_image());
    assert!(!config.reasoning());
    assert_eq!(config.supported_thinking_levels(), vec![ThinkingLevel::Off]);
}

#[test]
fn openai_compat_profiles_are_transport_only() {
    let xai = OpenAiCompat::xai();
    assert_eq!(xai.thinking_format, ThinkingFormat::Xai);
    assert!(!xai.caps.contains(CompatCaps::STORE));
    assert!(!xai.caps.contains(CompatCaps::REASONING_EFFORT));

    let grok_cli = OpenAiCompat::grok_cli();
    assert!(grok_cli.caps.contains(CompatCaps::REASONING_EFFORT));

    let deepseek = OpenAiCompat::deepseek();
    assert_eq!(
        deepseek.max_tokens_field,
        MaxTokensField::MaxCompletionTokens
    );
    assert_eq!(deepseek.thinking_format, ThinkingFormat::DeepSeek);
    assert!(deepseek.caps.contains(CompatCaps::REASONING_EFFORT));
}

#[test]
fn transport_capability_names_round_trip() {
    let caps = CompatCaps::STORE | CompatCaps::PROMPT_CACHE_KEY;
    let Ok(encoded) = serde_json::to_value(caps) else {
        panic!("transport capabilities must serialize");
    };
    assert_eq!(encoded, serde_json::json!(["store", "prompt_cache_key"]));
    let Ok(decoded) = serde_json::from_value::<CompatCaps>(encoded) else {
        panic!("transport capabilities must deserialize");
    };
    assert_eq!(decoded, caps);
}

#[test]
fn route_capability_names_are_parsed_separately_from_transport_caps() {
    let mut overrides = RouteCapabilityOverrides::default();
    assert!(overrides.set_named("verbosity"));
    assert!(overrides.set_named("remote_compaction"));
    assert!(!overrides.set_named("store"));
    assert!(overrides.verbosity);
    assert!(overrides.remote_compaction);
    assert_eq!(CompatCaps::from_name("verbosity"), None);
    assert_eq!(CompatCaps::from_name("remote_compaction"), None);
}

/// GLM 5.3 (and Flash) use the three-tier low/high/max ladder with Max as
/// default. The cloud catalog's `max` default must land natively; unknown
/// glm ids inherit the same ladder instead of an older two-tier mapping.
#[test]
fn glm_5_3_uses_the_low_high_max_ladder() {
    for id in ["glm-5.3", "glm-5.3-flash", "glm-5.4-turbo"] {
        let glm = ModelConfig::anthropic(id, id);
        assert_eq!(
            glm.supported_thinking_levels(),
            vec![ThinkingLevel::Low, ThinkingLevel::High, ThinkingLevel::Max],
            "{id}"
        );
        assert_eq!(glm.default_thinking_level(), ThinkingLevel::Max, "{id}");
        assert_eq!(
            glm.effective_thinking_level(ThinkingLevel::Max),
            ThinkingLevel::Max,
            "{id}"
        );
    }

    let flash = ModelConfig::anthropic("glm-5.3-flash", "GLM 5.3 Flash");
    assert!(flash.supports_image());
    let flagship = ModelConfig::anthropic("glm-5.3", "GLM 5.3");
    assert!(!flagship.supports_image());
}

#[test]
fn newer_uncatalogued_ids_inherit_family_windows() {
    for id in ["glm-5.3", "glm-5.2-pro", "zai/glm-5.3", "glm-4.7"] {
        let model = ModelConfig::openai(id, id);
        assert_eq!(model.context_window(), 917_504, "{id}");
        assert_eq!(model.advertised_context_window(), 1_000_000, "{id}");
        assert_eq!(model.max_tokens(), 131_072, "{id}");
    }

    let gpt = ModelConfig::openai("gpt-5.7-nova", "GPT-5.7 Nova");
    assert_eq!(gpt.context_window(), 272_000);
    assert_eq!(gpt.advertised_context_window(), 272_000);
    assert_eq!(gpt.max_tokens(), 128_000);
    assert!(!gpt.can_remote_compact());

    let gpt_5_5 = ModelConfig::openai("gpt-5.5-mini", "GPT-5.5 Mini");
    assert_eq!(gpt_5_5.context_window(), 922_000);
    assert_eq!(gpt_5_5.advertised_context_window(), 1_000_000);
    assert_eq!(gpt_5_5.max_tokens(), 32_768);

    let gpt4 = ModelConfig::openai("gpt-4o", "GPT-4o");
    assert_eq!(gpt4.context_window(), 128_000);
    assert_eq!(gpt4.advertised_context_window(), 128_000);

    let deepseek = ModelConfig::openai("deepseek-v5-pro", "DeepSeek V5");
    assert_eq!(deepseek.context_window(), 616_000);
    assert_eq!(deepseek.advertised_context_window(), 1_000_000);

    for id in ["kimi-k3.1", "k3-preview"] {
        let model = ModelConfig::anthropic(id, id);
        assert_eq!(model.context_window(), 917_504, "{id}");
        assert_eq!(model.advertised_context_window(), 1_000_000, "{id}");
    }

    let k2 = ModelConfig::anthropic("kimi-k2.8", "Kimi K2.8");
    assert_eq!(k2.context_window(), 196_608);
    assert_eq!(k2.advertised_context_window(), 256_000);

    let grok = ModelConfig::openai("grok-5", "Grok 5");
    assert_eq!(grok.context_window(), 500_000);
    assert_eq!(grok.advertised_context_window(), 500_000);
}

#[test]
fn glm_and_deepseek_profiles_are_explicit() {
    use evotengine::ThinkingLevel::*;

    let glm = ModelConfig::openai("zai/glm-5.3", "GLM 5.3");
    assert_eq!(glm.context_window(), 917_504);
    assert_eq!(glm.advertised_context_window(), 1_000_000);
    assert_eq!(glm.max_tokens(), 131_072);
    assert_eq!(glm.input(), [InputModality::Text]);
    assert_eq!(glm.supported_thinking_levels(), vec![Low, High, Max]);
    assert_eq!(glm.default_thinking_level(), Max);

    let chat = resolved(
        ApiProtocol::OpenAiCompletions,
        "deepseek",
        "deepseek-chat",
        "https://api.deepseek.com",
        Some(OpenAiCompat::deepseek()),
        RouteCapabilities::default(),
        ModelOverrides::default(),
    );
    assert!(!chat.reasoning());
    assert_eq!(chat.supported_thinking_levels(), vec![Off]);
    assert_eq!(chat.default_thinking_level(), Off);
    assert!(!chat.can_disable_thinking());

    let namespaced_chat = ModelConfig::openai("deepseek/deepseek-chat", "DeepSeek Chat");
    assert_eq!(namespaced_chat.context_window(), 128_000);
    assert_eq!(namespaced_chat.max_tokens(), 8_192);
    assert!(!namespaced_chat.reasoning());

    let reasoner = resolved(
        ApiProtocol::OpenAiCompletions,
        "deepseek",
        "deepseek-reasoner",
        "https://api.deepseek.com",
        Some(OpenAiCompat::deepseek()),
        RouteCapabilities::default(),
        ModelOverrides::default(),
    );
    assert!(reasoner.reasoning());
    assert_eq!(reasoner.supported_thinking_levels(), vec![Off, High]);
    assert_eq!(reasoner.default_thinking_level(), High);

    let namespaced_reasoner =
        ModelConfig::openai("deepseek/deepseek-reasoner", "DeepSeek Reasoner");
    assert_eq!(namespaced_reasoner.context_window(), 128_000);
    assert_eq!(namespaced_reasoner.max_tokens(), 64_000);
    assert_eq!(namespaced_reasoner.default_thinking_level(), High);

    for id in ["deepseek-v4-flash", "deepseek-v4-pro"] {
        let model = resolved(
            ApiProtocol::OpenAiCompletions,
            "deepseek",
            id,
            "https://api.deepseek.com",
            Some(OpenAiCompat::deepseek()),
            RouteCapabilities::default(),
            ModelOverrides::default(),
        );
        assert_eq!(model.context_window(), 616_000, "model: {}", id);
        assert_eq!(
            model.advertised_context_window(),
            1_000_000,
            "model: {}",
            id
        );
        assert_eq!(model.max_tokens(), 384_000, "model: {}", id);
        assert_eq!(model.input(), [InputModality::Text], "model: {}", id);
        assert_eq!(
            model.supported_thinking_levels(),
            vec![Off, Low, High, Xhigh, Max],
            "model: {}",
            id
        );
        assert_eq!(model.default_thinking_level(), High, "model: {}", id);
        assert!(model.can_disable_thinking(), "model: {}", id);
    }
}

#[test]
fn unknown_models_do_not_inherit_protocol_reasoning() {
    let config = ModelConfig::local("http://localhost:11434/v1", "some/model");
    assert!(!config.reasoning());
    assert_eq!(config.supported_thinking_levels(), vec![ThinkingLevel::Off]);
    assert_eq!(config.default_thinking_level(), ThinkingLevel::Off);
}

#[test]
fn ox_alpha_extends_glm_family_with_opencode_style_efforts() {
    use evotengine::ThinkingLevel::*;

    for id in ["stealth/ox-alpha", "ox-alpha", "zai/ox-alpha"] {
        let model = ModelConfig::openai(id, "Ox Alpha");
        assert_eq!(model.context_window(), 917_504, "{id}");
        assert_eq!(model.advertised_context_window(), 1_048_576, "{id}");
        assert_eq!(model.max_tokens(), 131_072, "{id}");
        assert_eq!(
            model.input(),
            [InputModality::Text, InputModality::Image],
            "{id}"
        );
        assert!(model.reasoning(), "{id}");
        // Mandatory reasoning: no Off tier; the ladder mirrors OpenRouter's
        // supported_efforts / models.dev reasoning_options (opencode variants).
        assert!(!model.can_disable_thinking(), "{id}");
        assert_eq!(
            model.supported_thinking_levels(),
            vec![Low, High, Max],
            "{id}"
        );
        assert_eq!(model.default_thinking_level(), Max, "{id}");
        // Off requests clamp up to the lowest supported effort.
        assert_eq!(model.effective_thinking_level(Off), Low, "{id}");
    }
}

#[test]
fn thinking_levels_follow_model_and_route_contracts() {
    use evotengine::ThinkingLevel::*;

    let opus_4_6 = ModelConfig::anthropic("claude-opus-4-6", "Opus 4.6");
    assert_eq!(opus_4_6.supported_thinking_levels(), vec![
        Off, Low, Medium, High, Max
    ]);

    let opus_4_8 = ModelConfig::anthropic("claude-opus-4-8", "Opus 4.8");
    assert_eq!(opus_4_8.supported_thinking_levels(), vec![
        Off, Low, Medium, High, Xhigh, Max
    ]);

    let opus_5 = ModelConfig::anthropic("claude-opus-5", "Opus 5");
    assert_eq!(opus_5.supported_thinking_levels(), vec![
        Off, Low, Medium, High, Xhigh, Max
    ]);
    assert_eq!(opus_5.context_window(), 867_000);
    assert_eq!(opus_5.max_tokens(), 128_000);

    let gpt_5_5 = ModelConfig::openai("gpt-5.5", "GPT-5.5");
    assert_eq!(gpt_5_5.supported_thinking_levels(), vec![
        Low, Medium, High, Xhigh
    ]);

    let gpt_5_5_pro = ModelConfig::openai("gpt-5.5-pro", "GPT-5.5 Pro");
    assert_eq!(gpt_5_5_pro.supported_thinking_levels(), vec![
        Medium, High, Xhigh
    ]);
    assert_eq!(gpt_5_5_pro.clamp_thinking_level(Low), Medium);
    assert_eq!(gpt_5_5_pro.effective_thinking_level(Off), Medium);

    let xai_route = resolved(
        ApiProtocol::OpenAiCompletions,
        "xai",
        "grok-4.5",
        "https://api.x.ai/v1",
        Some(OpenAiCompat::xai()),
        RouteCapabilities::default(),
        ModelOverrides::default(),
    );
    assert!(xai_route.reasoning());
    assert!(!xai_route.honors_reasoning_effort());
    assert!(xai_route.supported_thinking_levels().is_empty());
}

#[test]
fn api_protocol_display_is_stable() {
    assert_eq!(
        ApiProtocol::AnthropicMessages.to_string(),
        "anthropic_messages"
    );
    assert_eq!(ApiProtocol::OpenAiResponses.to_string(), "openai_responses");
    assert_eq!(
        ApiProtocol::OpenAiCompletions.to_string(),
        "openai_completions"
    );
    assert_eq!(
        ApiProtocol::BedrockConverseStream.to_string(),
        "bedrock_converse_stream"
    );
}
