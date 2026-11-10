use std::collections::HashMap;

use super::env_keys::apply_provider_field;
use super::env_keys::parse_legacy_env_key;
use super::env_keys::parse_provider_env_key;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::base::paths;
use crate::conf::channels::FeishuChannelConfig;
use crate::conf::thinking_level_from_str;
use crate::conf::Config;

pub(super) fn apply_env(config: &mut Config, vars: &[(String, String)]) -> Result<()> {
    // First pass: legacy keys (lower priority)
    for (key, value) in vars {
        if let Some((provider_name, field)) = parse_legacy_env_key(key) {
            // Only apply if no new-format key has set this provider yet
            if !has_new_format_provider(vars, provider_name) {
                apply_provider_field(&mut config.providers, provider_name, field, value)?;
            }
        }
    }

    // Second pass: new format EVOT_LLM_{NAME}_{FIELD}
    for (key, value) in vars {
        if let Some((provider_name, field)) = parse_provider_env_key(key) {
            apply_provider_field(&mut config.providers, &provider_name, field, value)?;
        }
    }

    // Global LLM keys
    for (key, value) in vars {
        match key.as_str() {
            "EVOT_LLM_PROVIDER" => config.llm.provider = value.clone(),
            "EVOT_LLM_THINKING_LEVEL" => {
                config.llm.thinking_level = Some(thinking_level_from_str(value)?);
            }
            // Legacy thinking level key
            "EVOT_THINKING_LEVEL" => {
                config.llm.thinking_level = Some(thinking_level_from_str(value)?);
            }
            _ => {}
        }
    }

    // Server
    for (key, value) in vars {
        match key.as_str() {
            "EVOT_SERVER_HOST" => config.server.host = value.clone(),
            "EVOT_SERVER_PORT" => {
                config.server.port = value.parse::<u16>().map_err(|e| {
                    EvotError::Conf(format!("invalid EVOT_SERVER_PORT value {value}: {e}"))
                })?;
            }
            _ => {}
        }
    }

    // Storage
    for (key, value) in vars {
        if key == "EVOT_STORAGE_FS_ROOT_DIR" {
            config.storage.fs.root_dir = paths::expand_home_path(value)?;
        }
    }

    // Feishu channel
    let feishu_app_id = vars.iter().find(|(k, _)| k == "EVOT_CHANNEL_FEISHU_APP_ID");
    if let Some((_, app_id)) = feishu_app_id {
        let vars_map: HashMap<&str, &str> =
            vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let app_secret = vars_map
            .get("EVOT_CHANNEL_FEISHU_APP_SECRET")
            .copied()
            .unwrap_or_default()
            .to_string();
        let mention_only = vars_map
            .get("EVOT_CHANNEL_FEISHU_MENTION_ONLY")
            .map(|v| *v != "0" && v.to_lowercase() != "false")
            .unwrap_or(true);
        let default_chat_id = vars_map
            .get("EVOT_CHANNEL_FEISHU_DEFAULT_CHAT_ID")
            .copied()
            .unwrap_or_default()
            .trim()
            .to_string();
        config.channels.feishu = Some(FeishuChannelConfig {
            app_id: app_id.clone(),
            app_secret,
            mention_only,
            allow_from: Vec::new(),
            default_chat_id,
        });
    }

    // Sandbox
    for (key, value) in vars {
        match key.as_str() {
            "EVOT_SANDBOX" => {
                config.sandbox.enabled = value == "true" || value == "1";
            }
            "EVOT_SANDBOX_ALLOWED_DIRS" => {
                let mut dirs = Vec::new();
                for d in value.split(':') {
                    let d = d.trim();
                    if !d.is_empty() {
                        dirs.push(paths::expand_home_path(d)?);
                    }
                }
                if !dirs.is_empty() {
                    config.sandbox.allowed_dirs = dirs;
                }
            }
            _ => {}
        }
    }

    // Skills
    for (key, value) in vars {
        if key == "EVOT_SKILLS_DIRS" {
            for d in value.split(':') {
                let d = d.trim();
                if !d.is_empty() {
                    config.skills_dirs.push(paths::expand_home_path(d)?);
                }
            }
        }
    }

    // Instance ID
    for (key, value) in vars {
        if key == "EVOT_ID" {
            let val = value.trim();
            if !val.is_empty() {
                config.id = Some(val.to_string());
            }
        }
    }

    Ok(())
}

/// Check if any new-format key (EVOT_LLM_{NAME}_*) exists for a given provider name.
fn has_new_format_provider(vars: &[(String, String)], provider_name: &str) -> bool {
    let prefix = format!(
        "EVOT_LLM_{}_",
        provider_name.to_uppercase().replace('-', "_")
    );
    vars.iter().any(|(k, _)| k.starts_with(&prefix))
}
