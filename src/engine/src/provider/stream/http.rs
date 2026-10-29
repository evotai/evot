//! Shared HTTP transport helpers for stream providers.
//!
//! Provides response classification, body reading, JSON error extraction,
//! and SSE-from-response driving — reusable across all providers that
//! need to handle non-SSE JSON fallback.

use futures::StreamExt;

use crate::provider::error::ProviderError;

const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
const MAX_ERROR_DETAIL_CHARS: usize = 4096;

pub use super::sse::SseEvent;

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

/// How the upstream responded to a stream request.
#[derive(Debug, PartialEq, Eq)]
pub enum StreamResponseKind {
    /// Server returned an SSE-compatible content type.
    Streaming,
    /// Server returned `application/json` (could be success or error).
    Json,
    /// Unrecognised content type.
    Other(String),
}

/// Inspect the `content-type` header and classify the response.
pub fn classify_response(response: &reqwest::Response) -> StreamResponseKind {
    let ct = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if ct.contains("event-stream") || ct.contains("stream") {
        StreamResponseKind::Streaming
    } else if ct.contains("application/json") || ct.contains("json") {
        StreamResponseKind::Json
    } else {
        StreamResponseKind::Other(ct.to_string())
    }
}

// ---------------------------------------------------------------------------
// Compressed request bodies (negotiated per origin)
// ---------------------------------------------------------------------------

/// Bodies smaller than this are sent as they are: compressing them saves
/// nothing a user would notice.
pub const COMPRESS_MIN_BYTES: usize = 32 * 1024;

/// Origins (`scheme://host:port`) that have said they accept gzip request
/// bodies, by answering with `Accept-Encoding: gzip` (RFC 7694).
///
/// An agent re-sends its whole context every turn; 1-4 MB of JSON over a slow
/// uplink takes tens of seconds before the model sees the first byte. JSON
/// compresses 5-10x. Nothing is compressed for an origin until it has
/// advertised support, so endpoints that do not understand it keep getting
/// plain JSON.
fn gzip_origins() -> &'static parking_lot::Mutex<std::collections::HashSet<String>> {
    static ORIGINS: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    ORIGINS.get_or_init(Default::default)
}

fn origin_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(format!(
        "{}://{}:{}",
        parsed.scheme(),
        host,
        parsed.port_or_known_default().unwrap_or(0)
    ))
}

/// Whether gzip request bodies are known to be accepted at *url*'s origin.
pub fn origin_accepts_gzip(url: &str) -> bool {
    origin_of(url).is_some_and(|o| gzip_origins().lock().contains(&o))
}

/// Record what a response from *url* said about request codings.
pub fn learn_request_encoding(url: &str, response: &reqwest::Response) {
    let Some(origin) = origin_of(url) else { return };
    let accepts = response
        .headers()
        .get_all(reqwest::header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|coding| coding.trim().eq_ignore_ascii_case("gzip"));
    if accepts {
        gzip_origins().lock().insert(origin);
    }
}

/// Forget what *url*'s origin advertised about request encodings.
///
/// The cache is process-wide and keyed by origin, so a fresh server that reuses
/// a previously seen host:port would otherwise inherit stale knowledge. Tests
/// call this for their own origin before asserting on what gets sent.
pub fn forget_request_encoding(url: &str) {
    if let Some(origin) = origin_of(url) {
        gzip_origins().lock().remove(&origin);
    }
}

fn gzip(data: &[u8]) -> std::io::Result<Vec<u8>> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(data.len() / 6),
        flate2::Compression::default(),
    );
    encoder.write_all(data)?;
    encoder.finish()
}

