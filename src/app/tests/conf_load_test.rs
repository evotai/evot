use std::ffi::OsString;
use std::sync::Mutex;
use std::sync::OnceLock;

use evot::conf::thinking_level_from_str;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::StorageBackend;
use evot_engine::provider::CompatCaps;
use evot_engine::ThinkingLevel;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

pub(crate) fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn restore_env_var(key: &str, value: Option<OsString>) {
    match value {
        Some(value) => std::env::set_var(key, value),
        None => std::env::remove_var(key),
    }
}

#[test]
fn default_provider_is_empty() {
    let config = Config::new(std::path::PathBuf::from("/tmp"));
    assert_eq!(config.llm.provider, "");
}

#[test]
fn protocol_infer() {
    use evot::conf::infer_protocol;
    assert_eq!(infer_protocol("anthropic"), Protocol::Anthropic);
    assert_eq!(infer_protocol("openai"), Protocol::OpenAi);
    assert_eq!(infer_protocol("openrouter"), Protocol::OpenAi);
    assert_eq!(infer_protocol("deepseek"), Protocol::OpenAi);
}

#[test]
fn parse_protocol_valid() -> TestResult {
    use evot::conf::parse_protocol;
    assert_eq!(parse_protocol("anthropic")?, Protocol::Anthropic);
    assert_eq!(parse_protocol("openai")?, Protocol::OpenAi);
    assert_eq!(
        parse_protocol("openai_responses")?,
        Protocol::OpenAiResponses
    );
    assert!(parse_protocol("unknown").is_err());
    Ok(())
}

#[test]
fn config_with_port_overrides_server_port() {
    let config = Config::new(std::path::PathBuf::from("/tmp")).with_port(9999);
    assert_eq!(config.server.port, 9999);
}

#[test]
fn load_config_prefers_process_env_over_env_file() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "EVOT_LLM_ANTHROPIC_API_KEY=file-key\nEVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com\nEVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-20250514\nEVOT_SERVER_PORT=9010\n",
    )?;

    let original_home = std::env::var_os("HOME");
    let original_key = std::env::var_os("EVOT_LLM_ANTHROPIC_API_KEY");
    let original_port = std::env::var_os("EVOT_SERVER_PORT");

    std::env::set_var("HOME", &env_home);
    std::env::set_var("EVOT_LLM_ANTHROPIC_API_KEY", "process-key");
    std::env::set_var("EVOT_SERVER_PORT", "9020");

    let result = Config::load();

    restore_env_var("HOME", original_home);
    restore_env_var("EVOT_LLM_ANTHROPIC_API_KEY", original_key);
    restore_env_var("EVOT_SERVER_PORT", original_port);

    let config = result?;
    assert_eq!(config.active_llm()?.api_key, "process-key");
    assert_eq!(config.server.port, 9020);
    assert_eq!(config.storage.backend, StorageBackend::Fs);
    assert_eq!(config.storage.fs.root_dir, env_home.join(".evotai"));
    Ok(())
}

#[test]
fn load_config_uses_toml_then_env_then_cli() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"

[providers.anthropic]
api_key = "toml-key"
base_url = "https://api.anthropic.com"
model = "toml-model"

[server]
host = "0.0.0.0"
port = 8010

[storage]
backend = "fs"

[storage.fs]
root_dir = "~/custom-store"
"#,
    )?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "export EVOT_LLM_ANTHROPIC_MODEL=env-model\nexport EVOT_SERVER_PORT=9010\n",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load().and_then(|c| c.with_model(Some("anthropic:cli-model".into())));

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.active_llm()?.api_key, "toml-key");
    assert_eq!(config.active_llm()?.model, "cli-model");
    assert_eq!(config.server.host, "0.0.0.0");
    assert_eq!(config.server.port, 9010);
    assert_eq!(config.storage.fs.root_dir, env_home.join("custom-store"));
    Ok(())
}

#[test]
fn load_config_keeps_multiple_providers() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"

[providers.anthropic]
api_key = "anthropic-key"
base_url = "https://api.anthropic.com"
model = "claude-sonnet-4-20250514"

