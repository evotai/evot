//! Generic, provider-agnostic model config resolution in `build_model_config`.
//!
//! Verifies explicit override behavior: `context_window`, `max_tokens`, and
//! `supports_image` replace catalog values when provided. These are set via
//! `EVOT_LLM_<PROVIDER>_*` for any provider.

use evot::conf::resolve_model_config;
use evot::conf::Protocol;
use evot_engine::provider::ApiProtocol;
use evot_engine::provider::CompatCaps;
use evot_engine::provider::InputModality;
use evot_engine::provider::ModelConfig;
use evot_engine::provider::RouteCapabilityOverrides;

#[allow(clippy::too_many_arguments)]
fn build_model_config(
    protocol: Protocol,
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    compat_caps: CompatCaps,
    context_window: Option<u32>,
    max_tokens: Option<u32>,
    supports_image: Option<bool>,
) -> ModelConfig {
    resolve_model_config(
        protocol,
        provider,
        model,
        base_url,
        compat_caps,
        RouteCapabilityOverrides::default(),
        context_window,
        max_tokens,
        supports_image,
    )
}

fn build_model_config_with_route(
    protocol: Protocol,
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    compat_caps: CompatCaps,
    route_capabilities: RouteCapabilityOverrides,
) -> ModelConfig {
    resolve_model_config(
        protocol,
        provider,
        model,
        base_url,
        compat_caps,
        route_capabilities,
        None,
        None,
        None,
    )
}

#[test]
fn openai_compatible_defaults_to_text_only() {
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "some/model",
        Some("https://openrouter.ai/api/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    // Unknown OpenAI-compatible models are conservatively text-only.
    assert!(!mc.supports_image());
    assert_eq!(mc.input(), vec![InputModality::Text]);
    // Default window when none configured.
    assert_eq!(mc.context_window(), 1_000_000);
}

#[test]
fn explicit_supports_image_enables_vision() {
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "some/vision-model",
        Some("https://openrouter.ai/api/v1"),
        CompatCaps::NONE,
        None,
        None,
        Some(true),
    );
    assert!(mc.supports_image());
    assert_eq!(mc.input(), vec![InputModality::Text, InputModality::Image]);
}

#[test]
fn explicit_supports_image_false_forces_text_only() {
    // Even a protocol that defaults to vision (Anthropic) can be pinned to
    // text-only when the configured endpoint does not accept images.
    let mc = build_model_config(
        Protocol::Anthropic,
        "anthropic",
        "claude-sonnet-4",
        None,
        CompatCaps::NONE,
        None,
        None,
        Some(false),
    );
    assert!(!mc.supports_image());
    assert_eq!(mc.input(), vec![InputModality::Text]);
}

#[test]
fn explicit_context_window_and_max_tokens_apply() {
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "tencent/hy3:free",
        Some("https://openrouter.ai/api/v1"),
        CompatCaps::NONE,
        Some(262_144),
        Some(8_192),
        None,
    );
    assert_eq!(mc.context_window(), 262_144);
    assert_eq!(mc.max_tokens(), 8_192);
}

