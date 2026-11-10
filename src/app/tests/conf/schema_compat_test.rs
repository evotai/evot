use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;

use evot::auth;
use evot::conf::apply_model_settings;
use evot::conf::config_to_env_groups;
use evot::conf::env_writer::write_grouped;
use evot::conf::Config;
use evot::conf::ModelSettings;
use evot::conf::Protocol;
use evot::conf::ProviderSettings;
use evot_engine::provider::CompatCaps;
use serde::Deserialize;

use crate::conf_load_test::env_lock;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

const CACHE_V0: &str = include_str!("../fixtures/schema/models-cache-v0.json");
const CACHE_V0_MISSING_DEFAULT: &str =
    include_str!("../fixtures/schema/models-cache-v0-missing-default.json");
const CACHE_V1_ACCOUNT_DEFAULT: &str =
    include_str!("../fixtures/schema/models-cache-v1-account-default.json");
const ENV_WITH_CUSTOM_PROVIDER: &str =
    include_str!("../fixtures/schema/evot-env-with-custom-provider.env");

/// The provider shape required by clients released before cache schema v1.
/// Keeping this strict makes the test fail if a current writer drops a field
/// that an old reader still requires.
#[derive(Deserialize)]
struct LegacyModelsCache {
    synced_at: i64,
    response: LegacyModelsResponse,
}

#[derive(Deserialize)]
struct LegacyModelsResponse {
    providers: Vec<LegacyCloudProvider>,
}

#[derive(Deserialize)]
struct LegacyCloudProvider {
    default_model: String,
}

fn restore_env_var(key: &str, value: Option<OsString>) {
    match value {
        Some(value) => std::env::set_var(key, value),
        None => std::env::remove_var(key),
    }
}

#[test]
fn current_reader_accepts_historical_cache_fixtures() -> TestResult {
    let legacy: auth::ModelsCache = serde_json::from_str(CACHE_V0)?;
    assert_eq!(legacy.schema_version, 0);
    assert_eq!(legacy.response.providers[0].default_model, "m-one");

    let transitional: auth::ModelsCache = serde_json::from_str(CACHE_V0_MISSING_DEFAULT)?;
    assert_eq!(transitional.schema_version, 0);
    assert_eq!(transitional.response.providers[0].default_model, "");

    // Caches from servers without per-account defaults carry no top-level
    // `default_model`; that reads as "no pin", not as a parse failure.
    assert_eq!(legacy.response.default_model, "");
    assert_eq!(transitional.response.default_model, "");

    let pinned: auth::ModelsCache = serde_json::from_str(CACHE_V1_ACCOUNT_DEFAULT)?;
    assert_eq!(pinned.schema_version, 1);
    assert_eq!(pinned.response.default_model, "m-two");
    // The per-provider legacy field is untouched by the account-level one.
    assert_eq!(pinned.response.providers[0].default_model, "m-one");
    Ok(())
}

#[test]
fn suggestion_service_survives_current_cache_writes_and_legacy_readers() -> TestResult {
    let cache: auth::ModelsCache = serde_json::from_str(include_str!(
        "../fixtures/schema/models-cache-v1-suggestion.json"
    ))?;
    let service = evot::suggestion::SuggestionEndpoint::from_catalog(&cache.response)
        .ok_or("missing suggestion")?;
    assert_eq!(service.model, "example/suggestion");
    let original_services = cache.response.extra.get("services").cloned();
    let serialized = serde_json::to_string(&auth::ModelsCache::new(500, cache.response))?;
    let legacy: LegacyModelsCache = serde_json::from_str(&serialized)?;
    assert_eq!(legacy.response.providers[0].default_model, "m-one");
    let reread: auth::ModelsCache = serde_json::from_str(&serialized)?;
    assert_eq!(
        reread.response.extra.get("services"),
        original_services.as_ref()
    );
    assert_eq!(reread.response.providers[0].models, ["m-one"]);
    Ok(())
}

