//! Shared HTTP connection pools for cloud calls.
//!
//! LLM streaming, the model catalog and scheduled tasks use the engine's pool.
//! Session sync and share operations use a separate pool that rejects redirects.
//! Both use the engine's transport policy, including `User-Agent: evot/<version>`
//! (which the server keys compatibility on), timeouts and bounded idle pools.

use std::sync::OnceLock;

use crate::error::EvotError;
use crate::error::Result;

pub(crate) fn client() -> Result<reqwest::Client> {
    evot_engine::provider::http_client().map_err(|error| EvotError::Conf(error.to_string()))
}

static NO_REDIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// One process-wide pool for calls that must never follow a redirect. Keep
/// credentials on each request: the current account and server can change
/// while the pool stays alive, and public shares must not inherit a token.
pub(crate) fn no_redirect_client() -> Result<reqwest::Client> {
    if let Some(client) = NO_REDIRECT_CLIENT.get() {
        return Ok(client.clone());
    }
    let client = evot_engine::provider::http_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| EvotError::Conf(error.to_string()))?;
    let _ = NO_REDIRECT_CLIENT.set(client.clone());
    Ok(NO_REDIRECT_CLIENT.get().cloned().unwrap_or(client))
}
