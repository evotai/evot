use std::collections::HashMap;

use serde_json::json;
use serde_json::Value;

use super::ModelSelection;
use crate::auth::FreeModelOption;
use crate::conf::Config;
use crate::conf::LlmConfig;

/// Build the model picker catalog from caller-owned snapshots, without I/O or
/// live selection changes. Preserve provider/model order; clients use the
/// supplied rank fields when merging cloud groups.
///
/// This returns the existing addon JSON contract: in particular `free` remains
/// the cloud presentation field, even for groups with non-free tiers.
pub fn model_catalog(
    config: &Config,
    current: &LlmConfig,
    model_meta: &HashMap<String, FreeModelOption>,
    cloud_groups: &HashMap<String, (String, i64)>,
) -> Vec<Value> {
    let mut models = Vec::new();
    for (provider, profile) in &config.providers {
        for model in &profile.models {
            let model = model.trim();
            if model.is_empty() {
                continue;
            }
            let mut entry = json!({
                "provider": provider,
                "protocol": profile.protocol.to_string(),
                "model": model,
                "spec": format!("{provider}:{model}"),
            });
            attach_thinking_levels(&mut entry, config, provider, model);
            // Membership, not a provider name prefix, determines cloud status.
            if let Some((label, order)) = cloud_groups.get(provider) {
                entry["group_label"] = json!(label);
                entry["group_order"] = json!(order);
                entry["sort_order"] =
                    json!(config.cloud_model_sorts.get(model).copied().unwrap_or(0));
                entry["free"] = match model_meta.get(model) {
                    Some(meta) => json!({
                        "display_name": meta.display_name,
                        "tagline": meta.tagline,
                        "is_new": meta.is_new,
                        "tier": meta.tier,
                    }),
                    None => json!({}),
                };
            }
            models.push(entry);
        }
    }
    let current_is_listed = config
        .providers
        .get(&current.provider)
        .is_some_and(|profile| {
            profile
                .models
                .iter()
                .any(|model| model.trim() == current.model.trim())
        });
    if !current.model.trim().is_empty()
        && !current_is_listed
        && config.providers.contains_key(&current.provider)
    {
        // Preserve the historical fallback: use the live protocol/model verbatim
        // and do not attach cloud presentation to a model absent from the list.
        let mut entry = json!({
            "provider": current.provider,
            "protocol": current.protocol.to_string(),
            "model": current.model,
            "spec": format!("{}:{}", current.provider, current.model),
        });
        attach_thinking_levels(&mut entry, config, &current.provider, &current.model);
        models.push(entry);
    }
    models
}

/// Models without selectable reasoning omit both fields, rather than emitting
/// an empty ladder or a default that the provider cannot actually support.
fn attach_thinking_levels(entry: &mut Value, config: &Config, provider: &str, model: &str) {
    let Ok(llm) = config.build_llm(provider, Some(model.to_string())) else {
        return;
    };
    let levels = ModelSelection::supported_thinking_levels_for(&llm);
    if levels.is_empty() {
        return;
    }
    entry["thinking_levels"] = json!(levels.iter().map(|l| l.as_str()).collect::<Vec<_>>());
    entry["thinking_level"] = json!(llm.thinking_level.as_str());
}