/// The account pin is a new top-level response field: current writers emit it,
/// strict legacy readers (which never knew it) must still load the file, and a
/// round trip through the current client must not drop it.
#[test]
fn account_default_model_survives_round_trip_and_legacy_readers() -> TestResult {
    let pinned: auth::ModelsCache = serde_json::from_str(CACHE_V1_ACCOUNT_DEFAULT)?;
    let current = auth::ModelsCache::new(500, pinned.response);
    let serialized = serde_json::to_string_pretty(&current)?;

    let legacy: LegacyModelsCache = serde_json::from_str(&serialized)?;
    assert_eq!(legacy.synced_at, 500);
    assert_eq!(legacy.response.providers[0].default_model, "m-one");

    let reread: auth::ModelsCache = serde_json::from_str(&serialized)?;
    assert_eq!(reread.response.default_model, "m-two");

    // A current client writing a cache from an old server emits the field as
    // an explicit empty string, which is what "no pin" means on the wire.
    let unpinned: auth::ModelsCache = serde_json::from_str(CACHE_V0)?;
    let written: serde_json::Value =
        serde_json::to_value(auth::ModelsCache::new(501, unpinned.response))?;
    assert_eq!(written["response"]["default_model"], serde_json::json!(""));
    Ok(())
}

#[test]
fn current_writer_remains_readable_by_legacy_clients() -> TestResult {
    // A historical value supplied by the server must survive a current
    // read/write cycle even though current business logic ignores it.
    let historical: auth::ModelsCache = serde_json::from_str(CACHE_V0)?;
    let current = auth::ModelsCache::new(200, historical.response);
    let serialized = serde_json::to_string_pretty(&current)?;
    let legacy: LegacyModelsCache = serde_json::from_str(&serialized)?;
    assert_eq!(legacy.synced_at, 200);
    assert_eq!(legacy.response.providers[0].default_model, "m-one");

    // The short-lived writer that omitted the field is also repairable: a
    // current rewrite emits an empty compatibility value, which old readers
    // accept and interpret via their existing first-model fallback.
    let transitional: auth::ModelsCache = serde_json::from_str(CACHE_V0_MISSING_DEFAULT)?;
    let repaired = auth::ModelsCache::new(201, transitional.response);
    let repaired = serde_json::to_string_pretty(&repaired)?;
    let legacy: LegacyModelsCache = serde_json::from_str(&repaired)?;
    assert_eq!(legacy.synced_at, 201);
    assert_eq!(legacy.response.providers[0].default_model, "");

    let value: serde_json::Value = serde_json::from_str(&serialized)?;
    assert_eq!(
        value["schema_version"],
        serde_json::json!(auth::MODELS_CACHE_SCHEMA_VERSION)
    );
    Ok(())
}

/// A cache rewritten by a client that predates a field (e.g. `role`) must
/// hand that field back untouched, otherwise concurrent old/new clients flap
/// the catalog every sync cycle.
#[test]
fn cache_round_trip_preserves_unknown_fields() -> TestResult {
    let raw = serde_json::json!({
        "schema_version": 1,
        "synced_at": 7,
        "future_top": true,
        "response": {
            "version": 410,
            "future_response": [1, 2],
            "providers": [{
                "name": "evot-pro", "protocol": "anthropic", "base_url": "https://x",
                "api_key": "k", "models": ["jev-latest"], "future_provider": "p"
            }],
            "models": [{
                "id": "jev-latest", "role": "judge", "future_model": {"nested": 1}
            }],
            "notices": [{"id": "n", "future_notice": "x"}]
        }
    });
    let mut cache: auth::ModelsCache = serde_json::from_value(raw.clone())?;
    // Simulate the notices-only refresh path that rewrites the whole file.
    cache.response.notices = cache.response.notices.clone();
    let written: serde_json::Value = serde_json::to_value(&cache)?;

    assert_eq!(written["future_top"], raw["future_top"]);
    assert_eq!(
        written["response"]["future_response"],
        raw["response"]["future_response"]
    );
    assert_eq!(
        written["response"]["providers"][0]["future_provider"],
        raw["response"]["providers"][0]["future_provider"]
    );
    assert_eq!(written["response"]["models"][0]["role"], "judge");
    assert_eq!(
        written["response"]["models"][0]["future_model"],
        raw["response"]["models"][0]["future_model"]
    );
    assert_eq!(
        written["response"]["notices"][0]["future_notice"],
        raw["response"]["notices"][0]["future_notice"]
    );
    Ok(())
}

