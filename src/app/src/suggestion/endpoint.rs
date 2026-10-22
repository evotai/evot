use serde::Deserialize;

use crate::auth::ModelsResponse;
use crate::conf::parse_protocol;
use crate::conf::Protocol;

/// Published service DTO. Runtime model selection lives in `model`, not in
/// the catalog or its persistent representation.
#[derive(Clone, Deserialize)]
pub struct SuggestionEndpoint {
    pub model: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub context_window: u32,
}

impl SuggestionEndpoint {
    pub fn from_catalog(response: &ModelsResponse) -> Option<Self> {
        // Services already round-trip in the catalog's flattened extras. Keep
        // the published cache shape intact instead of introducing a new cache.
        let value = response.extra.get("services")?.get("suggestion")?;
        let endpoint: Self = serde_json::from_value(value.clone()).ok()?;
        endpoint.parsed_protocol()?;
        if [&endpoint.model, &endpoint.base_url, &endpoint.api_key]
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return None;
        }
        Some(endpoint)
    }

    pub fn parsed_protocol(&self) -> Option<Protocol> {
        parse_protocol(&self.protocol).ok()
    }
}

pub(super) async fn current() -> crate::error::Result<Option<SuggestionEndpoint>> {
    crate::blocking::blocking_io("suggestion_config", read_current).await
}

fn read_current(
    cancel: &tokio_util::sync::CancellationToken,
) -> crate::error::Result<Option<SuggestionEndpoint>> {
    if crate::auth::load_auth()?.is_none() {
        return Ok(None);
    }
    if cancel.is_cancelled() {
        return Err(crate::blocking::cancelled("suggestion_config"));
    }
    let Some(cache) = crate::auth::load_models_cache()? else {
        return Ok(None);
    };
    let published = cache
        .response
        .extra
        .get("services")
        .and_then(|services| services.get("suggestion"));
    if published.is_none_or(serde_json::Value::is_null) {
        return Ok(None);
    }
    SuggestionEndpoint::from_catalog(&cache.response)
        .map(Some)
        .ok_or_else(|| {
            crate::error::EvotError::Conf("invalid suggestion service configuration".into())
        })
}
