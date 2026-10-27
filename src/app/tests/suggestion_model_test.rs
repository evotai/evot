use std::collections::HashMap;

use evot::conf::LlmConfig;
use evot::conf::Protocol;
use evot::suggestion::prompt_config;
use evot::suggestion::SuggestionEndpoint;
use evot::suggestion::SuggestionHints;
use evot::suggestion::SuggestionMessage;
use evot::suggestion::SuggestionModel;
use evot_engine::provider::ApiProtocol;
use evot_engine::provider::ModelConfig;
use evot_engine::provider::ModelOverrides;
use evot_engine::provider::OpenAiCompat;
use evot_engine::provider::ResolveModelRequest;
use evot_engine::ThinkingLevel;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn current_model_preserves_resolved_route_and_caps_without_chat_state() -> TestResult {
    for (protocol, api) in [
        (Protocol::Anthropic, ApiProtocol::AnthropicMessages),
        (Protocol::OpenAi, ApiProtocol::OpenAiCompletions),
        (Protocol::OpenAiResponses, ApiProtocol::OpenAiResponses),
    ] {
        let config = ModelConfig::resolve(ResolveModelRequest {
            protocol: api,
            provider: "custom".into(),
            model_id: "local-model".into(),
            base_url: "http://localhost:11434/v1".into(),
            headers: HashMap::from([("x-custom-route".into(), "fixture".into())]),
            compat: Some(OpenAiCompat::default()),
            route_capabilities: Default::default(),
            overrides: ModelOverrides {
                context_window: Some(8192),
                max_output_tokens: Some(96),
                supports_image: Some(false),
                ..Default::default()
            },
        });
        let llm = LlmConfig {
            provider: "custom".into(),
            protocol,
            // An empty unresolved base URL must not lose the resolved route.
            base_url: String::new(),
            model: "local-model".into(),
            api_key: String::new(),
            thinking_level: ThinkingLevel::High,
            model_config: config.clone(),
        };
        let model = SuggestionModel::from(llm);
        assert_eq!(model.route, evot::suggestion::SuggestionRoute::CurrentModel);
        let prompt = prompt_config(
            &model,
            &[
                SuggestionMessage {
                    role: "user".into(),
                    text: "Implement the tests".into(),
                },
                SuggestionMessage {
                    role: "assistant".into(),
                    text: "Implementation is ready.".into(),
                },
            ],
            &SuggestionHints::default(),
        )
        .ok_or("missing prompt")?;
        assert_eq!(prompt.model, "local-model");
        assert!(prompt.api_key.is_empty());
        assert_eq!(prompt.thinking_level, ThinkingLevel::Off);
        assert_eq!(prompt.max_tokens, Some(192));
        assert_eq!(prompt.resolved_max_tokens(), 96);
        assert!(prompt.tools.is_empty());
        assert!(prompt.system_prompt.is_empty());
        assert!(prompt.prompt_cache_key.is_none());
        let route = prompt.model_config.ok_or("missing resolved route")?;
        assert_eq!(route.protocol(), api);
        assert_eq!(route.base_url(), config.base_url());
        assert_eq!(route.provider(), "custom");
        assert_eq!(route.headers(), config.headers());
        assert_eq!(
            serde_json::to_value(route.compat())?,
            serde_json::to_value(config.compat())?
        );
        assert_eq!(route.context_window(), 8192);
        assert!(!route.supports_image());
        // Consuming the snapshot cannot change the original chat route.
        assert_eq!(config.max_tokens(), 96);
        assert!(!config.supports_image());
    }
    Ok(())
}

#[test]
fn published_service_resolves_independently_with_legacy_default_window() -> TestResult {
    let cache: evot::auth::ModelsCache = serde_json::from_str(include_str!(
        "fixtures/schema/models-cache-v1-suggestion.json"
    ))?;
    let mut service = SuggestionEndpoint::from_catalog(&cache.response).ok_or("missing service")?;
    service.context_window = 0;
    let model = SuggestionModel::try_from(&service)?;
    assert_eq!(model.route, evot::suggestion::SuggestionRoute::Cloud);
    assert_eq!(model.config.id(), service.model);
    assert_eq!(model.config.base_url(), service.base_url);
    assert_eq!(model.api_key, service.api_key);
    assert_eq!(model.config.context_window(), 8192);
    assert!(model.config.supports_image());
    service.protocol = "unsupported".into();
    assert!(SuggestionModel::try_from(&service).is_err());
    Ok(())
}
