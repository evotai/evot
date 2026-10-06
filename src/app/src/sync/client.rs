//! HTTP client for `/v1/sessions`. Same auth and transport rules as shares:
//! bearer `cli_token`, no redirects, no local upload size ceiling.

use std::time::Duration;

use serde::de::DeserializeOwned;

use super::types::PushResponse;
use super::types::RemoteIndex;
use super::types::SyncPull;
use super::types::SyncPush;
use crate::auth::AuthState;
use crate::error::EvotError;
use crate::error::Result;

pub async fn push(state: &AuthState, payload: &SyncPush) -> Result<PushResponse> {
    check_id(&payload.meta.session_id)?;
    let body = serde_json::to_vec(payload).map_err(|e| EvotError::Conf(e.to_string()))?;
    let response = send(
        state,
        reqwest::Method::PUT,
        &format!("/{}", payload.meta.session_id),
        Some(body),
    )
    .await?;
    if response.status().as_u16() == 409 {
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| EvotError::Conf(format!("sync conflict body: {e}")))?;
        let remote_seq = body
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| EvotError::Conf("sync conflict without seq".into()))?;
        return Ok(PushResponse::Conflict { remote_seq });
    }
    Ok(PushResponse::Acked(decode(response).await?))
}

pub async fn index(state: &AuthState) -> Result<RemoteIndex> {
    let response = send(state, reqwest::Method::GET, "", None).await?;
    decode(response).await
}

pub async fn pull(state: &AuthState, session_id: &str, after_seq: u64) -> Result<SyncPull> {
    check_id(session_id)?;
    let response = send(
        state,
        reqwest::Method::GET,
        &format!("/{session_id}?after_seq={after_seq}"),
        None,
    )
    .await?;
    decode(response).await
}

pub async fn delete(state: &AuthState, session_id: &str) -> Result<()> {
    check_id(session_id)?;
    send(
        state,
        reqwest::Method::DELETE,
        &format!("/{session_id}"),
        None,
    )
    .await?;
    Ok(())
}

fn check_id(id: &str) -> Result<()> {
    let ok = (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    if ok {
        Ok(())
    } else {
        Err(EvotError::Conf("invalid session id".into()))
    }
}

async fn send(
    state: &AuthState,
    method: reqwest::Method,
    suffix: &str,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| EvotError::Conf(e.to_string()))?;
    let mut request = client
        .request(
            method,
            format!(
                "{}/v1/sessions{suffix}",
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
        .map_err(|e| EvotError::Conf(format!("sync: {e}")))?;
    let status = response.status();
    if status.is_success() || status.as_u16() == 409 {
        return Ok(response);
    }
    // A refusal the server explains (e.g. team sharing without a team) is
    // more useful than the generic line.
    if status.as_u16() == 403 {
        let reason = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|body| body.get("error")?.as_str().map(str::to_string));
        if let Some(reason) = reason {
            return Err(EvotError::Conf(format!("{reason} (HTTP {status})")));
        }
        return Err(EvotError::Conf(format!(
            "sync permission denied (HTTP {status})"
        )));
    }
    let message = match status.as_u16() {
        401 => "sync requires sign-in; run /login",
        403 => "sync permission denied",
        404 => "session is not on the cloud",
        413 => "session exceeds size or storage quota",
        426 => "this evot is too old for the cloud session format; run /update",
        429 => "too many sync requests; try again later",
        507 => "cloud storage is full",
        _ => "sync request failed",
    };
    Err(EvotError::Conf(format!("{message} (HTTP {status})")))
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    response
        .json()
        .await
        .map_err(|e| EvotError::Conf(format!("sync response: {e}")))
}
