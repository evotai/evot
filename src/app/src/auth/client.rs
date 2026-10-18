use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::auth::types::AuthState;
use crate::auth::types::LoginCodeResponse;
use crate::auth::types::ModelsResponse;
use crate::auth::types::Notice;
use crate::error::EvotError;
use crate::error::Result;

pub const DEFAULT_SERVER_URL: &str = "https://auto.evot.ai";

#[derive(Debug, Clone)]
pub enum PollOutcome {
    Pending,
    Success {
        user: AuthState,
    },
    Expired,
    Denied {
        reason: Option<String>,
        reason_code: Option<String>,
    },
}

/// Result of one authenticated catalog read.
#[derive(Debug)]
pub enum CatalogOutcome {
    Ready(ModelsResponse),
    /// `401`/`403`: this CLI token is dead. Only a new login can fix it.
    Refused,
    /// Network or server fault. Says nothing about the credential.
    Unavailable(String),
}

/// Read the model catalog with the stored CLI token.
///
/// Every call mints a fresh scoped LLM key, so this is what repairs a session the
/// gateway reported as `session_revoked`.
pub async fn fetch_catalog(state: &AuthState) -> CatalogOutcome {
    if state.cli_token.trim().is_empty() {
        return CatalogOutcome::Refused;
    }
    let url = format!(
        "{}/v1/config/models",
        state.server_base_url.trim_end_matches('/')
    );
    let client = match crate::http::client() {
        Ok(client) => client,
        Err(error) => return CatalogOutcome::Unavailable(format!("sync models: {error}")),
    };
    let sent = client
        .get(&url)
        .bearer_auth(&state.cli_token)
        .timeout(Duration::from_secs(30))
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(error) => return CatalogOutcome::Unavailable(format!("sync models: {error}")),
    };
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403) {
        return CatalogOutcome::Refused;
    }
    if !status.is_success() {
        return CatalogOutcome::Unavailable(format!("sync models: server returned {status}"));
    }
    match response.json::<ModelsResponse>().await {
        Ok(catalog) => CatalogOutcome::Ready(catalog),
        Err(error) => CatalogOutcome::Unavailable(format!("decode: {error}")),
    }
}

pub async fn begin_login(base_url: &str, fingerprint_id: &str) -> Result<LoginCodeResponse> {
    let body = serde_json::json!({ "fingerprint_id": fingerprint_id });
    let response: LoginCodeResponse = post_json(base_url, "/v1/auth/cli/code", &body).await?;
    Ok(response)
}

pub async fn poll_status(base_url: &str, code: &str, expires_at: i64) -> Result<PollOutcome> {
    let url = format!(
        "{}/v1/auth/cli/status?code={}&expires_at={}",
        base_url.trim_end_matches('/'),
        urlencode(code),
        expires_at
    );
    let response = http_json(crate::http::client()?.get(&url)).await?;
    let status = response
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("pending")
        .to_string();
    match status.as_str() {
        "success" => {
            let user = AuthState {
                version: 1,
                server_base_url: base_url.trim_end_matches('/').to_string(),
                user: parse_field(&response, "user")?,
                cli_token: string_field(&response, "cli_token")?,
                refresh_token: string_field(&response, "refresh_token")?,
                models_synced_at: 0,
            };
            Ok(PollOutcome::Success { user })
        }
        "expired" => Ok(PollOutcome::Expired),
        "denied" => Ok(PollOutcome::Denied {
            reason: response
                .get("reason")
                .and_then(|value| value.as_str())
                .map(String::from),
            reason_code: response
                .get("reason_code")
                .and_then(|value| value.as_str())
                .map(String::from),
        }),
        _ => Ok(PollOutcome::Pending),
    }
}

pub async fn sync_notices(base_url: &str) -> Result<Vec<Notice>> {
    let url = [base_url.trim_end_matches('/'), "/v1/notices"].concat();
    let response = crate::http::client()?
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| EvotError::Conf(format!("sync notices: {error}")))?;
    if !response.status().is_success() {
        return Err(EvotError::Conf(format!(
            "sync notices: server returned {}",
            response.status()
        )));
    }
    response
        .json::<Vec<Notice>>()
        .await
        .map_err(|error| EvotError::Conf(format!("sync notices: decode: {error}")))
}

pub async fn sync_models(state: &AuthState) -> Result<ModelsResponse> {
    let url = format!(
        "{}/v1/config/models",
        state.server_base_url.trim_end_matches('/')
    );
    let response = crate::http::client()?
        .get(&url)
        .bearer_auth(&state.cli_token)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| EvotError::Conf(format!("sync models: {error}")))?;
    if !response.status().is_success() {
        return Err(EvotError::Conf(format!(
            "sync models: server returned {}",
            response.status()
        )));
    }
    response
        .json::<ModelsResponse>()
        .await
        .map_err(|error| EvotError::Conf(format!("decode: {error}")))
}

/// Pin (or, with an empty `model`, clear) the account's landing model on the
/// server. The server rejects models this account cannot use right now.
pub async fn set_default_model(state: &AuthState, model: &str) -> Result<()> {
    let url = format!(
        "{}/v1/config/default-model",
        state.server_base_url.trim_end_matches('/')
    );
    let response = crate::http::client()?
        .put(&url)
        .bearer_auth(&state.cli_token)
        .json(&serde_json::json!({ "model": model }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| EvotError::Conf(format!("set default model: {error}")))?;
    if !response.status().is_success() {
        return Err(EvotError::Conf(format!(
            "set default model: server returned {}",
            response.status()
        )));
    }
    Ok(())
}

async fn post_json<T: DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<T> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let client = crate::http::client()?;
    let response = client
        .post(&url)
        .json(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| EvotError::Conf(format!("{path}: {error}")))?;
    if !response.status().is_success() {
        return Err(EvotError::Conf(format!(
            "{path}: server returned {}",
            response.status()
        )));
    }
    response
        .json::<T>()
        .await
        .map_err(|error| EvotError::Conf(format!("{path}: decode: {error}")))
}

async fn http_json(builder: reqwest::RequestBuilder) -> Result<serde_json::Value> {
    let response = builder
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| EvotError::Conf(format!("auth status: {error}")))?;
    if !response.status().is_success() {
        return Err(EvotError::Conf(format!(
            "auth status: server returned {}",
            response.status()
        )));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| EvotError::Conf(format!("auth status: decode: {error}")))
}

fn string_field(value: &serde_json::Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| EvotError::Conf(format!("auth response missing `{key}`")))
}

fn parse_field<T: DeserializeOwned>(value: &serde_json::Value, key: &str) -> Result<T> {
    serde_json::from_value(
        value
            .get(key)
            .cloned()
            .ok_or_else(|| EvotError::Conf(format!("auth response missing `{key}`")))?,
    )
    .map_err(|error| EvotError::Conf(format!("auth response `{key}`: {error}")))
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