#[test]
fn native_openai_gpt_5_6_metadata_applies_without_explicit_overrides() {
    let mc = build_model_config(
        Protocol::OpenAiResponses,
        "openai",
        "gpt-5.6-sol",
        Some("https://api.openai.com/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiResponses);
    assert_eq!(mc.context_window(), 272_000);
    assert_eq!(mc.max_tokens(), 128_000);
    assert!(mc.supports_image());
}

#[test]
fn custom_route_extensions_require_explicit_transport_capabilities() {
    let without_caps = build_model_config(
        Protocol::OpenAiResponses,
        "proxy",
        "gpt-5.6-sol",
        Some("https://proxy.example/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(without_caps.effective_verbosity(), None);
    assert!(!without_caps.can_remote_compact());

    let with_caps = build_model_config_with_route(
        Protocol::OpenAiResponses,
        "proxy",
        "gpt-5.6-sol",
        Some("https://proxy.example/v1"),
        CompatCaps::NONE,
        RouteCapabilityOverrides {
            verbosity: true,
            remote_compaction: true,
        },
    );
    assert_eq!(
        with_caps.effective_verbosity(),
        Some(evot_engine::provider::Verbosity::Low)
    );
    assert!(with_caps.can_remote_compact());
}

#[test]
fn databend_openai_responses_route_enables_native_extensions_without_user_caps() {
    let mc = build_model_config(
        Protocol::OpenAiResponses,
        "openai",
        "gpt-5.6-sol",
        Some("https://openrouter.databend.cloud/openai/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );

    assert!(mc
        .compat()
        .is_some_and(|compat| compat.caps.contains(CompatCaps::STORE)));
    assert!(mc.can_remote_compact());
    assert_eq!(
        mc.effective_verbosity(),
        Some(evot_engine::provider::Verbosity::Low)
    );
}

#[test]
fn openrouter_gpt_5_6_gets_catalog_limits_without_explicit_overrides() {
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "openai/gpt-5.6-sol",
        Some("https://openrouter.ai/api/v1"),
        CompatCaps::REASONING_EFFORT,
        None,
        None,
        None,
    );
    assert_eq!(mc.context_window(), 272_000);
    assert_eq!(mc.max_tokens(), 128_000);
    assert!(mc
        .supported_thinking_levels()
        .contains(&evot_engine::ThinkingLevel::Max));
}

#[test]
fn openrouter_ox_alpha_resolves_glm_profile_with_opencode_efforts() {
    use evot_engine::ThinkingLevel::*;

    // GLM-family stealth listing: catalog metadata applies without explicit
    // overrides, and effort selection survives the OpenRouter transport.
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "stealth/ox-alpha",
        Some("https://openrouter.ai/api/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.context_window(), 917_504);
    assert_eq!(mc.advertised_context_window(), 1_048_576);
    assert_eq!(mc.max_tokens(), 131_072);
    assert!(mc.supports_image());
    assert!(mc.reasoning());
    assert!(mc.honors_reasoning_effort());
    assert_eq!(mc.supported_thinking_levels(), vec![Low, High, Max]);
    assert_eq!(mc.default_thinking_level(), Max);
}

#[test]
fn grok_provider_uses_cli_model_metadata_without_env_overrides() {
    use evot_engine::ThinkingLevel::*;

    let mc = build_model_config(
        Protocol::OpenAi,
        "grok",
        "grok-4.5",
        Some("https://openrouter.databend.cloud/grok/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.context_window(), 500_000);
    assert_eq!(mc.max_tokens(), 63_356);
    assert!(mc.reasoning());
    assert!(mc.honors_reasoning_effort());
    assert_eq!(mc.supported_thinking_levels(), vec![Low, Medium, High]);
}

#[test]
fn cloud_openai_grok_exposes_selectable_thinking_levels() {
    use evot_engine::ThinkingLevel::*;

    // Server-named OpenAI groups (`evot-pro-openai`) do not inherit the
    // first-party `openai` / `grok` transport profiles. Reasoning models on
    // those routes still honor `reasoning_effort` once the cloud loader
    // stamps CompatCaps::REASONING_EFFORT onto the profile.
    let mc = build_model_config(
        Protocol::OpenAi,
        "evot-pro-openai",
        "grok-4.6",
        Some("https://auto.evot.ai/v1/llm"),
        CompatCaps::REASONING_EFFORT,
        None,
        None,
        None,
    );
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiCompletions);
    assert!(mc.reasoning());
    assert!(mc.honors_reasoning_effort());
    assert_eq!(mc.supported_thinking_levels(), vec![
        Low, Medium, High, Xhigh
    ]);
    assert_eq!(mc.default_thinking_level(), High);
    assert!(!mc.can_disable_thinking());
}

#[test]
fn same_named_openai_proxy_keeps_catalog_and_openai_transport_metadata() {
    // Model metadata is keyed by model id and provider identity selects the
    // OpenAI wire profile. Endpoint-native capabilities remain route-gated.
    let mc = build_model_config(
        Protocol::OpenAi,
        "openai",
        "grok-4.5",
        Some("https://openrouter.databend.cloud/openai/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiCompletions);
    assert_eq!(mc.context_window(), 500_000);
    assert_eq!(mc.max_tokens(), 63_356);
    assert!(mc.reasoning());
    assert!(mc
        .compat()
        .is_some_and(|compat| compat.caps.contains(CompatCaps::REASONING_EFFORT)));
    assert!(mc.honors_reasoning_effort());
    assert!(!mc.can_remote_compact());
    assert_eq!(mc.effective_verbosity(), None);
}

#[test]
fn openrouter_gpt_uses_model_effort_without_compat_caps() {
    use evot_engine::ThinkingLevel::*;

    // Model capability survives routing through a self-hosted proxy whose
    // transport profile does not advertise reasoning effort.
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "openai/gpt-5.6-sol",
        Some("https://openrouter.ai/api/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.context_window(), 272_000);
    assert!(mc.reasoning());
    assert!(mc.honors_reasoning_effort());
    assert_eq!(mc.supported_thinking_levels(), vec![
        Off, Low, Medium, High, Xhigh, Max
    ]);
}

#[test]
fn openai_provider_defaults_base_url_when_missing() {
    let mc = build_model_config(
        Protocol::OpenAiResponses,
        "openai",
        "gpt-5.6-sol",
        None,
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.base_url(), "https://api.openai.com/v1");
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiResponses);
    assert_eq!(mc.context_window(), 272_000);
}

#[test]
fn openai_provider_defaults_base_url_when_blank() {
    let mc = build_model_config(
        Protocol::OpenAiResponses,
        "openai",
        "gpt-5.6-sol",
        Some("  "),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.base_url(), "https://api.openai.com/v1");
    assert!(mc.can_remote_compact());
}

#[test]
fn custom_responses_endpoint_can_select_responses_explicitly() {
    let mc = build_model_config(
        Protocol::OpenAiResponses,
        "azure-openai",
        "gpt-5.5",
        Some("https://example.openai.azure.com/openai/v1"),
        CompatCaps::DEVELOPER_ROLE,
        None,
        None,
        None,
    );
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiResponses);
    assert_eq!(mc.base_url(), "https://example.openai.azure.com/openai/v1");
}

#[test]
fn named_openai_can_explicitly_keep_chat_completions() {
    let mc = build_model_config(
        Protocol::OpenAi,
        "openai",
        "gpt-5.5",
        Some("https://proxy.example.com/v1"),
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiCompletions);
    assert_eq!(mc.base_url(), "https://proxy.example.com/v1");
}

#[test]
fn non_openai_opencompat_has_empty_default_base_url() {
    let mc = build_model_config(
        Protocol::OpenAi,
        "openrouter",
        "some/model",
        None,
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert_eq!(mc.base_url(), "");
    assert_eq!(mc.protocol(), ApiProtocol::OpenAiCompletions);
}

#[test]
fn anthropic_defaults_to_vision() {
    let mc = build_model_config(
        Protocol::Anthropic,
        "anthropic",
        "claude-sonnet-4",
        None,
        CompatCaps::NONE,
        None,
        None,
        None,
    );
    assert!(mc.supports_image());
}