[providers.openai]
api_key = "openai-key"
base_url = "https://api.openai.com/v1"
model = "gpt-5"
"#,
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.active_llm()?.provider, "anthropic");
    assert_eq!(config.active_llm()?.api_key, "anthropic-key");

    // Switch provider
    let config = config.with_model(Some("gpt-5".into()))?;
    assert_eq!(config.active_llm()?.api_key, "openai-key");
    assert_eq!(config.active_llm()?.model, "gpt-5");
    assert_eq!(config.active_llm()?.protocol, Protocol::OpenAi);
    Ok(())
}

#[test]
fn with_model_or_fallback_keeps_selection_for_unknown_spec() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"

[providers.anthropic]
api_key = "anthropic-key"
base_url = "https://api.anthropic.com"
model = "claude-sonnet-4-20250514"
"#,
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);
    let config = result?;

    // A valid spec applies exactly like `with_model` and reports nothing.
    let (config, warning) = config.with_model_or_fallback(Some("anthropic:claude-opus".into()));
    assert_eq!(warning, None);
    assert_eq!(config.active_llm()?.model, "claude-opus");

    // A removed/unknown model id keeps the previous selection and explains why.
    let (config, warning) = config.with_model_or_fallback(Some("evot-free".into()));
    let warning = warning.ok_or("expected a startup warning")?;
    assert!(warning.contains("--model 'evot-free' ignored"), "{warning}");
    assert!(
        warning.contains("no provider with model 'evot-free'"),
        "{warning}"
    );
    assert!(warning.contains("using 'claude-opus'"), "{warning}");
    assert_eq!(config.active_llm()?.model, "claude-opus");

    // An unknown provider in `provider:model` form is also non-fatal.
    let (config, warning) = config.with_model_or_fallback(Some("gone:evot-free".into()));
    assert!(warning.is_some_and(|w| w.contains("provider 'gone' not found")));
    assert_eq!(config.active_llm()?.provider, "anthropic");

    // No override: untouched, no warning.
    let (config, warning) = config.with_model_or_fallback(None);
    assert_eq!(warning, None);
    assert_eq!(config.active_llm()?.model, "claude-opus");
    Ok(())
}

#[test]
fn explicit_openai_responses_protocol_loads_from_env() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "EVOT_LLM_PROVIDER=openai\nEVOT_LLM_OPENAI_API_KEY=key\nEVOT_LLM_OPENAI_BASE_URL=https://api.openai.com/v1\nEVOT_LLM_OPENAI_MODEL=gpt-5.5\nEVOT_LLM_OPENAI_PROTOCOL=openai_responses\n",
    )?;
    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);
    let result = Config::load();
    restore_env_var("HOME", original_home);
    assert_eq!(result?.active_llm()?.protocol, Protocol::OpenAiResponses);
    Ok(())
}

#[test]
fn load_config_new_env_format() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "\
EVOT_LLM_PROVIDER=deepseek
EVOT_LLM_ANTHROPIC_API_KEY=ant-key
EVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com
EVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-20250514
EVOT_LLM_DEEPSEEK_API_KEY=ds-key
EVOT_LLM_DEEPSEEK_BASE_URL=https://api.deepseek.com
EVOT_LLM_DEEPSEEK_MODEL=deepseek-chat
",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.llm.provider, "deepseek");
    assert_eq!(config.active_llm()?.api_key, "ds-key");
    assert_eq!(config.active_llm()?.base_url, "https://api.deepseek.com");
    assert_eq!(config.active_llm()?.model, "deepseek-chat");
    assert_eq!(config.active_llm()?.protocol, Protocol::OpenAi);

    // anthropic provider also loaded
    let ant = config.providers.get("anthropic").unwrap();
    assert_eq!(ant.api_key, "ant-key");
    assert_eq!(ant.protocol, Protocol::Anthropic);
    Ok(())
}

#[test]
fn load_config_legacy_env_compat() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "\
EVOT_LLM_PROVIDER=anthropic
EVOT_ANTHROPIC_API_KEY=legacy-key
EVOT_ANTHROPIC_BASE_URL=https://api.anthropic.com
EVOT_ANTHROPIC_MODEL=claude-sonnet-4-20250514
",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.active_llm()?.api_key, "legacy-key");
    assert_eq!(config.active_llm()?.protocol, Protocol::Anthropic);
    Ok(())
}

