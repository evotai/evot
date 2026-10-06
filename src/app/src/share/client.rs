use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::ShareCreated;
use super::ShareUpload;
use crate::auth::AuthState;
use crate::error::EvotError;
use crate::error::Result;

pub async fn upload(state: &AuthState, payload: &ShareUpload) -> Result<ShareCreated> {
    let body = serde_json::to_vec(payload).map_err(|e| EvotError::Conf(e.to_string()))?;
    request(state, reqwest::Method::POST, "", Some(body)).await
}

pub async fn list(state: &AuthState) -> Result<Value> {
    request(state, reqwest::Method::GET, "", None).await
}

/// Keep the id inside one URL path segment without pinning today's length: the
/// server owns the id format, and a longer id must not break delete while list
/// and open keep working.
fn is_path_safe_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub async fn delete(state: &AuthState, id: &str) -> Result<Value> {
    if !is_path_safe_id(id) {
        return Err(EvotError::Conf("invalid share id".into()));
    }
    request(state, reqwest::Method::DELETE, &format!("/{id}"), None).await
}

async fn request<T: DeserializeOwned>(
    state: &AuthState,
    method: reqwest::Method,
    suffix: &str,
    body: Option<Vec<u8>>,
) -> Result<T> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| EvotError::Conf(e.to_string()))?;
    let mut request = client
        .request(
            method,
            format!(
                "{}/v1/shares{suffix}",
                state.server_base_url.trim_end_matches('/')
            ),
        )
        .bearer_auth(&state.cli_token)
        .timeout(Duration::from_secs(120));
    if let Some(body) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| EvotError::Conf(format!("share: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 => "share requires sign-in; run evot login",
            403 => "share permission denied",
            413 => "share exceeds size or storage quota",
            429 => "too many shares; try again later",
            507 => "share storage is full",
            _ => "share request failed",
        };
        return Err(EvotError::Conf(format!("{message} (HTTP {status})")));
    }
    response
        .json()
        .await
        .map_err(|e| EvotError::Conf(format!("share response: {e}")))
}