/// Send *body* as JSON on *builder* (headers set, no body yet): gzipped when
/// the origin has advertised it and the body is large, plain otherwise.
///
/// A 415 to a gzipped body means the origin stopped accepting it (e.g. a new
/// deployment behind the same host): the origin is forgotten and the request
/// is sent once more as plain JSON.
///
/// The body is taken by value so the JSON tree is released as soon as the
/// bytes exist: a long tool-heavy context is otherwise held three times for
/// the whole streamed response (messages, encoded bytes, and this tree).
pub async fn send_json_stream_request(
    builder: reqwest::RequestBuilder,
    url: &str,
    body: serde_json::Value,
) -> Result<reqwest::Response, ProviderError> {
    let plain = serde_json::to_vec(&body)
        .map_err(|e| ProviderError::Other(format!("could not encode the request: {e}")))?;
    drop(body);
    let fallback = builder.try_clone();

    let (plain, compressed) = if plain.len() >= COMPRESS_MIN_BYTES && origin_accepts_gzip(url) {
        // Compressing a multi-MB body is tens of ms of CPU: keep it off the
        // async workers. The plain bytes travel through the task instead of
        // being cloned; they are still needed for the 415 fallback.
        match tokio::task::spawn_blocking(move || {
            let compressed = gzip(&plain).ok();
            (plain, compressed)
        })
        .await
        {
            Ok((plain, compressed)) => (plain, compressed),
            Err(e) => {
                return Err(ProviderError::Other(format!(
                    "could not compress the request: {e}"
                )))
            }
        }
    } else {
        (plain, None)
    };

    let Some(compressed) = compressed else {
        let response = send_stream_request(builder.body(plain)).await?;
        learn_request_encoding(url, &response);
        return Ok(response);
    };

    let response = send_stream_request(
        builder
            .header(reqwest::header::CONTENT_ENCODING, "gzip")
            .body(compressed),
    )
    .await?;
    learn_request_encoding(url, &response);
    if response.status() != reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE {
        return Ok(response);
    }
    forget_request_encoding(url);
    let Some(fallback) = fallback else {
        return Ok(response);
    };
    let response = send_stream_request(fallback.body(plain)).await?;
    learn_request_encoding(url, &response);
    Ok(response)
}

// ---------------------------------------------------------------------------
// Request / status helpers
// ---------------------------------------------------------------------------

/// Send a stream request, mapping transport errors to [`ProviderError::Network`].
///
/// Transient connection failures map to [`ProviderError::Network`], which the
/// agent loop's retry policy ([`crate::retry`]) treats as retryable. Retry
/// lives there — a single place with exponential backoff + jitter — not here.
pub async fn send_stream_request(
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, ProviderError> {
    send_stream_request_with_deadline(builder, crate::provider::error::STREAM_SEND_TIMEOUT).await
}

/// [`send_stream_request`] with an explicit send-phase deadline.
///
/// The deadline covers connect + body upload + response headers and expires
/// into a retryable [`ProviderError::Network`], so a request that stalls while
/// writing its (possibly multi-megabyte) body is retried instead of hanging on
/// the OS TCP retransmission budget. Once headers arrive the deadline is
/// released; response streaming is governed per-read by the client's
/// `read_timeout` and the SSE reader.
pub async fn send_stream_request_with_deadline(
    builder: reqwest::RequestBuilder,
    deadline: std::time::Duration,
) -> Result<reqwest::Response, ProviderError> {
    let url = builder
        .try_clone()
        .and_then(|b| b.build().ok())
        .map(|r| r.url().to_string())
        .unwrap_or_default();
    let send = builder.send();
    match tokio::time::timeout(deadline, send).await {
        Ok(result) => result.map_err(|e| {
            ProviderError::Network(crate::provider::error::format_transport_detail(
                &e,
                Some(&url),
            ))
        }),
        Err(_) => Err(ProviderError::Network(format!(
            "request did not connect, upload, or return headers within {}s; URL: {url}",
            deadline.as_secs()
        ))),
    }
}

/// Check the HTTP status code. Non-2xx responses are read and classified.
///
/// The `x-should-retry` gateway hint can mark an otherwise-unknown error as
/// retryable. Retry timing is controlled locally and does not depend on
/// provider-specific response headers.
pub async fn check_error_status(
    response: reqwest::Response,
) -> Result<reqwest::Response, ProviderError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let should_retry = parse_should_retry_header(&response);
    let body = read_limited_error_body(response).await;
    let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
    let display_detail = parsed
        .as_ref()
        .and_then(extract_json_error_message)
        .map(|detail| truncate_chars(&detail, MAX_ERROR_DETAIL_CHARS))
        .unwrap_or_else(|| truncate_chars(&body, MAX_ERROR_DETAIL_CHARS));
    let classification_detail = parsed
        .as_ref()
        .map(json_error_evidence)
        .unwrap_or_else(|| body.clone());
    Err(ProviderError::from_http_payload(
        status,
        parsed.as_ref(),
        &format!("HTTP {status}: {classification_detail}"),
        &format!("HTTP {status}: {display_detail}"),
        should_retry,
    ))
}

