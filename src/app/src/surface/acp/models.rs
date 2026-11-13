//! ACP clients may validate saved model IDs against the advertised choices
//! before sending a switch. Keep both published cloud group shapes visible.

use std::collections::HashSet;

use agent_client_protocol_schema::v1 as acp;

use crate::conf::Config;
use crate::conf::Protocol;

pub(super) fn model_options(config: &Config) -> Vec<acp::SessionConfigSelectOption> {
    let mut options: Vec<_> = config
        .providers
        .iter()
        .flat_map(|(provider, profile)| {
            profile
                .models
                .iter()
                .map(move |model| option(provider, model))
        })
        .collect();
    let mut listed: HashSet<String> = options
        .iter()
        .map(|option| option.value.0.to_string())
        .collect();

    for (provider, profile) in &config.providers {
        // Names are not ownership: user-managed providers never get aliases.
        if !config.cloud_providers.contains(provider) {
            continue;
        }
        for model in &profile.models {
            // The catalog has used one group per tier and one per
            // (tier, protocol). Only bridge these two published shapes;
            // do not infer aliases from display labels or model metadata.
            let alias = match provider
                .strip_suffix("-anthropic")
                .or_else(|| provider.strip_suffix("-openai"))
            {
                Some("") => continue,
                Some(tier) => tier.to_string(),
                None => match config.protocol_for(provider, profile, model) {
                    Protocol::Anthropic => format!("{provider}-anthropic"),
                    Protocol::OpenAi => format!("{provider}-openai"),
                    Protocol::OpenAiResponses => continue,
                },
            };
            // A configured provider owns its name, including BYOK profiles.
            if config.providers.contains_key(&alias) {
                continue;
            }
            let spec = format!("{alias}:{model}");
            // Use the switcher's resolver as the authority. A literal model
            // ID containing ':' takes precedence over provider:model, and
            // another provider may list the same model. Never advertise an
            // alias that would select a different route.
            let resolves_to_current =
                config
                    .resolve_model_spec(&spec)
                    .is_ok_and(|(resolved, id)| {
                        resolved == *provider && id.as_deref() == Some(model.as_str())
                    });
            if resolves_to_current && listed.insert(spec) {
                options.push(
                    option(&alias, model).description(format!("{provider} (legacy ID: {alias})")),
                );
            }
        }
    }
    options
}

fn option(provider: &str, model: &str) -> acp::SessionConfigSelectOption {
    acp::SessionConfigSelectOption::new(format!("{provider}:{model}"), model.to_string())
        .description(provider.to_string())
}