fn assert_custom_provider(config: &Config) -> TestResult {
    let provider = config
        .providers
        .get("corp-gateway")
        .ok_or("custom provider missing")?;
    assert_eq!(config.llm.provider, "corp-gateway");
    assert_eq!(provider.protocol, Protocol::OpenAiResponses);
    assert_eq!(provider.base_url, "https://llm.internal.example/v1");
    assert_eq!(provider.api_key, "sk-custom-fixture");
    assert_eq!(provider.models, vec!["corp-reasoner", "corp-fast"]);
    assert_eq!(provider.context_window, Some(131_072));
    assert_eq!(provider.max_tokens, Some(32_768));
    assert_eq!(provider.supports_image, Some(true));
    assert!(provider.compat_caps.contains(CompatCaps::REASONING_EFFORT));
    assert!(provider.route_capabilities.verbosity);
    assert!(provider.route_capabilities.remote_compaction);
    assert_eq!(
        provider.thinking_level,
        Some(evot_engine::ThinkingLevel::Xhigh)
    );
    Ok(())
}

#[test]
fn custom_env_provider_survives_cloud_reconcile_and_settings_rewrite() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let original_home = std::env::var_os("HOME");
    let home = tempfile::tempdir()?;
    std::env::set_var("HOME", home.path());

    let result = (|| -> TestResult {
        let root = home.path().join(".evotai");
        std::fs::create_dir_all(&root)?;
        std::fs::write(
            root.join("auth.json"),
            r#"{
              "version": 1,
              "server_base_url": "https://auto.evot.ai",
              "user": {"id":"u1","name":"User","email":"user@example.test"},
              "cli_token": "token",
              "refresh_token": "refresh",
              "models_synced_at": 0
            }"#,
        )?;
        std::fs::write(root.join("models.cache.json"), CACHE_V0)?;
        let env_path = root.join("evot.env");
        std::fs::write(&env_path, ENV_WITH_CUSTOM_PROVIDER)?;

        // Loading reconciles stale cloud keys from the shared env file, but
        // must leave the user-owned provider selected and intact.
        let mut config = Config::load()?;
        assert_custom_provider(&config)?;
        assert!(config.providers.contains_key("evot-free"));
        let reconciled = std::fs::read_to_string(&env_path)?;
        assert!(!reconciled.contains("evot.stale.token"));
        assert!(reconciled.contains("EVOT_LLM_CORP_GATEWAY_API_KEY=sk-custom-fixture"));
        assert!(reconciled.contains("CUSTOM_CA_BUNDLE=/opt/company/ca.pem"));

        // Dashboard/settings persistence rebuilds the managed block from a UI
        // payload. Fields not exposed by the UI (secret, compat capabilities,
        // token limits, image support) must be merged from the existing
        // profile rather than dropped.
        apply_model_settings(&mut config, &ModelSettings {
            active_provider: "corp-gateway".into(),
            active_model: None,
            thinking_level: Some("high".into()),
            providers: vec![ProviderSettings {
                name: "corp-gateway".into(),
                protocol: "openai_responses".into(),
                api_key: None,
                base_url: "https://llm.internal.example/v1".into(),
                models: vec!["corp-reasoner".into(), "corp-fast".into()],
                thinking_level: Some("xhigh".into()),
            }],
        })?;
        assert_custom_provider(&config)?;
        config.env_file_path = env_path.clone();
        write_grouped(&env_path, &config_to_env_groups(&config))?;
        let rewritten = std::fs::read_to_string(&env_path)?;
        for expected in [
            "EVOT_LLM_PROVIDER=corp-gateway",
            "EVOT_LLM_CORP_GATEWAY_PROTOCOL=openai_responses",
            "EVOT_LLM_CORP_GATEWAY_BASE_URL=https://llm.internal.example/v1",
            "EVOT_LLM_CORP_GATEWAY_API_KEY=sk-custom-fixture",
            "EVOT_LLM_CORP_GATEWAY_MODEL=corp-reasoner,corp-fast",
            "EVOT_LLM_CORP_GATEWAY_COMPAT_CAPS=reasoning_effort,verbosity,remote_compaction",
            "EVOT_LLM_CORP_GATEWAY_THINKING_LEVEL=xhigh",
            "EVOT_LLM_CORP_GATEWAY_CONTEXT_WINDOW=131072",
            "EVOT_LLM_CORP_GATEWAY_MAX_TOKENS=32768",
            "EVOT_LLM_CORP_GATEWAY_SUPPORTS_IMAGE=true",
            "CUSTOM_CA_BUNDLE=/opt/company/ca.pem",
        ] {
            assert!(rewritten.contains(expected), "missing `{expected}`");
        }
        assert!(!rewritten.contains("evot.stale.token"));

        let reloaded = Config::load()?;
        assert_custom_provider(&reloaded)?;
        Ok(())
    })();

    restore_env_var("HOME", original_home);
    result
}

