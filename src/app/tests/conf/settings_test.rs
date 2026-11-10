use std::path::PathBuf;

use evot::conf::apply_feishu_settings;
use evot::conf::apply_model_settings;
use evot::conf::config_to_env_groups;
use evot::conf::env_writer::write_grouped;
use evot::conf::env_writer::EnvGroup;
use evot::conf::Config;
use evot::conf::FeishuSettings;
use evot::conf::ModelSettings;
use evot::conf::ProviderSettings;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

/// Flatten all groups into a single key->value map for assertions.
fn flat(groups: &[EnvGroup]) -> std::collections::HashMap<String, String> {
    groups
        .iter()
        .flat_map(|g| g.pairs.iter().cloned())
        .collect()
}

/// Apply the sample model + feishu updates into a fresh config and return the
/// groups derived from it — mirrors what the server does across both saves.
fn sample_groups() -> Vec<EnvGroup> {
    let mut config = Config::new(std::env::temp_dir());
    if let Err(e) = apply_model_settings(&mut config, &sample_models()) {
        panic!("apply sample models: {e}");
    }
    if let Err(e) = apply_feishu_settings(&mut config, &sample_feishu()) {
        panic!("apply sample feishu: {e}");
    }
    config_to_env_groups(&config)
}

fn tmp_env_path(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("evot_settings_test_{tag}_{nanos}.env"));
    p
}

fn sample_models() -> ModelSettings {
    ModelSettings {
        active_provider: "anthropic".into(),
        active_model: None,
        thinking_level: Some("high".into()),
        providers: vec![ProviderSettings {
            name: "anthropic".into(),
            protocol: "anthropic".into(),
            api_key: Some("sk-secret-123".into()),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-6".into(), "claude-opus-4-6".into()],
            thinking_level: Some("xhigh".into()),
        }],
    }
}

fn sample_feishu() -> FeishuSettings {
    FeishuSettings {
        app_id: "cli_app".into(),
        app_secret: Some("feishu-secret".into()),
        mention_only: false,
        default_chat_id: Some("oc_daily_report".into()),
    }
}

#[test]
fn settings_serialize_to_expected_env_keys() {
    let map = flat(&sample_groups());
    assert_eq!(
        map.get("EVOT_LLM_PROVIDER").map(String::as_str),
        Some("anthropic")
    );
    assert_eq!(
        map.get("EVOT_LLM_THINKING_LEVEL").map(String::as_str),
        Some("high")
    );
    assert_eq!(
        map.get("EVOT_LLM_ANTHROPIC_MODEL").map(String::as_str),
        Some("claude-sonnet-4-6,claude-opus-4-6")
    );
    assert_eq!(
        map.get("EVOT_LLM_ANTHROPIC_API_KEY").map(String::as_str),
        Some("sk-secret-123")
    );
    assert_eq!(
        map.get("EVOT_LLM_ANTHROPIC_THINKING_LEVEL")
            .map(String::as_str),
        Some("xhigh")
    );
    assert_eq!(
        map.get("EVOT_CHANNEL_FEISHU_APP_ID").map(String::as_str),
        Some("cli_app")
    );
    assert_eq!(
        map.get("EVOT_CHANNEL_FEISHU_MENTION_ONLY")
            .map(String::as_str),
        Some("false")
    );
    assert_eq!(
        map.get("EVOT_CHANNEL_FEISHU_DEFAULT_CHAT_ID")
            .map(String::as_str),
        Some("oc_daily_report")
    );
}