async fn read_limited_error_body(response: reqwest::Response) -> String {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(MAX_ERROR_BODY_BYTES.min(8192));
    let mut truncated = false;

    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            break;
        };
        let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() == MAX_ERROR_BODY_BYTES {
            truncated = true;
            break;
        }
    }

    let mut body = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        body.push('…');
    }
    body
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}…", truncated)
    } else {
        truncated
    }
}

/// Parse the `x-should-retry` hint header (sent by Anthropic and passed
/// through by gateway proxies). Only explicit `true`/`false` values count;
/// anything else is treated as absent.
pub fn parse_should_retry_header(response: &reqwest::Response) -> Option<bool> {
    match response
        .headers()
        .get("x-should-retry")?
        .to_str()
        .ok()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

/// Read the full response body as text.
pub async fn read_text_body(response: reqwest::Response) -> Result<String, ProviderError> {
    response
        .text()
        .await
        .map_err(|e| ProviderError::Network(format!("Failed to read response body: {e}")))
}

/// Read the full response body and parse it as JSON.
pub async fn read_json_body(
    response: reqwest::Response,
) -> Result<serde_json::Value, ProviderError> {
    let text = read_text_body(response).await?;
    serde_json::from_str(&text)
        .map_err(|e| ProviderError::Api(format!("Failed to parse JSON response: {e}")))
}

// ---------------------------------------------------------------------------
// JSON error extraction & classification
// ---------------------------------------------------------------------------

/// Extract a human-readable error message from a JSON error body.
///
/// Tries common patterns across providers:
/// - `{ "error": { "type": "...", "message": "..." } }` (Anthropic)
/// - `{ "error": { "message": "..." } }` (OpenAI)
/// - `{ "message": "..." }` (generic)
/// - `{ "type": "..." }` (generic)
///
/// OpenRouter puts the upstream reason in `metadata.raw` next to a generic
/// `Provider returned error` message. That field is part of the envelope, not
/// a rewrite of it: append `raw` when it is not already in the display string.
pub fn extract_json_error_message(value: &serde_json::Value) -> Option<String> {
    let error_obj = Some(crate::provider::error_semantics::error_node(value));

    let error_kind = error_obj
        .and_then(|error| error.get("type").or_else(|| error.get("code")))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("code")
                .or_else(|| value.get("type"))
                .and_then(serde_json::Value::as_str)
                .filter(|kind| *kind != "error")
        });

    let error_message = error_obj
        .and_then(|e| {
            e.get("message")
                .or_else(|| e.get("detail"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("message")
                .or_else(|| value.get("detail"))
                .and_then(|v| v.as_str())
        });

    let mut display = match (error_kind, error_message) {
        (Some(kind), Some(message)) => format!("{kind}: {message}"),
        (None, Some(message)) => message.to_string(),
        (Some(kind), None) => kind.to_string(),
        (None, None) => String::new(),
    };
    if let Some(raw) = raw_provider_error(value) {
        if !display.contains(raw) {
            if display.is_empty() {
                display = raw.to_string();
            } else {
                display.push('\n');
                display.push_str(raw);
            }
        }
    }
    if display.is_empty() {
        None
    } else {
        Some(display)
    }
}

fn raw_provider_error(value: &serde_json::Value) -> Option<&str> {
    value
        .pointer("/error/metadata/raw")
        .or_else(|| value.pointer("/metadata/raw"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
}

/// Preserve the complete bounded JSON envelope as classification evidence.
/// Display formatting is separate so machine-readable fields cannot disappear
/// behind a generic provider message.
fn json_error_evidence(value: &serde_json::Value) -> String {
    value.to_string()
}

/// Classify a JSON error body from an accepted (2xx) stream request into a
/// [`ProviderError`].
///
/// Delegates to [`crate::provider::error::classify_stream_error`]: fatal
/// conditions (context overflow, quota, auth, structured fatal error types)
/// are recognized positively and everything else defaults to a retryable
/// [`ProviderError::Transient`].
pub fn classify_json_error(value: &serde_json::Value) -> ProviderError {
    let message = extract_json_error_message(value).unwrap_or_else(|| value.to_string());
    crate::provider::error::classify_stream_error(&message, Some(value))
}
