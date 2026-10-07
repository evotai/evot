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
use crate::share::client::explain_failure;
use crate::share::client::upload_timeout;

/// How long to keep retrying one batch that the server asked us to slow
/// down on. The per-account upload window is a minute; two windows covers a
/// batch that lands right as the next one opens.
const RETRY_BUDGET: Duration = Duration::from_secs(150);
/// Used when the server says 429 without a usable `Retry-After`.
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(5);

pub async fn push(state: &AuthState, payload: &SyncPush) -> Result<PushResponse> {
    check_id(&payload.meta.session_id)?;
    let body = serde_json::to_vec(payload).map_err(|e| EvotError::Conf(e.to_string()))?;
    let suffix = format!("/{}", payload.meta.session_id);
    // A chunked upload is many PUTs in a row, and the server's per-minute
    // cap on uploads sees each one. It answers 429 with `Retry-After`; wait
    // that long and send the same batch again rather than fail an upload that
    // is mostly done. Earlier batches are already acknowledged and recorded,
    // so nothing is resent on retry.
    let deadline = tokio::time::Instant::now() + RETRY_BUDGET;
    let response = loop {
        let response = send(state, reqwest::Method::PUT, &suffix, Some(body.clone())).await?;
        if response.status().as_u16() != 429 {
            break response;
        }
        let wait = retry_after(&response).unwrap_or(DEFAULT_RETRY_AFTER);
        if tokio::time::Instant::now() + wait > deadline {
            return Err(explain_failure(response, "too many sync requests; try again later").await);
        }
        tokio::time::sleep(wait).await;
    };
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
    let response = send_once(state, reqwest::Method::GET, "", None).await?;
    decode(response).await
}

pub async fn pull(state: &AuthState, session_id: &str, after_seq: u64) -> Result<SyncPull> {
    check_id(session_id)?;
    let response = send_once(
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
    send_once(
        state,
        reqwest::Method::DELETE,
        &format!("/{session_id}"),
        None,
    )
    .await?;
    Ok(())
}

/// One request where a 429 is a failure like any other; only `push` retries.
async fn send_once(
    state: &AuthState,
    method: reqwest::Method,
    suffix: &str,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response> {
    let response = send(state, method, suffix, body).await?;
    if response.status().as_u16() == 429 {
        return Err(explain_failure(response, "too many sync requests; try again later").await);
    }
    Ok(response)
}

/// `Retry-After` in seconds, when the server sends one we can act on.
fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let seconds: u64 = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    // Zero would spin; a huge value is a server mistake, not a request.
    Some(Duration::from_secs(seconds.clamp(1, 120)))
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
        .timeout(upload_timeout(body.as_ref().map_or(0, Vec::len)));
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
    // 409 carries the remote seq; 429 carries `Retry-After`. Both are
    // answers the caller reads, not failures to explain here.
    if status.is_success() || matches!(status.as_u16(), 409 | 429) {
        return Ok(response);
    }
    let fallback = match status.as_u16() {
        401 => "sync requires sign-in; run /login",
        403 => "sync permission denied",
        404 => "session is not on the cloud",
        413 => "session exceeds size or storage quota",
        426 => "this evot is too old for the cloud session format; run /update",
        429 => "too many sync requests; try again later",
        507 => "cloud storage is full",
        _ => "sync request failed",
    };
    Err(explain_failure(response, fallback).await)
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    response
        .json()
        .await
        .map_err(|e| EvotError::Conf(format!("sync response: {e}")))
}
