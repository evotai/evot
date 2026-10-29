//! HTTP client for `/v1/sessions`. Same auth and transport rules as shares:
//! bearer `cli_token`, no redirects, no local upload size ceiling.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
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
/// Best-effort connection reuse must not make ignored response bodies stall a
/// successful delete or extend the server's retry delay.
const DISCARD_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a running upload reports bytes sent.
const PROGRESS_TICK: Duration = Duration::from_millis(200);
/// Body slice handed to the connection at a time; also the progress grain.
const SEND_CHUNK: usize = 64 * 1024;

/// What one batch's request is doing, so a caller can show it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadEvent {
    /// The scrubbed body is ready; this many bytes will go up.
    Prepared { bytes: u64 },
    /// This many of the body's bytes have gone to the connection.
    Sending { sent: u64 },
    /// The whole body is out; waiting for the server's answer.
    Confirming,
    /// The server asked to slow down; the same body goes again after `retry_in`.
    RateLimited { retry_in: Duration },
}

/// Where a request reports [`UploadEvent`]s. `&|_| {}` for callers that do not care.
pub type UploadSink<'a> = dyn Fn(UploadEvent) + Sync + 'a;

/// Push one batch. `context` is the session's whole local history (see
/// [`crate::privacy::upload_context`]), so a batch holding only part of the
/// session is scrubbed as if the rest were beside it.
pub async fn push(
    state: &AuthState,
    payload: &SyncPush,
    context: &crate::privacy::UploadContext,
    on_event: &UploadSink<'_>,
) -> Result<PushResponse> {
    check_id(&payload.meta.session_id)?;
    // The cloud copy never holds a secret: scrubbed for good before upload.
    let body = crate::privacy::scrub_upload(
        crate::privacy::Target::Sync,
        &payload.meta.session_id,
        payload,
        Some(context),
    )
    .await?;
    on_event(UploadEvent::Prepared {
        bytes: body.len() as u64,
    });
    let suffix = format!("/{}", payload.meta.session_id);
    // A chunked upload is many PUTs in a row, and the server's per-minute
    // cap on uploads sees each one. It answers 429 with `Retry-After`; wait
    // that long and send the same batch again rather than fail an upload that
    // is mostly done. Earlier batches are already acknowledged and recorded,
    // so nothing is resent on retry.
    let deadline = tokio::time::Instant::now() + RETRY_BUDGET;
    let response = loop {
        let response = send_tracked(state, &suffix, &body, on_event).await?;
        if response.status().as_u16() != 429 {
            break response;
        }
        let wait = retry_after(&response).unwrap_or(DEFAULT_RETRY_AFTER);
        let retry_at = tokio::time::Instant::now() + wait;
        if retry_at > deadline {
            return Err(explain_failure(response, "too many sync requests; try again later").await);
        }
        on_event(UploadEvent::RateLimited { retry_in: wait });
        discard_body(response, retry_at).await;
        tokio::time::sleep_until(retry_at).await;
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
    let response = send_once(
        state,
        reqwest::Method::DELETE,
        &format!("/{session_id}"),
        None,
    )
    .await?;
    discard_body(response, tokio::time::Instant::now() + DISCARD_TIMEOUT).await;
    Ok(())
}

/// PUT `body`, reporting bytes as the connection takes them and then the
/// wait for the server's answer. The body is streamed in slices, with its
/// length declared up front, so progress moves while one large batch is
/// still going up instead of only after the server acknowledged it.
async fn send_tracked(
    state: &AuthState,
    suffix: &str,
    body: &[u8],
    on_event: &UploadSink<'_>,
) -> Result<reqwest::Response> {
    let total = body.len() as u64;
    let sent = Arc::new(AtomicU64::new(0));
    let counter = sent.clone();
    let slices: Vec<Vec<u8>> = body.chunks(SEND_CHUNK).map(<[u8]>::to_vec).collect();
    // `map` runs as the connection pulls each slice, so the counter follows
    // what actually left for the socket.
    let stream = futures::stream::iter(slices.into_iter().map(move |slice| {
        counter.fetch_add(slice.len() as u64, Ordering::Relaxed);
        Ok::<_, std::io::Error>(slice)
    }));
    let request = send(
        state,
        reqwest::Method::PUT,
        suffix,
        Some(RequestBody {
            body: reqwest::Body::wrap_stream(stream),
            len: body.len(),
        }),
    );
    tokio::pin!(request);
    let mut tick = tokio::time::interval(PROGRESS_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            response = &mut request => return response,
            _ = tick.tick() => {
                let sent = sent.load(Ordering::Relaxed).min(total);
                on_event(if sent >= total {
                    UploadEvent::Confirming
                } else {
                    UploadEvent::Sending { sent }
                });
            }
        }
    }
}

/// A request body and its length, which is always declared: the server's
/// size checks and proxies in front of it expect `Content-Length`.
struct RequestBody {
    body: reqwest::Body,
    len: usize,
}

/// One request where a 429 is a failure like any other; only `push` retries.
async fn send_once(
    state: &AuthState,
    method: reqwest::Method,
    suffix: &str,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response> {
    let body = body.map(|bytes| RequestBody {
        len: bytes.len(),
        body: reqwest::Body::from(bytes),
    });
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
    body: Option<RequestBody>,
) -> Result<reqwest::Response> {
    let mut request = crate::http::no_redirect_client()?
        .request(
            method,
            format!(
                "{}/v1/sessions{suffix}",
                state.server_base_url.trim_end_matches('/')
            ),
        )
        .bearer_auth(&state.cli_token)
        .timeout(upload_timeout(body.as_ref().map_or(0, |body| body.len)));
    if let Some(RequestBody { body, len }) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::CONTENT_LENGTH, len)
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

/// Consume ignored bodies so HTTP/1.1 connections can return to the pool.
/// Stream rather than buffer and bound the work: a large, stalled or broken
/// body must not suppress a retry or turn a successful DELETE into a failure.
async fn discard_body(mut response: reqwest::Response, deadline: tokio::time::Instant) {
    let deadline = deadline.min(tokio::time::Instant::now() + DISCARD_TIMEOUT);
    tokio::select! {
        _ = tokio::time::sleep_until(deadline) => {}
        _ = async {
            loop {
                match response.chunk().await {
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => return,
                }
            }
        } => {}
    }
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    response
        .json()
        .await
        .map_err(|e| EvotError::Conf(format!("sync response: {e}")))
}