#[test]
fn cache_store_rejects_future_schema_and_rewrites_legacy_atomically() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let original_home = std::env::var_os("HOME");
    let home = tempfile::tempdir()?;
    std::env::set_var("HOME", home.path());

    let result = (|| -> TestResult {
        let root = home.path().join(".evotai");
        std::fs::create_dir_all(&root)?;
        let path = root.join("models.cache.json");

        let future = serde_json::json!({
            "schema_version": auth::MODELS_CACHE_SCHEMA_VERSION + 1,
            "synced_at": 1,
            "response": {}
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&future)?)?;
        let error = auth::load_models_cache()
            .err()
            .ok_or("future schema unexpectedly loaded")?;
        assert!(error.to_string().contains("supports up to"));

        let legacy: auth::ModelsCache = serde_json::from_str(CACHE_V0)?;
        auth::save_models_cache(&legacy)?;
        let saved = std::fs::read_to_string(&path)?;
        let current: auth::ModelsCache = serde_json::from_str(&saved)?;
        assert_eq!(current.schema_version, auth::MODELS_CACHE_SCHEMA_VERSION);
        assert_eq!(current.response.providers[0].default_model, "m-one");
        assert_eq!(
            std::fs::metadata(&path)?.permissions().mode() & 0o777,
            0o600
        );

        let leftovers = std::fs::read_dir(&root)?
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.path() != path)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "atomic write left temporary files behind: {leftovers:?}"
        );
        Ok(())
    })();

    restore_env_var("HOME", original_home);
    result
}

/// `CompactReason` as released before the `refusal` variant.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum LegacyCompactReason {
    Threshold,
    Overflow,
    Manual,
    Prune,
}

#[test]
fn compact_reason_historical_values_and_refusal_contract() -> TestResult {
    use evot::types::CompactReason;

    // Old data → current reader: every historical value still parses.
    for (wire, expected) in [
        ("\"threshold\"", CompactReason::Threshold),
        ("\"overflow\"", CompactReason::Overflow),
        ("\"manual\"", CompactReason::Manual),
        ("\"prune\"", CompactReason::Prune),
    ] {
        let reason: CompactReason = serde_json::from_str(wire)?;
        assert_eq!(reason, expected);
    }

    // Current writer → legacy reader: historical values keep their spelling.
    for reason in [
        CompactReason::Threshold,
        CompactReason::Overflow,
        CompactReason::Manual,
        CompactReason::Prune,
    ] {
        let wire = serde_json::to_string(&reason)?;
        let _: LegacyCompactReason = serde_json::from_str(&wire)?;
    }

    // `refusal` is new. Its spelling is fixed here, and a legacy reader is
    // known to reject it: an accepted, deliberate contract change.
    let wire = serde_json::to_string(&CompactReason::Refusal)?;
    assert_eq!(wire, "\"refusal\"");
    assert_eq!(
        serde_json::from_str::<CompactReason>(&wire)?,
        CompactReason::Refusal
    );
    assert!(serde_json::from_str::<LegacyCompactReason>(&wire).is_err());
    Ok(())
}