#[test]
fn load_config_accepts_route_compat_caps() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "\
EVOT_LLM_PROVIDER=custom
EVOT_LLM_CUSTOM_API_KEY=key
EVOT_LLM_CUSTOM_BASE_URL=https://example.com
EVOT_LLM_CUSTOM_MODEL=gpt-5.6-sol
EVOT_LLM_CUSTOM_PROTOCOL=openai_responses
EVOT_LLM_CUSTOM_COMPAT_CAPS=store,verbosity,remote_compaction
",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);
    let result = Config::load();
    restore_env_var("HOME", original_home);

    let config = result?;
    let provider = config.providers.get("custom").ok_or("missing provider")?;
    assert!(provider.route_capabilities.verbosity);
    assert!(provider.route_capabilities.remote_compaction);
    assert_eq!(provider.compat_caps, CompatCaps::STORE);
    Ok(())
}

#[test]
fn load_config_accepts_prompt_cache_key_compat_cap() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "\
EVOT_LLM_PROVIDER=custom
EVOT_LLM_CUSTOM_API_KEY=key
EVOT_LLM_CUSTOM_BASE_URL=https://example.com
EVOT_LLM_CUSTOM_MODEL=gpt-test
EVOT_LLM_CUSTOM_COMPAT_CAPS=usage_in_streaming,prompt_cache_key
",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    let provider = config.providers.get("custom").ok_or("missing provider")?;
    assert!(provider
        .compat_caps
        .contains(CompatCaps::USAGE_IN_STREAMING));
    assert!(provider.compat_caps.contains(CompatCaps::PROMPT_CACHE_KEY));
    Ok(())
}

#[test]
fn thinking_level_from_str_valid() -> TestResult {
    assert_eq!(thinking_level_from_str("off")?, ThinkingLevel::Off);
    assert_eq!(thinking_level_from_str("minimal")?, ThinkingLevel::Minimal);
    assert_eq!(thinking_level_from_str("low")?, ThinkingLevel::Low);
    assert_eq!(thinking_level_from_str("medium")?, ThinkingLevel::Medium);
    assert_eq!(thinking_level_from_str("high")?, ThinkingLevel::High);
    assert_eq!(thinking_level_from_str("xhigh")?, ThinkingLevel::Xhigh);
    assert_eq!(thinking_level_from_str("max")?, ThinkingLevel::Max);
    // case-insensitive
    assert_eq!(thinking_level_from_str("HIGH")?, ThinkingLevel::High);
    assert_eq!(thinking_level_from_str("Medium")?, ThinkingLevel::Medium);
    Ok(())
}

#[test]
fn thinking_level_from_str_rejects_invalid() {
    assert!(thinking_level_from_str("turbo").is_err());
    assert!(thinking_level_from_str("").is_err());
    // `adaptive` was a pre-pi meta level. It is rejected with a message that
    // names the replacement rather than a bare "unknown level".
    let err = thinking_level_from_str("adaptive")
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    assert!(err.contains("was removed"), "{err}");
    assert!(err.contains("medium"), "{err}");
}

#[test]
fn default_thinking_level_is_model_defined() {
    let config = Config::new(std::path::PathBuf::from("/tmp"));
    assert_eq!(config.llm.thinking_level, None);
}

#[test]
fn load_config_thinking_level_from_toml() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"
thinking_level = "medium"

[providers.anthropic]
api_key = "test-key"
base_url = "https://api.anthropic.com"
model = "claude-sonnet-4-20250514"
"#,
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.llm.thinking_level, Some(ThinkingLevel::Medium));
    assert_eq!(config.active_llm()?.thinking_level, ThinkingLevel::Medium);
    Ok(())
}

#[test]
fn load_config_thinking_level_from_env_file() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "EVOT_LLM_ANTHROPIC_API_KEY=test-key\nEVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com\nEVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-20250514\nEVOT_LLM_THINKING_LEVEL=high\n",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.llm.thinking_level, Some(ThinkingLevel::High));
    Ok(())
}