#[test]
fn custom_provider_capabilities_survive_settings_serialization() -> TestResult {
    let mut config = Config::new(std::env::temp_dir());
    config
        .providers
        .insert("corp".into(), evot::conf::ProviderProfile {
            protocol: evot::conf::Protocol::OpenAiResponses,
            api_key: "sk-corp".into(),
            base_url: "https://corp.example/v1".into(),
            models: vec!["corp-model".into()],
            compat_caps: evot_engine::provider::CompatCaps::REASONING_EFFORT,
            route_capabilities: evot_engine::provider::RouteCapabilityOverrides {
                verbosity: true,
                remote_compaction: true,
            },
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "corp".into();

    let map = flat(&config_to_env_groups(&config));
    assert_eq!(
        map.get("EVOT_LLM_CORP_COMPAT_CAPS").map(String::as_str),
        Some("reasoning_effort,verbosity,remote_compaction")
    );
    Ok(())
}

#[test]
fn blank_global_thinking_level_restores_model_default() {
    let mut config = Config::new(std::env::temp_dir());
    config.llm.thinking_level = Some(evot_engine::ThinkingLevel::High);
    let mut update = sample_models();
    update.thinking_level = None;

    if let Err(error) = apply_model_settings(&mut config, &update) {
        panic!("apply: {error}");
    }

    assert_eq!(config.llm.thinking_level, None);
    let map = flat(&config_to_env_groups(&config));
    assert!(!map.contains_key("EVOT_LLM_THINKING_LEVEL"));
}

#[test]
fn groups_are_titled_and_separated() {
    let groups = sample_groups();
    // One global selection group + one provider group + one Feishu group.
    assert_eq!(groups.len(), 3);
    assert_eq!(groups[0].title, "Active selection");
    assert_eq!(groups[1].title, "Provider: anthropic");
    assert_eq!(groups[2].title, "Channel: Feishu bot");
}

#[test]
fn empty_secret_is_not_serialized() {
    // A provider/feishu with no stored secret omits the secret key entirely.
    let mut config = Config::new(std::env::temp_dir());
    let mut models = sample_models();
    models.providers[0].api_key = None;
    let mut feishu = sample_feishu();
    feishu.app_secret = Some(String::new());
    if let Err(e) = apply_model_settings(&mut config, &models) {
        panic!("apply models: {e}");
    }
    if let Err(e) = apply_feishu_settings(&mut config, &feishu) {
        panic!("apply feishu: {e}");
    }
    let map = flat(&config_to_env_groups(&config));
    assert!(!map.contains_key("EVOT_LLM_ANTHROPIC_API_KEY"));
    assert!(!map.contains_key("EVOT_CHANNEL_FEISHU_APP_SECRET"));
}

#[test]
fn write_grouped_renders_managed_block_with_headers() -> TestResult {
    let path = tmp_env_path("grouped");
    write_grouped(&path, &sample_groups())?;
    let content = std::fs::read_to_string(&path)?;
    assert!(content.contains("# >>> evot managed"));
    assert!(content.contains("# <<< evot managed"));
    assert!(content.contains("# Active selection"));
    assert!(content.contains("# Provider: anthropic"));
    assert!(content.contains("# Channel: Feishu bot"));
    assert!(content.contains("EVOT_LLM_ANTHROPIC_API_KEY=sk-secret-123"));
    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn write_grouped_preserves_user_lines_and_dedupes() -> TestResult {
    let path = tmp_env_path("dedupe");
    // Pre-existing file: a user comment + custom key, plus a stale managed key
    // sitting outside any block that must be deduped away.
    std::fs::write(
        &path,
        "# my notes\nMY_CUSTOM_VAR=keepme\nEVOT_LLM_PROVIDER=stale-openai\n",
    )?;
    write_grouped(&path, &sample_groups())?;
    let content = std::fs::read_to_string(&path)?;
    // User content survives.
    assert!(content.contains("# my notes"));
    assert!(content.contains("MY_CUSTOM_VAR=keepme"));
    // The managed key appears exactly once, with the new value.
    assert_eq!(content.matches("EVOT_LLM_PROVIDER=").count(), 1);
    assert!(content.contains("EVOT_LLM_PROVIDER=anthropic"));
    assert!(!content.contains("stale-openai"));
    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn write_grouped_is_idempotent_across_saves() -> TestResult {
    let path = tmp_env_path("idem");
    let groups = sample_groups();
    write_grouped(&path, &groups)?;
    let first = std::fs::read_to_string(&path)?;
    // Saving the same settings again must not grow or duplicate the block.
    write_grouped(&path, &groups)?;
    let second = std::fs::read_to_string(&path)?;
    assert_eq!(first, second);
    assert_eq!(second.matches("# >>> evot managed").count(), 1);
    assert_eq!(second.matches("EVOT_LLM_ANTHROPIC_API_KEY=").count(), 1);
    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn resave_keeps_all_managed_keys_inside_block() -> TestResult {
    // Regression: editing a config on the web and saving must not leave any
    // EVOT_* key (especially secrets) stranded outside the managed block.
    let path = tmp_env_path("resave");
    // Simulate a hand-written file with scattered managed keys and a secret.
    std::fs::write(
        &path,
        "EVOT_LLM_ANTHROPIC_API_KEY=old-secret\n\
         EVOT_LLM_DEEPMI_BASE_URL=https://example.com\n\
         EVOT_CHANNEL_FEISHU_APP_SECRET=old-feishu\n\
         EVOT_TELEMETRY_ENDPOINT=http://localhost:3100\n",
    )?;
    write_grouped(&path, &sample_groups())?;
    let content = std::fs::read_to_string(&path)?;

    // Split into preamble (before block) and the managed block.
    let begin = content
        .find("# >>> evot managed")
        .ok_or("managed block missing")?;
    let preamble = &content[..begin];

    // No EVOT_LLM_* or EVOT_CHANNEL_FEISHU_* assignment may sit in the preamble.
    for line in preamble.lines() {
        let t = line.trim();
        assert!(
            !t.starts_with("EVOT_LLM_") && !t.starts_with("EVOT_CHANNEL_FEISHU_"),
            "managed key stranded outside block: {t}"
        );
    }
    // Stale provider + old secrets are gone; the new secret lives in the block.
    assert!(!content.contains("old-secret"));
    assert!(!content.contains("old-feishu"));
    assert!(!content.contains("EVOT_LLM_DEEPMI_BASE_URL"));
    assert_eq!(content.matches("EVOT_LLM_ANTHROPIC_API_KEY=").count(), 1);
    // Foreign keys are preserved.
    assert!(content.contains("EVOT_TELEMETRY_ENDPOINT=http://localhost:3100"));
    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn round_trip_persists_and_reloads() -> TestResult {
    let path = tmp_env_path("roundtrip");
    write_grouped(&path, &sample_groups())?;

    let mut config = Config::new(std::env::temp_dir());
    let loaded = Config::load_with_env_file(path.to_str())?;
    // load_with_env_file reads the real default TOML too, but our temp env file
    // drives the provider values we care about here.
    config.providers = loaded.providers;
    config.llm = loaded.llm;

    let anthropic = config
        .providers
        .get("anthropic")
        .ok_or("anthropic provider missing after reload")?;
    assert_eq!(anthropic.api_key, "sk-secret-123");
    assert_eq!(anthropic.model(), "claude-sonnet-4-6");
    assert_eq!(config.llm.provider, "anthropic");
    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn saves_preserve_blank_secrets() -> TestResult {
    // Seed a config with existing secrets, then re-save with both left blank.
    // Each page's save must keep the persisted value rather than clearing it.
    let mut config = Config::new(std::env::temp_dir());
    let mut models = sample_models();
    let mut feishu = sample_feishu();
    apply_model_settings(&mut config, &models)?;
    apply_feishu_settings(&mut config, &feishu)?;
    assert_eq!(
        config
            .providers
            .get("anthropic")
            .map(|p| p.api_key.as_str()),
        Some("sk-secret-123")
    );

    models.providers[0].api_key = None;
    feishu.app_secret = None;
    apply_model_settings(&mut config, &models)?;
    apply_feishu_settings(&mut config, &feishu)?;
    assert_eq!(
        config
            .providers
            .get("anthropic")
            .map(|p| p.api_key.as_str()),
        Some("sk-secret-123")
    );
    assert_eq!(
        config
            .channels
            .feishu
            .as_ref()
            .map(|f| f.app_secret.as_str()),
        Some("feishu-secret")
    );
    Ok(())
}

#[test]
fn saving_models_leaves_feishu_untouched() -> TestResult {
    // The pages save independently, so a Models save must not disturb the
    // channel config — and vice versa.
    let mut config = Config::new(std::env::temp_dir());
    apply_feishu_settings(&mut config, &sample_feishu())?;
    apply_model_settings(&mut config, &sample_models())?;

    let feishu = config.channels.feishu.as_ref().ok_or("feishu dropped")?;
    assert_eq!(feishu.app_id, "cli_app");
    assert_eq!(feishu.app_secret, "feishu-secret");
    assert!(!feishu.mention_only);
    assert_eq!(feishu.default_chat_id, "oc_daily_report");

    // And the reverse: saving Feishu keeps providers and the active selection.
    apply_feishu_settings(&mut config, &FeishuSettings {
        app_id: "cli_app".into(),
        app_secret: None,
        mention_only: true,
        default_chat_id: None,
    })?;
    let feishu = config.channels.feishu.as_ref().ok_or("feishu dropped")?;
    assert_eq!(feishu.default_chat_id, "oc_daily_report");
    assert!(config.providers.contains_key("anthropic"));
    assert_eq!(config.llm.provider, "anthropic");
    assert_eq!(
        config
            .providers
            .get("anthropic")
            .map(|p| p.api_key.as_str()),
        Some("sk-secret-123")
    );
    Ok(())
}

#[test]
fn switching_feishu_app_requires_credentials_and_discards_old_bindings() -> TestResult {
    let mut config = Config::new(std::env::temp_dir());
    apply_feishu_settings(&mut config, &sample_feishu())?;
    let mut update = sample_feishu();
    update.app_id = "new_app".into();
    update.app_secret = None;
    assert!(apply_feishu_settings(&mut config, &update).is_err());
    assert_eq!(
        config
            .channels
            .feishu
            .as_ref()
            .ok_or("missing channel")?
            .app_id,
        "cli_app"
    );
    update.app_secret = Some("new_secret".into());
    apply_feishu_settings(&mut config, &update)?;
    let channel = config.channels.feishu.as_ref().ok_or("missing channel")?;
    assert_eq!(channel.app_secret, "new_secret");
    assert!(channel.default_chat_id.is_empty());
    assert!(channel.allow_from.is_empty());
    Ok(())
}

#[test]
fn invalid_feishu_default_chat_id_is_rejected() {
    let mut config = Config::new(std::env::temp_dir());
    let mut settings = sample_feishu();
    settings.default_chat_id = Some("invalid".into());
    assert!(apply_feishu_settings(&mut config, &settings).is_err());
    assert!(config.channels.feishu.is_none());
}

#[test]
fn blank_feishu_app_id_unlinks_the_channel() -> TestResult {
    let mut config = Config::new(std::env::temp_dir());
    apply_feishu_settings(&mut config, &sample_feishu())?;
    assert!(config.channels.feishu.is_some());

    apply_feishu_settings(&mut config, &FeishuSettings {
        app_id: "   ".into(),
        app_secret: None,
        mention_only: true,
        default_chat_id: Some(String::new()),
    })?;
    assert!(config.channels.feishu.is_none());
    let map = flat(&config_to_env_groups(&config));
    assert!(!map.contains_key("EVOT_CHANNEL_FEISHU_APP_ID"));
    Ok(())
}

#[test]
fn apply_model_settings_rejects_unknown_active_provider() {
    let mut config = Config::new(std::env::temp_dir());
    let mut update = sample_models();
    update.active_provider = "ghost".into();
    assert!(apply_model_settings(&mut config, &update).is_err());
}

#[test]
fn reloading_env_file_reflects_external_edits() -> TestResult {
    // Regression: the console must read the env file fresh, so an edit made
    // outside the dashboard is visible instead of a stale in-memory value.
    // This mirrors what the server's GET /api/models reload does.
    let path = tmp_env_path("external_edit");
    write_grouped(&path, &sample_groups())?;

    let path_arg = path.to_str();
    let before = Config::load_with_env_file(path_arg)?;
    assert_eq!(
        before
            .providers
            .get("anthropic")
            .map(|p| p.api_key.as_str()),
        Some("sk-secret-123")
    );

    // Someone hand-edits the file, rotating the key.
    let edited = std::fs::read_to_string(&path)?.replace("sk-secret-123", "sk-rotated-999");
    std::fs::write(&path, edited)?;

    // A fresh load (what the page reload does) must see the new value.
    let after = Config::load_with_env_file(path_arg)?;
    assert_eq!(
        after.providers.get("anthropic").map(|p| p.api_key.as_str()),
        Some("sk-rotated-999")
    );
    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn persist_default_thinking_level_updates_global_and_masking_override() -> TestResult {
    let mut config = Config::new(std::env::temp_dir());
    apply_model_settings(&mut config, &sample_models())?;
    config.env_file_path = tmp_env_path("persist_thinking");

    // anthropic carries its own override ("xhigh") which would mask the global,
    // so persisting must update both.
    let low = evot::conf::thinking_level_from_str("low")?;
    evot::conf::persist_default_thinking_level(&mut config, "anthropic", low)?;
    assert_eq!(config.llm.thinking_level, Some(low));
    assert_eq!(
        config
            .providers
            .get("anthropic")
            .and_then(|p| p.thinking_level),
        Some(low)
    );
    let written = std::fs::read_to_string(&config.env_file_path)?;
    assert!(written.contains("EVOT_LLM_THINKING_LEVEL=low"));
    assert!(written.contains("EVOT_LLM_ANTHROPIC_THINKING_LEVEL=low"));

    // A provider without its own override keeps inheriting the global.
    if let Some(p) = config.providers.get_mut("anthropic") {
        p.thinking_level = None;
    }
    let high = evot::conf::thinking_level_from_str("high")?;
    evot::conf::persist_default_thinking_level(&mut config, "anthropic", high)?;
    assert_eq!(config.llm.thinking_level, Some(high));
    assert_eq!(
        config
            .providers
            .get("anthropic")
            .and_then(|p| p.thinking_level),
        None
    );
    let written = std::fs::read_to_string(&config.env_file_path)?;
    assert!(written.contains("EVOT_LLM_THINKING_LEVEL=high"));
    assert!(!written.contains("EVOT_LLM_ANTHROPIC_THINKING_LEVEL"));

    std::fs::remove_file(&config.env_file_path)?;
    Ok(())
}

#[test]
fn settings_save_works_when_every_provider_is_cloud() -> TestResult {
    // Fresh install, logged in, no BYOK: the page has nothing editable to send,
    // so the payload carries an empty provider list and a cloud active name.
    let mut config = Config::new(std::env::temp_dir());
    config
        .providers
        .insert("evot-free".into(), evot::conf::ProviderProfile {
            protocol: evot::conf::Protocol::Anthropic,
            api_key: "evot.scoped.token".into(),
            base_url: "https://auto.evot.ai/v1/llm".into(),
            models: vec!["cloud-model".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.cloud_providers.insert("evot-free".into());

    apply_model_settings(&mut config, &ModelSettings {
        active_provider: "evot-free".into(),
        active_model: None,
        thinking_level: Some("high".into()),
        providers: Vec::new(),
    })?;

    assert_eq!(config.llm.provider, "evot-free");
    assert!(config.providers.contains_key("evot-free"));
    let map = flat(&config_to_env_groups(&config));
    assert!(!map.contains_key("EVOT_LLM_EVOT_FREE_API_KEY"));
    Ok(())
}

fn config_with_cloud_provider() -> Config {
    let mut config = Config::new(std::env::temp_dir());
    if let Err(e) = apply_model_settings(&mut config, &sample_models()) {
        panic!("apply sample models: {e}");
    }
    config
        .providers
        .insert("evot-free".into(), evot::conf::ProviderProfile {
            protocol: evot::conf::Protocol::Anthropic,
            api_key: "evot.scoped.token".into(),
            base_url: "https://auto.evot.ai/v1/llm".into(),
            models: vec!["cloud-model".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.cloud_providers.insert("evot-free".into());
    config
}

#[test]
fn cloud_provider_is_never_written_to_env() {
    let config = config_with_cloud_provider();
    let groups = config_to_env_groups(&config);
    let map = flat(&groups);

    assert!(!map.contains_key("EVOT_LLM_EVOT_FREE_API_KEY"));
    assert!(!map.contains_key("EVOT_LLM_EVOT_FREE_BASE_URL"));
    assert!(!map.contains_key("EVOT_LLM_EVOT_FREE_MODEL"));
    assert!(!groups.iter().any(|g| g.title.contains("evot-free")));
    assert_eq!(
        map.get("EVOT_LLM_ANTHROPIC_API_KEY").map(String::as_str),
        Some("sk-secret-123")
    );
}

#[test]
fn cloud_provider_survives_a_settings_save() -> TestResult {
    let mut config = config_with_cloud_provider();
    apply_model_settings(&mut config, &sample_models())?;

    let cloud = config
        .providers
        .get("evot-free")
        .ok_or("cloud provider dropped by settings save")?;
    assert_eq!(cloud.api_key, "evot.scoped.token");
    assert_eq!(cloud.models, vec!["cloud-model"]);
    assert!(config.providers.contains_key("anthropic"));
    Ok(())
}

#[test]
fn cloud_provider_cannot_be_edited_through_settings() -> TestResult {
    let mut config = config_with_cloud_provider();
    let mut update = sample_models();
    update.providers.push(ProviderSettings {
        name: "evot-free".into(),
        protocol: "openai".into(),
        api_key: Some("attacker-key".into()),
        base_url: "https://evil.example".into(),
        models: vec!["ghost".into()],
        thinking_level: None,
    });
    apply_model_settings(&mut config, &update)?;

    let cloud = config
        .providers
        .get("evot-free")
        .ok_or("cloud provider missing")?;
    assert_eq!(cloud.base_url, "https://auto.evot.ai/v1/llm");
    assert_eq!(cloud.api_key, "evot.scoped.token");
    assert_eq!(cloud.protocol, evot::conf::Protocol::Anthropic);
    Ok(())
}

#[test]
fn cloud_provider_stays_selectable_as_active() -> TestResult {
    let mut config = config_with_cloud_provider();
    let mut update = sample_models();
    update.active_provider = "evot-free".into();
    apply_model_settings(&mut config, &update)?;

    assert_eq!(config.llm.provider, "evot-free");
    let map = flat(&config_to_env_groups(&config));
    assert_eq!(
        map.get("EVOT_LLM_PROVIDER").map(String::as_str),
        Some("evot-free")
    );
    assert!(!map.contains_key("EVOT_LLM_EVOT_FREE_API_KEY"));
    Ok(())
}

#[test]
fn saving_settings_cleans_cloud_keys_out_of_an_existing_env_file() -> TestResult {
    let path = tmp_env_path("selfheal_cloud");
    std::fs::write(
        &path,
        "\
# >>> evot managed (edited via dashboard) >>>

# Provider: evot-free
EVOT_LLM_EVOT_FREE_PROTOCOL=anthropic
EVOT_LLM_EVOT_FREE_API_KEY=evot.scoped.token
# <<< evot managed <<<
",
    )?;

    let config = config_with_cloud_provider();
    write_grouped(&path, &config_to_env_groups(&config))?;

    let content = std::fs::read_to_string(&path)?;
    assert!(!content.contains("evot.scoped.token"));
    assert!(!content.contains("EVOT_LLM_EVOT_FREE_PROTOCOL"));
    assert!(content.contains("EVOT_LLM_ANTHROPIC_API_KEY=sk-secret-123"));

    std::fs::remove_file(&path)?;
    Ok(())
}

#[test]
fn purge_providers_from_env_removes_stale_cloud_keys() -> TestResult {
    let path = tmp_env_path("purge_cloud");
    std::fs::write(
        &path,
        "\
# user note
EVOT_TELEMETRY_ENDPOINT=http://localhost:3100

# >>> evot managed (edited via dashboard) >>>

# Active selection
EVOT_LLM_PROVIDER=evot-free

# Provider: evot-free
EVOT_LLM_EVOT_FREE_PROTOCOL=anthropic
EVOT_LLM_EVOT_FREE_API_KEY=evot.scoped.token

# Provider: anthropic
EVOT_LLM_ANTHROPIC_API_KEY=sk-byok
# <<< evot managed <<<
EVOT_LLM_EVOT_PRO_OPENAI_API_KEY=evot.other.token
",
    )?;

    let purged = evot::conf::purge_providers_from_env(&path, &[
        "evot-free".to_string(),
        "evot-pro-openai".to_string(),
    ])?;
    assert!(purged);

    let content = std::fs::read_to_string(&path)?;
    assert!(!content.contains("evot.scoped.token"));
    assert!(!content.contains("evot.other.token"));
    assert!(!content.contains("EVOT_LLM_EVOT_FREE_PROTOCOL"));
    assert!(!content.contains("# Provider: evot-free"));
    assert!(!content.contains("\n\n\n"));
    assert!(content.contains("# user note"));
    assert!(content.contains("EVOT_TELEMETRY_ENDPOINT=http://localhost:3100"));
    assert!(content.contains("EVOT_LLM_ANTHROPIC_API_KEY=sk-byok"));
    assert!(content.contains("# Provider: anthropic"));
    assert!(content.contains("# Active selection"));
    assert_eq!(content.matches("# >>> evot managed").count(), 1);
    assert_eq!(content.matches("# <<< evot managed").count(), 1);

    assert!(!evot::conf::purge_providers_from_env(&path, &[
        "evot-free".to_string()
    ])?);

    std::fs::remove_file(&path)?;
    Ok(())
}
