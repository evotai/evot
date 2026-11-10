use std::collections::HashMap;
use std::path::PathBuf;

use evot::agent::models::model_catalog;
use evot::auth::FreeModelOption;
use evot::conf::Config;
use evot::conf::LlmConfig;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn profile(protocol: Protocol, models: &[&str]) -> ProviderProfile {
    ProviderProfile {
        protocol,
        api_key: "fixture-secret".into(),
        base_url: "https://example.invalid/v1".into(),
        models: models.iter().map(|model| (*model).into()).collect(),
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    }
}

#[test]
fn model_catalog_preserves_cloud_fields_order_and_byok_isolation() -> TestResult {
    let mut config = Config::new(PathBuf::new());
    config.providers.insert(
        "hosted".into(),
        profile(Protocol::OpenAi, &[" shared ", "", "  ", "no-meta"]),
    );
    // An evot-prefixed name alone does not make a provider cloud.
    config
        .providers
        .insert("evot-custom".into(), profile(Protocol::OpenAi, &["shared"]));
    config.cloud_model_sorts.insert("shared".into(), 9);
    let metadata = HashMap::from([("shared".into(), FreeModelOption {
        id: "shared".into(),
        display_name: "Shared".into(),
        tagline: "Fixture".into(),
        is_new: true,
        tier: "special".into(),
        sort_order: 99,
        ..Default::default()
    })]);
    let groups = HashMap::from([("hosted".into(), ("Hosted".into(), -2))]);
    let actual = model_catalog(&config, &LlmConfig::unconfigured(), &metadata, &groups);
    assert_eq!(
        json!(actual),
        json!([
            {"provider":"hosted","protocol":"openai","model":"shared","spec":"hosted:shared",
             "group_label":"Hosted","group_order":-2,"sort_order":9,
             "free":{"display_name":"Shared","tagline":"Fixture","is_new":true,"tier":"special"}},
            {"provider":"hosted","protocol":"openai","model":"no-meta","spec":"hosted:no-meta",
             "group_label":"Hosted","group_order":-2,"sort_order":0,"free":{}},
            {"provider":"evot-custom","protocol":"openai","model":"shared","spec":"evot-custom:shared"}
        ])
    );
    assert!(!serde_json::to_string(&actual)?.contains("fixture-secret"));
    Ok(())
}

#[test]
fn model_catalog_reasoning_uses_config_defaults_not_live_effort() -> TestResult {
    let mut config = Config::new(PathBuf::new());
    config.providers.insert(
        "anthropic".into(),
        profile(Protocol::Anthropic, &["claude-opus-4-6"]),
    );
    let mut current = config.build_llm("anthropic", Some("claude-opus-4-6".into()))?;
    current.thinking_level = evot_engine::ThinkingLevel::Low;
    let actual = model_catalog(&config, &current, &HashMap::new(), &HashMap::new());
    assert_eq!(
        json!(actual),
        json!([{
            "provider":"anthropic","protocol":"anthropic","model":"claude-opus-4-6",
            "spec":"anthropic:claude-opus-4-6",
            "thinking_levels":["off","low","medium","high","max"],"thinking_level":"high"
        }])
    );
    assert_eq!(current.thinking_level, evot_engine::ThinkingLevel::Low);
    Ok(())
}

#[test]
fn model_catalog_fallback_keeps_live_protocol_without_cloud_presentation() -> TestResult {
    let mut config = Config::new(PathBuf::new());
    config
        .providers
        .insert("hosted".into(), profile(Protocol::OpenAi, &["listed"]));
    let mut current = config.build_llm("hosted", Some("unlisted".into()))?;
    current.protocol = Protocol::OpenAiResponses;
    let groups = HashMap::from([("hosted".into(), ("Hosted".into(), 0))]);
    let actual = model_catalog(&config, &current, &HashMap::new(), &groups);
    assert_eq!(actual.len(), 2);
    assert_eq!(
        actual[1],
        json!({"provider":"hosted","protocol":"openai_responses","model":"unlisted","spec":"hosted:unlisted"})
    );
    current.model = " listed ".into();
    assert_eq!(
        model_catalog(&config, &current, &HashMap::new(), &groups).len(),
        1
    );
    current.model = "  ".into();
    assert_eq!(
        model_catalog(&config, &current, &HashMap::new(), &groups).len(),
        1
    );
    current.provider = "removed".into();
    current.model = "unlisted".into();
    assert_eq!(
        model_catalog(&config, &current, &HashMap::new(), &groups).len(),
        1
    );
    Ok(())
}