#[test]
fn load_config_per_provider_thinking_level_from_env_file() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        concat!(
            "EVOT_LLM_PROVIDER=anthropic\n",
            "EVOT_LLM_THINKING_LEVEL=medium\n",
            "EVOT_LLM_ANTHROPIC_API_KEY=test-key\n",
            "EVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com\n",
            "EVOT_LLM_ANTHROPIC_MODEL=claude-opus-4-8\n",
            "EVOT_LLM_ANTHROPIC_THINKING_LEVEL=xhigh\n",
            "EVOT_LLM_DEEPSEEK_API_KEY=ds-key\n",
            "EVOT_LLM_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1\n",
            "EVOT_LLM_DEEPSEEK_MODEL=deepseek-chat\n",
        ),
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    // The explicit global override stays medium.
    assert_eq!(config.llm.thinking_level, Some(ThinkingLevel::Medium));
    // anthropic has a per-provider override.
    assert_eq!(
        config.providers["anthropic"].thinking_level,
        Some(ThinkingLevel::Xhigh)
    );
    assert_eq!(
        config.build_llm("anthropic", None)?.thinking_level,
        ThinkingLevel::Xhigh
    );
    // deepseek-chat explicitly declares no reasoning, so the global override is
    // clamped to the model's only valid level.
    assert_eq!(config.providers["deepseek"].thinking_level, None);
    assert_eq!(
        config.build_llm("deepseek", None)?.thinking_level,
        ThinkingLevel::Off
    );
    Ok(())
}

#[test]
fn load_config_context_window_and_max_tokens_from_env_file() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        concat!(
            "EVOT_LLM_PROVIDER=openrouter\n",
            "EVOT_LLM_OPENROUTER_API_KEY=or-key\n",
            "EVOT_LLM_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1\n",
            "EVOT_LLM_OPENROUTER_PROTOCOL=openai\n",
            "EVOT_LLM_OPENROUTER_MODEL=google/gemini-2.5-pro\n",
            "EVOT_LLM_OPENROUTER_CONTEXT_WINDOW=1000000\n",
            "EVOT_LLM_OPENROUTER_MAX_TOKENS=32000\n",
            // A provider without overrides falls back to None.
            "EVOT_LLM_DEEPSEEK_API_KEY=ds-key\n",
            "EVOT_LLM_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1\n",
            "EVOT_LLM_DEEPSEEK_MODEL=deepseek-chat\n",
        ),
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(
        config.providers["openrouter"].context_window,
        Some(1_000_000)
    );
    assert_eq!(config.providers["openrouter"].max_tokens, Some(32_000));
    let llm = config.build_llm("openrouter", None)?;
    assert_eq!(llm.model_config.context_window(), 1_000_000);
    assert_eq!(llm.model_config.max_tokens(), 32_000);
    // No overrides set: the provider profile remains unset and the resolved
    // model receives its limits from the catalog.
    assert_eq!(config.providers["deepseek"].context_window, None);
    assert_eq!(config.providers["deepseek"].max_tokens, None);
    Ok(())
}

#[test]
fn load_config_rejects_invalid_max_tokens() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        concat!(
            "EVOT_LLM_PROVIDER=openrouter\n",
            "EVOT_LLM_OPENROUTER_API_KEY=or-key\n",
            "EVOT_LLM_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1\n",
            "EVOT_LLM_OPENROUTER_MODEL=google/gemini-2.5-pro\n",
            "EVOT_LLM_OPENROUTER_MAX_TOKENS=not-a-number\n",
        ),
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let err = result.expect_err("invalid max tokens should fail to load");
    assert!(format!("{err}").contains("MAX_TOKENS"));
    Ok(())
}

#[test]
fn load_config_thinking_level_env_overrides_toml() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"
thinking_level = "low"

[providers.anthropic]
api_key = "test-key"
base_url = "https://api.anthropic.com"
model = "claude-sonnet-4-20250514"
"#,
    )?;
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "EVOT_LLM_THINKING_LEVEL=high\n",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.llm.thinking_level, Some(ThinkingLevel::High));
    Ok(())
}

#[test]
fn load_config_custom_env_file_via_explicit_path() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;

    // Write a custom env file outside the default location
    let custom_env = temp.path().join("custom.env");
    std::fs::write(
        &custom_env,
        "EVOT_LLM_ANTHROPIC_API_KEY=custom-key\nEVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com\nEVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-20250514\nEVOT_SERVER_PORT=7777\n",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load_with_env_file(Some(custom_env.to_str().unwrap()));

    restore_env_var("HOME", original_home);

    let config = result?;
    assert_eq!(config.active_llm()?.api_key, "custom-key");
    assert_eq!(config.server.port, 7777);
    Ok(())
}

