use evot::auth;
use evot::conf::Config;
use evot_engine::provider::anthropic::request::build_request_body;
use evot_engine::provider::StreamConfig;
use evot_engine::ThinkingLevel;

use crate::conf_load_test::env_lock;

type TestResult = Result<(), Box<dyn std::error::Error>>;
const CACHE: &str = include_str!("fixtures/schema/models-cache-v1-capabilities.json");

#[test]
fn cloud_alias_capabilities_reach_runtime_and_request_without_renaming_model() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let home = tempfile::tempdir()?;
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", home.path());
    let result = (|| -> TestResult {
        let root = home.path().join(".evotai");
        std::fs::create_dir_all(&root)?;
        std::fs::write(
            root.join("auth.json"),
            r#"{
            "version":1,"server_base_url":"https://auto.evot.ai",
            "user":{"id":"u1","name":"User","email":"user@example.test"},
            "cli_token":"token","refresh_token":"refresh","models_synced_at":0
        }"#,
        )?;
        std::fs::write(root.join("models.cache.json"), CACHE)?;
        let config = Config::load()?;
        let fast = config.build_llm("evot-free", Some("evot-fast".into()))?;
        assert_eq!(fast.model_config.id(), "evot-fast");
        assert_eq!(fast.model_config.context_window(), 616_000);
        assert_eq!(fast.model_config.advertised_context_window(), 1_000_000);
        assert_eq!(fast.model_config.max_tokens(), 256_000);
        assert_eq!(fast.thinking_level, ThinkingLevel::Max);
        assert_eq!(fast.model_config.supported_thinking_levels(), vec![
            ThinkingLevel::Off,
            ThinkingLevel::Low,
            ThinkingLevel::High,
            ThinkingLevel::Max,
        ]);
        let request = build_request_body(
            &StreamConfig {
                model: fast.model,
                system_prompt: String::new(),
                messages: vec![],
                tools: vec![],
                thinking_level: fast.thinking_level,
                api_key: String::new(),
                max_tokens: None,
                model_config: Some(fast.model_config),
                cache_config: Default::default(),
                prompt_cache_key: None,
                client: None,
            },
            false,
        );
        assert_eq!(request["model"], "evot-fast");
        assert_eq!(request["max_tokens"], 256_000);
        assert_eq!(request["thinking"]["type"], "enabled");
        assert_eq!(request["output_config"]["effort"], "max");

        let fallback = config.build_llm("evot-free", Some("opaque-alias".into()))?;
        assert_eq!(fallback.model_config.max_tokens(), 128_000);
        assert_eq!(fallback.thinking_level, ThinkingLevel::Max);
        let limited = config.build_llm("evot-free", Some("limited-alias".into()))?;
        assert_eq!(limited.model_config.max_tokens(), 4096);
        assert!(!limited.model_config.reasoning());
        let future = config.build_llm("evot-free", Some("future-alias".into()))?;
        assert_eq!(future.model_config.max_tokens(), 128_000);
        assert!(future.model_config.reasoning());

        // The same model id on a custom provider must not inherit cloud policy.
        let mut custom = config.clone();
        let mut profile = custom
            .providers
            .get("evot-free")
            .ok_or("missing provider")?
            .clone();
        profile.api_key = "byok-key".into();
        custom.providers.insert("custom".into(), profile);
        let byok = custom.build_llm("custom", Some("evot-fast".into()))?;
        assert_eq!(byok.model_config.max_tokens(), 128_000);
        assert_eq!(byok.model_config.context_window(), 1_000_000);

        // Explicit provider settings override both published profile and limits.
        let profile = custom
            .providers
            .get_mut("evot-free")
            .ok_or("missing cloud provider")?;
        profile.max_tokens = Some(2048);
        profile.context_window = Some(64_000);
        profile.supports_image = Some(false);
        profile.thinking_level = Some(ThinkingLevel::Off);
        let overridden = custom.build_llm("evot-free", Some("evot-fast".into()))?;
        assert_eq!(overridden.model_config.max_tokens(), 2048);
        assert_eq!(overridden.model_config.context_window(), 64_000);
        assert!(!overridden.model_config.supports_image());
        assert_eq!(overridden.thinking_level, ThinkingLevel::Off);
        Ok(())
    })();
    match previous {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    result
}

#[test]
fn historical_catalog_has_no_capability_overrides_and_current_writer_preserves_them() -> TestResult
{
    let historical: auth::ModelsCache =
        serde_json::from_str(include_str!("fixtures/schema/models-cache-v0.json"))?;
    assert!(historical.response.models[0].capability_profile.is_empty());
    assert_eq!(historical.response.models[0].max_output_tokens, None);
    let current: auth::ModelsCache = serde_json::from_str(CACHE)?;
    let written = serde_json::to_string(&auth::ModelsCache::new(456, current.response))?;
    let reread: auth::ModelsCache = serde_json::from_str(&written)?;
    assert_eq!(
        reread.response.models[0].capability_profile,
        "deepseek-v4.1-flash"
    );
    assert_eq!(reread.response.models[0].max_output_tokens, Some(256_000));
    // A strict historical reader still requires all old fields and their types,
    // while ignoring additive fields just like the released serde reader.
    #[derive(serde::Deserialize)]
    struct LegacyCache {
        synced_at: i64,
        response: LegacyResponse,
    }
    #[derive(serde::Deserialize)]
    struct LegacyResponse {
        version: u64,
        providers: Vec<LegacyProvider>,
        models: Vec<LegacyModel>,
    }
    #[derive(serde::Deserialize)]
    struct LegacyProvider {
        default_model: String,
        models: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    struct LegacyModel {
        id: String,
        protocol: String,
        thinking_level: String,
    }
    let legacy: LegacyCache = serde_json::from_str(&written)?;
    assert_eq!(legacy.synced_at, 456);
    assert_eq!(legacy.response.version, 7);
    assert_eq!(legacy.response.providers[0].default_model, "evot-fast");
    assert_eq!(legacy.response.providers[0].models[0], "evot-fast");
    assert_eq!(legacy.response.models[0].id, "evot-fast");
    assert_eq!(legacy.response.models[0].protocol, "anthropic");
    assert_eq!(legacy.response.models[0].thinking_level, "max");
    Ok(())
}