#[test]
fn load_config_custom_env_file_missing_returns_error() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load_with_env_file(Some("/tmp/nonexistent-evot.env"));

    restore_env_var("HOME", original_home);

    assert!(result.is_err());
    let err = format!("{}", result.unwrap_err());
    assert!(err.contains("env file not found"));
    Ok(())
}

#[test]
fn resolve_model_spec_by_model_name() -> TestResult {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config
        .providers
        .insert("deepseek".into(), evot::conf::ProviderProfile {
            protocol: Protocol::OpenAi,
            api_key: "ds-key".into(),
            base_url: "https://api.deepseek.com".into(),
            models: vec!["deepseek-chat".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });

    config
        .providers
        .insert("openrouter".into(), evot::conf::ProviderProfile {
            protocol: Protocol::OpenAi,
            api_key: "or-key".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            models: vec!["tencent/hy3:free".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });

    // Naming a model always pins it, even when it heads its provider's list.
    let (name, override_model) = config.resolve_model_spec("deepseek-chat")?;
    assert_eq!(name, "deepseek");
    assert_eq!(override_model, Some("deepseek-chat".to_string()));

    let (name, override_model) = config.resolve_model_spec("anthropic:custom-model")?;
    assert_eq!(name, "anthropic");
    assert_eq!(override_model, Some("custom-model".to_string()));

    let (name, override_model) = config.resolve_model_spec("tencent/hy3:free")?;
    assert_eq!(name, "openrouter");
    assert_eq!(override_model, Some("tencent/hy3:free".to_string()));

    let (name, override_model) = config.resolve_model_spec("openrouter:tencent/hy3:free")?;
    assert_eq!(name, "openrouter");
    assert_eq!(override_model, Some("tencent/hy3:free".to_string()));

    assert!(config.resolve_model_spec("nonexistent-model").is_err());
    assert!(config.resolve_model_spec("badprovider:model").is_err());
    // Empty model in provider:model spec should be rejected
    let err = config.resolve_model_spec("anthropic:").unwrap_err();
    assert!(format!("{err}").contains("empty model"));
    Ok(())
}

#[test]
fn with_model_sets_override() -> TestResult {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });

    // provider:model sets override
    let config = config.with_model(Some("anthropic:custom-model".into()))?;
    assert_eq!(config.llm.provider, "anthropic");
    assert_eq!(config.llm.model_override, Some("custom-model".to_string()));
    assert_eq!(config.active_llm()?.model, "custom-model");

    // a plain model name pins that model too
    let config = config.with_model(Some("claude-sonnet-4-20250514".into()))?;
    assert_eq!(config.llm.provider, "anthropic");
    assert_eq!(
        config.llm.model_override,
        Some("claude-sonnet-4-20250514".to_string())
    );
    assert_eq!(config.active_llm()?.model, "claude-sonnet-4-20250514");
    Ok(())
}

#[test]
fn with_model_none_is_noop() -> TestResult {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    let config = config.with_model(None)?;
    assert_eq!(config.llm.provider, "");
    assert_eq!(config.llm.model_override, None);
    Ok(())
}

#[test]
fn validate_missing_provider() {
    let config = Config::new(std::path::PathBuf::from("/tmp"));
    // No providers configured, default provider "anthropic" won't be found
    let err = config.validate().unwrap_err();
    assert!(format!("{err}").contains("not found"));
}

#[test]
fn validate_missing_api_key() {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: String::new(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();
    let err = config.validate().unwrap_err();
    assert!(format!("{err}").contains("api_key not set"));
}

#[test]
fn validate_missing_base_url() {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: String::new(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();
    let err = config.validate().unwrap_err();
    assert!(format!("{err}").contains("base_url not set"));
}

#[test]
fn validate_missing_model() {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: Vec::new(),
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();
    let err = config.validate().unwrap_err();
    assert!(format!("{err}").contains("model not set"));
}

#[test]
fn validate_model_override_bypasses_empty_profile_model() {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: Vec::new(),
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();
    config.llm.model_override = Some("override-model".into());
    // Should pass because model_override is set
    assert!(config.validate().is_ok());
}

#[test]
fn provider_name_with_colon_rejected_in_toml() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"

[providers.anthropic]
api_key = "key"
base_url = "https://api.anthropic.com"
model = "claude-sonnet-4-20250514"

[providers."bad:name"]
api_key = "key"
base_url = "https://example.com"
model = "some-model"
"#,
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    assert!(result.is_err());
    let err = format!("{}", result.unwrap_err());
    assert!(err.contains("must not contain ':'"));
    Ok(())
}

#[test]
fn toml_provider_name_normalized_to_lowercase() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "openrouter"

[providers.OpenRouter]
api_key = "toml-key"
base_url = "https://openrouter.ai/api/v1"
model = "anthropic/claude-sonnet-4-20250514"
"#,
    )?;
    // env override should merge into the same normalized provider
    std::fs::write(
        env_home.join(".evotai").join("evot.env"),
        "EVOT_LLM_OPENROUTER_API_KEY=env-key\n",
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    // TOML "OpenRouter" should be normalized to "openrouter"
    assert!(config.providers.contains_key("openrouter"));
    assert!(!config.providers.contains_key("OpenRouter"));
    // env override should have merged into the same provider
    assert_eq!(config.active_llm()?.api_key, "env-key");
    assert_eq!(
        config.active_llm()?.base_url,
        "https://openrouter.ai/api/v1"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests covering NAPI set_model / set_provider core logic
// ---------------------------------------------------------------------------

fn make_multi_provider_config() -> Config {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "ant-key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config
        .providers
        .insert("openai".into(), evot::conf::ProviderProfile {
            protocol: Protocol::OpenAiResponses,
            api_key: "oai-key".into(),
            base_url: "https://api.openai.com/v1".into(),
            models: vec!["gpt-5.4".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config
        .providers
        .insert("deepseek".into(), evot::conf::ProviderProfile {
            protocol: Protocol::OpenAi,
            api_key: "ds-key".into(),
            base_url: "https://api.deepseek.com".into(),
            models: vec!["deepseek-chat".into()],
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

/// Simulates NAPI set_model: resolve model spec, build LlmConfig from provider profile.
fn resolve_llm_config(
    config: &Config,
    model_spec: &str,
) -> std::result::Result<evot::conf::LlmConfig, Box<dyn std::error::Error>> {
    let (provider_name, model_override) = config.resolve_model_spec(model_spec)?;
    config
        .build_llm(&provider_name, model_override)
        .map_err(Into::into)
}

#[test]
fn set_model_switches_provider_by_model_name() -> TestResult {
    let config = make_multi_provider_config();

    // Switch to openai by model name
    let llm = resolve_llm_config(&config, "gpt-5.4")?;
    assert_eq!(llm.provider, "openai");
    assert_eq!(llm.protocol, Protocol::OpenAiResponses);
    assert_eq!(llm.api_key, "oai-key");
    assert_eq!(llm.base_url, "https://api.openai.com/v1");
    assert_eq!(llm.model, "gpt-5.4");

    // Switch to deepseek by model name
    let llm = resolve_llm_config(&config, "deepseek-chat")?;
    assert_eq!(llm.provider, "deepseek");
    assert_eq!(llm.protocol, Protocol::OpenAi);
    assert_eq!(llm.api_key, "ds-key");
    assert_eq!(llm.base_url, "https://api.deepseek.com");
    assert_eq!(llm.model, "deepseek-chat");

    // Switch back to anthropic by model name
    let llm = resolve_llm_config(&config, "claude-sonnet-4-20250514")?;
    assert_eq!(llm.provider, "anthropic");
    assert_eq!(llm.protocol, Protocol::Anthropic);
    assert_eq!(llm.api_key, "ant-key");
    assert_eq!(llm.base_url, "https://api.anthropic.com");
    Ok(())
}

#[test]
fn set_model_with_provider_prefix_overrides_model() -> TestResult {
    let config = make_multi_provider_config();

    // Use provider:model to override model
    let llm = resolve_llm_config(&config, "openai:gpt-4o")?;
    assert_eq!(llm.provider, "openai");
    assert_eq!(llm.protocol, Protocol::OpenAiResponses);
    assert_eq!(llm.api_key, "oai-key");
    assert_eq!(llm.base_url, "https://api.openai.com/v1");
    assert_eq!(llm.model, "gpt-4o"); // overridden, not the default gpt-5.4

    // Override anthropic model
    let llm = resolve_llm_config(&config, "anthropic:claude-opus-4-6")?;
    assert_eq!(llm.provider, "anthropic");
    assert_eq!(llm.protocol, Protocol::Anthropic);
    assert_eq!(llm.model, "claude-opus-4-6");
    Ok(())
}

#[test]
fn set_model_unknown_model_returns_error() {
    let config = make_multi_provider_config();
    assert!(resolve_llm_config(&config, "nonexistent-model").is_err());
}

#[test]
fn set_model_unknown_provider_returns_error() {
    let config = make_multi_provider_config();
    assert!(resolve_llm_config(&config, "badprovider:some-model").is_err());
}

#[test]
fn set_model_empty_model_in_spec_returns_error() {
    let config = make_multi_provider_config();
    assert!(resolve_llm_config(&config, "openai:").is_err());
}

#[test]
fn set_provider_validates_incomplete_provider() {
    let mut config = Config::new(std::path::PathBuf::from("/tmp"));
    config
        .providers
        .insert("anthropic".into(), evot::conf::ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-20250514".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config
        .providers
        .insert("broken".into(), evot::conf::ProviderProfile {
            protocol: Protocol::OpenAi,
            api_key: String::new(), // missing
            base_url: "https://example.com".into(),
            models: vec!["some-model".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });

    // Resolving the broken provider succeeds at spec level
    let llm = resolve_llm_config(&config, "some-model");
    assert!(llm.is_ok());
    // But the resulting LlmConfig has empty api_key — NAPI set_provider would reject this
    assert!(llm.as_ref().is_ok_and(|l| l.api_key.is_empty()));
}

#[test]
fn multi_model_env_comma_separated() {
    let dir = tempfile::tempdir().unwrap();
    let env_path = dir.path().join(".env");
    std::fs::write(
        &env_path,
        "\
EVOT_LLM_PROVIDER=anthropic
EVOT_LLM_ANTHROPIC_API_KEY=sk-test
EVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com
EVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-6,claude-opus-4-6
",
    )
    .unwrap();

    let config = Config::load_with_env_file(Some(env_path.to_str().unwrap())).unwrap();
    let profile = config.providers.get("anthropic").unwrap();
    assert_eq!(profile.models, vec!["claude-sonnet-4-6", "claude-opus-4-6"]);
    assert_eq!(profile.model(), "claude-sonnet-4-6");
}

#[test]
fn multi_model_bare_lookup_resolves_non_default() {
    let dir = tempfile::tempdir().unwrap();
    let env_path = dir.path().join(".env");
    std::fs::write(
        &env_path,
        "\
EVOT_LLM_PROVIDER=anthropic
EVOT_LLM_ANTHROPIC_API_KEY=sk-test
EVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com
EVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-6,claude-opus-4-6
",
    )
    .unwrap();

    let config = Config::load_with_env_file(Some(env_path.to_str().unwrap())).unwrap();

    let (provider, model_override) = config.resolve_model_spec("claude-opus-4-6").unwrap();
    assert_eq!(provider, "anthropic");
    assert_eq!(model_override, Some("claude-opus-4-6".to_string()));
}

#[test]
fn multi_model_toml_array() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let temp = tempfile::tempdir()?;
    let env_home = temp.path().join("home");
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::fs::write(
        env_home.join(".evotai").join("evot.toml"),
        r#"
[llm]
provider = "anthropic"

[providers.anthropic]
api_key = "test-key"
base_url = "https://api.anthropic.com"
model = ["claude-sonnet-4-6", "claude-opus-4-6"]
"#,
    )?;

    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &env_home);

    let result = Config::load();

    restore_env_var("HOME", original_home);

    let config = result?;
    let profile = config.providers.get("anthropic").unwrap();
    assert_eq!(profile.models, vec!["claude-sonnet-4-6", "claude-opus-4-6"]);
    assert_eq!(profile.model(), "claude-sonnet-4-6");
    Ok(())
}
