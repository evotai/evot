//! Provider error types and classification.

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("API error: {0}")]
    Api(String),
    /// A provider-declared transient failure. The original payload is retained
    /// for diagnostics, while retry policy can rely on this semantic variant
    /// instead of matching provider-specific message text.
    #[error("API error: {message}")]
    Transient { message: String },
    #[error("Overloaded: {0}")]
    Overloaded(String),
    #[error("Network error: {0}")]
    Network(String),
    /// The transport ended cleanly, but the provider never emitted the
    /// protocol's required terminal event. A short retry may recover a
    /// one-off upstream generation failure, but repeating the same request
    /// indefinitely is unlikely to help and must not enter outage probing.
    #[error("Upstream response incomplete: {0}")]
    ProtocolIncomplete(String),
    #[error("Auth error: {0}")]
    Auth(String),
    #[error("Model not found: {0}")]
    ModelNotFound(String),
    #[error("Invalid request: {0}")]
    InvalidRequest(String),
    #[error("{}", display_rate_limited(.message))]
    RateLimited { message: String },
    /// A provider quota window is exhausted. Unlike short-lived rate limiting,
    /// this is retried by the agent's cancellable probe path and does not
    /// consume the ordinary bounded retry budget.
    #[error("Quota limited: {message}")]
    QuotaLimited { message: String },
    #[error("Context overflow: {message}")]
    ContextOverflow { message: String },
    #[error("Cancelled")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

fn display_rate_limited(message: &str) -> String {
    let message = message.trim();
    if message.is_empty() {
        "Rate limited".to_string()
    } else {
        message.to_string()
    }
}

impl ProviderError {
    /// Classify an HTTP error response into the appropriate variant.
    ///
    /// The status code is the primary signal: 5xx (and 408/425) are server-side
    /// failures that are safe to retry, while the remaining 4xx are client
    /// errors that cannot succeed on retry. Message text refines the decision
    /// only for stable semantics (context overflow, quota exhaustion,
    /// overload, proxy configuration gaps).
    pub fn classify(status: u16, message: &str) -> Self {
        Self::classify_with_display(status, message, message)
    }

    fn classify_with_display(status: u16, evidence: &str, display: &str) -> Self {
        let display = display.to_string();
        if status == 401 || status == 403 {
            Self::Auth(display)
        } else if super::error_semantics::model_not_found(evidence, None) {
            Self::ModelNotFound(display)
        } else if is_context_overflow(status, evidence) {
            Self::ContextOverflow { message: display }
        } else if is_fatal_quota_exhaustion(evidence) {
            Self::Other(display)
        } else if is_waitable_quota_limit(evidence) {
            Self::QuotaLimited { message: display }
        } else if status == 429 {
            Self::RateLimited { message: display }
        } else if status == 529 || is_overloaded_message(evidence) {
            Self::Overloaded(display)
        } else if status == 408 || status == 425 || (500..600).contains(&status) {
            Self::Transient { message: display }
        } else if (400..500).contains(&status) {
            Self::Other(display)
        } else {
            Self::Api(display)
        }
    }

    /// [`classify`](Self::classify) plus the `x-should-retry` gateway hint
    /// (sent by Anthropic and passed through by proxies).
    ///
    /// An explicit `true` upgrades an otherwise-fatal *unknown* classification
    /// ([`Other`](Self::Other)) to the retryable [`Transient`](Self::Transient),
    /// so any gateway can mark a response retryable without an evot release.
    /// Semantics with their own recovery paths are never overridden: context
    /// overflow (compaction), quota (probing), auth (fail fast). An explicit
    /// `false` is ignored — server-side failures must keep retrying even when a
    /// misconfigured proxy claims otherwise; fatal classification already comes
    /// from status and structured error types.
    pub fn classify_with_hints(status: u16, message: &str, should_retry: Option<bool>) -> Self {
        Self::classify_with_hints_and_display(status, message, message, should_retry)
    }

    pub(crate) fn classify_with_hints_and_display(
        status: u16,
        evidence: &str,
        display: &str,
        should_retry: Option<bool>,
    ) -> Self {
        let classified = Self::classify_with_display(status, evidence, display);
        if should_retry == Some(true) {
            if let Self::Other(message) = classified {
                return Self::Transient { message };
            }
        }
        classified
    }

    /// Classify native JSON error fields without relying on gateway wording.
    pub(crate) fn from_http_payload(
        status: u16,
        value: Option<&serde_json::Value>,
        evidence: &str,
        display: &str,
        should_retry: Option<bool>,
    ) -> Self {
        // Checked before the permanent types: Azure reports prompt filtering
        // as `invalid_request_error` with code `content_filter`, and it must
        // reach refusal recovery rather than fail as an invalid request.
        if !matches!(status, 401 | 403 | 429)
            && value.is_some_and(super::error_semantics::content_filter)
        {
            return Self::Other(content_filter_message(display));
        }
        if !matches!(status, 401 | 403 | 429)
            && value.is_some_and(super::error_semantics::permanent_type)
            && !is_context_overflow_message(evidence)
        {
            return if super::error_semantics::model_not_found(evidence, value) {
                Self::ModelNotFound(display.to_string())
            } else {
                Self::InvalidRequest(display.to_string())
            };
        }
        Self::classify_with_hints_and_display(status, evidence, display, should_retry)
    }

    pub fn is_context_overflow(&self) -> bool {
        matches!(self, Self::ContextOverflow { .. })
    }

    pub fn is_quota_limited(&self) -> bool {
        matches!(self, Self::QuotaLimited { .. })
    }
}

// ---------------------------------------------------------------------------
// SSE / eventsource classification
// ---------------------------------------------------------------------------

pub fn classify_sse_error_event(message: &str) -> ProviderError {
    let value = serde_json::from_str::<serde_json::Value>(message).ok();
    classify_stream_error(message, value.as_ref())
}

/// Classify an error surfaced *after* the request was accepted (HTTP 2xx):
/// an inline SSE error event or an error-shaped JSON body on a stream
/// endpoint.
///
/// The transport already accepted this request, so an error here is almost
/// always a transient upstream/proxy failure. Only *fatal* conditions are
/// recognized positively — via structured error types and stable semantics
/// (context overflow, quota, auth) — and everything else defaults to the
/// retryable [`ProviderError::Transient`]. A provider changing its transient
/// error wording therefore degrades to a bounded retry instead of a hard
/// failure.
pub(crate) fn classify_stream_error(
    message: &str,
    value: Option<&serde_json::Value>,
) -> ProviderError {
    if value
        .and_then(provider_error_type)
        .is_some_and(is_auth_error_type)
    {
        return ProviderError::Auth(message.to_string());
    }
    if value.is_some_and(super::error_semantics::content_filter) {
        return ProviderError::Other(content_filter_message(message));
    }
    let evidence = value.map(serde_json::Value::to_string);
    let evidence = evidence.as_deref().unwrap_or(message);
    if super::error_semantics::model_not_found(evidence, value) {
        return ProviderError::ModelNotFound(message.to_string());
    }
    if is_context_overflow_message(evidence) {
        return ProviderError::ContextOverflow {
            message: message.to_string(),
        };
    }
    if value.is_some_and(super::error_semantics::permanent_type) {
        return ProviderError::InvalidRequest(message.to_string());
    }
    if is_fatal_quota_exhaustion(evidence) {
        return ProviderError::Other(message.to_string());
    }
    if is_waitable_quota_limit(evidence) {
        return ProviderError::QuotaLimited {
            message: message.to_string(),
        };
    }
    if value.and_then(provider_error_type) == Some("rate_limit_error") {
        return ProviderError::RateLimited {
            message: message.to_string(),
        };
    }
    if is_overloaded_message(evidence) {
        return ProviderError::Overloaded(message.to_string());
    }
    match value.and_then(provider_error_type) {
        Some(error_type) if is_auth_error_type(error_type) => {
            ProviderError::Auth(message.to_string())
        }
        Some(error_type) if is_fatal_error_type(error_type) => {
            ProviderError::InvalidRequest(message.to_string())
        }
        Some("rate_limit_error") => ProviderError::RateLimited {
            message: message.to_string(),
        },
        _ => ProviderError::Transient {
            message: message.to_string(),
        },
    }
}

/// Extract the provider's semantic error type from common JSON envelopes.
/// Nested `error.type` takes precedence over the outer event type (`"error"`).
pub(crate) fn provider_error_type(value: &serde_json::Value) -> Option<&str> {
    let error = super::error_semantics::error_node(value);
    error
        .get("type")
        .and_then(serde_json::Value::as_str)
        .or_else(|| error.get("code").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("code").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("type").and_then(serde_json::Value::as_str))
        .filter(|kind| *kind != "error")
}

fn is_auth_error_type(error_type: &str) -> bool {
    matches!(error_type, "authentication_error" | "permission_error")
}

/// Provider-declared fatal error types: the request itself is invalid, so
/// resending the identical payload cannot succeed. These are protocol fields,
/// not human-readable messages, so classification remains stable if wording
/// changes.
fn is_fatal_error_type(error_type: &str) -> bool {
    matches!(
        error_type,
        "invalid_request_error" | "not_found_error" | "billing_error" | "insufficient_quota"
    )
}

// ---------------------------------------------------------------------------
// Context overflow detection
// ---------------------------------------------------------------------------

/// Substrings that indicate a context-overflow error, across every supported
/// provider. This is the single source of truth for overflow detection — the
/// HTTP classifier, the SSE/JSON error paths, the retry policy, and the
/// compaction trigger all route through [`is_context_overflow_message`] rather
/// than maintaining their own copies.
///
/// Each entry documents the provider whose error wording it matches.
const OVERFLOW_PHRASES: &[&str] = &[
    "context overflow",                             // Stable ProviderError marker
    "prompt is too long",                           // Anthropic (token overflow)
    "request_too_large",                            // Anthropic (HTTP 413 byte-size)
    "request too large",                            // Anthropic / Cerebras variant
    "request exceeds the maximum size",             // Anthropic
    "input is too long",                            // AWS Bedrock
    "exceeds the context window",                   // OpenAI (Completions & Responses)
    "maximum context length",                       // OpenAI / OpenRouter / LiteLLM
    "exceeds the maximum number of tokens allowed", // Google Gemini
    "input token count",                            // Google Gemini
    "maximum prompt length",                        // xAI (Grok)
    "reduce the length of the messages",            // Groq
    "exceeds the maximum allowed input length",     // OpenRouter / Poolside
    "is longer than the model's context length",    // Together AI
    "exceeds the limit of",                         // GitHub Copilot
    "prompt token count of",                        // GitHub Copilot
    "exceeds the available context size",           // llama.cpp
    "greater than the context length",              // LM Studio
    "context window exceeds limit",                 // MiniMax
    "exceeded model token limit",                   // Kimi
    "too large for model with",                     // Mistral
    "model_context_window_exceeded",                // z.ai
    "prompt too long; exceeded",                    // Ollama
    "context length exceeded",                      // Generic
    "context_length_exceeded",                      // Generic (underscore variant)
    "too many tokens",                              // Generic
    "token limit exceeded",                         // Generic
];

/// Substrings that indicate a *non*-overflow error even though they may also
/// contain an overflow phrase. Checked first so transient errors are never
/// misclassified as overflow.
///
/// Example: a throttling message like "Too many tokens, please wait before
/// trying again" matches the `too many tokens` overflow phrase, but is really a
/// rate-limit error that should be retried, not compacted.
const NON_OVERFLOW_PHRASES: &[&str] = &[
    "rate limit",        // Generic rate limiting
    "too many requests", // Generic HTTP 429 style
    "throttl",           // AWS Bedrock / generic throttling
];

/// Whether an error message indicates a context overflow.
///
/// Non-overflow wording (rate limits, throttling) is excluded first so a
/// transient error that happens to contain an overflow phrase is not
/// misclassified.
pub fn is_context_overflow_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    if NON_OVERFLOW_PHRASES
        .iter()
        .any(|phrase| lower.contains(phrase))
    {
        return false;
    }
    OVERFLOW_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

fn is_context_overflow(status: u16, message: &str) -> bool {
    // HTTP 413 is the protocol-level request-size signal. Proxies may replace
    // the provider body with a generic safe error, so requiring an overflow
    // phrase here loses the only reliable semantic marker before compaction.
    if status == 413 {
        return true;
    }
    if status == 400 && message.trim().is_empty() {
        return true;
    }
    is_context_overflow_message(message)
}

// ---------------------------------------------------------------------------
// Safety refusal detection
// ---------------------------------------------------------------------------

/// Stable marker carried by every provider-terminal safety refusal. The SSE and
/// JSON decode paths build their message through [`refusal_message`], and the
/// compaction trigger recognizes it through [`is_refusal_message`], so the two
/// sides cannot drift apart.
const REFUSAL_MARKER: &str = "(safety filter / refusal)";

/// User-visible error text for a provider stop reason that is a safety refusal.
pub fn refusal_message(stop_reason: &str) -> String {
    format!("Provider ended the response with stop reason '{stop_reason}' {REFUSAL_MARKER}")
}

/// Whether an error message is a provider safety refusal.
pub fn is_refusal_message(message: &str) -> bool {
    message.contains(REFUSAL_MARKER)
}

/// Error text for a request rejected by the provider's content filter (for
/// example an Azure OpenAI prompt filter), before or while generating.
pub fn content_filter_message(detail: &str) -> String {
    format!("Provider content filter rejected the request {REFUSAL_MARKER}: {detail}")
}

/// Error text for a response that ended incomplete. A `content_filter` reason
/// is a safety refusal; every other reason keeps the plain incomplete wording.
pub(crate) fn incomplete_message(reason: &str) -> String {
    if is_content_filter_reason(reason) {
        refusal_message(reason)
    } else {
        format!("response incomplete: {reason}")
    }
}

/// Whether an OpenAI `finish_reason` / `incomplete_details.reason` means the
/// output was stopped by the content filter.
pub(crate) fn is_content_filter_reason(reason: &str) -> bool {
    reason == "content_filter"
}

pub(crate) fn is_overloaded_message(message: &str) -> bool {
    message.to_lowercase().contains("overloaded")
}

fn is_waitable_quota_limit(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("quota_error")
        || lower.contains("quota_exceeded")
        || lower.contains("quota exceeded")
        || lower.contains("usage limit") // Kimi: "reached your usage limit for this period"
        || lower.contains("monthly request limit")
        || lower.contains("daily request limit")
        || lower.contains("quota will be refreshed")
}

fn is_fatal_quota_exhaustion(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("insufficient_quota")
        || lower.contains("out of budget")
        || lower.contains("available balance")
        || lower.contains("billing")
}

// ---------------------------------------------------------------------------
// Transport error formatting
// ---------------------------------------------------------------------------

/// Build a concise, human-readable transport error string.
///
/// reqwest wraps a transport failure in several layers (`error sending request
/// for url (...)` -> `client error (SendRequest)` -> `connection error` -> root
/// cause). Concatenating the whole chain produces a long, repetitive line, and
/// some crates (notably rustls) append a docs.rs manual link to their `Display`
/// output. Users only need the root cause plus the URL, so surface the deepest
/// cause, strip any docs.rs reference, and append the request URL.
pub fn format_transport_detail(error: &dyn std::error::Error, url: Option<&str>) -> String {
    let mut root: &dyn std::error::Error = error;
    while let Some(cause) = root.source() {
        root = cause;
    }

    let mut detail = strip_doc_reference(&root.to_string());
    if detail.is_empty() {
        detail = strip_doc_reference(&error.to_string());
    }

    if let Some(url) = url {
        if !url.is_empty() && !detail.contains(url) {
            detail.push_str(&format!(" (url: {url})"));
        }
    }

    detail
}

/// Strip a trailing docs.rs documentation link that some crates (notably
/// rustls) append to their `Display` output, e.g. "peer closed connection
/// without sending TLS close_notify: https://docs.rs/rustls/latest/...". It is
/// noise for users and only bloats the error line.
fn strip_doc_reference(text: &str) -> String {
    match text.find(": https://docs.rs/") {
        Some(idx) => text[..idx].trim_end().to_string(),
        None => text.to_string(),
    }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

include!(concat!(env!("OUT_DIR"), "/user_agent.rs"));

static SHARED_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

/// Per-read timeout for streaming responses.
///
/// `read_timeout` resets after every successful read, so it only fires when a
/// connection goes silent — not during long-running work where the provider
/// keeps sending data (Anthropic/OpenAI emit periodic `ping`/delta frames while
/// thinking). This is what recovers a half-open TCP connection after the
/// machine sleeps or loses network: the stalled read fails with a timeout,
/// which `stream_http` maps to [`ProviderError::Network`] and the retry policy
/// then reconnects. Without it a half-open socket can hang for the OS TCP
/// timeout (~2 h on macOS), leaving the UI stuck on "thinking". Keep this
/// bounded to one minute so a dead in-flight request cannot delay recovery by
/// another five minutes after connectivity returns. The SSE reader also guards
/// its reads explicitly, including transports not created by this client.
pub(crate) const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Deadline for the whole send phase: connect, upload the request body, and
/// receive response headers.
///
/// `read_timeout` above only arms while the client is *reading*, so it cannot
/// see a request that stalls while writing its body. A large context (hundreds
/// of thousands of tokens) is a multi-megabyte upload; if the network drops
/// mid-upload the socket retransmits for the OS TCP budget (many minutes on
/// macOS) with no timeout pending, and the only thing the user sees is a
/// spinner. Bounding the send phase turns that into a retryable
/// [`crate::provider::ProviderError::Network`] so the loop reconnects on its
/// short network cadence. The response body is deliberately excluded: SSE
/// streams are legitimately long and are guarded per-read instead.
pub const STREAM_SEND_TIMEOUT: Duration = Duration::from_secs(120);

/// Timeout for the connect phase only (TCP + TLS handshake).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The shared transport policy, before creating a connection pool.
///
/// Callers that must reject redirects can specialize this builder without
/// duplicating the versioned User-Agent, timeouts, pool limits or TCP keepalive.
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(STREAM_READ_TIMEOUT)
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        // TCP keepalive idle/interval/retries. The interval and retry count
        // matter on macOS, whose defaults probe only after ~2 h; an explicit
        // short interval lets the OS surface a dead peer well before that.
        .tcp_keepalive(Duration::from_secs(60))
        .tcp_keepalive_interval(Duration::from_secs(15))
        .tcp_keepalive_retries(3)
}

fn build_client() -> Result<reqwest::Client, ProviderError> {
    client_builder().build().map_err(|e| {
        ProviderError::Other(format!(
            "Failed to build HTTP client: {}",
            format_transport_detail(&e, None)
        ))
    })
}

/// A client with the shared transport policy but its own connection pool.
///
/// Tests that talk to many short-lived origins need this: the shared pool keys
/// connections by origin, and an origin that has been recycled onto the same
/// port can hand a stale keep-alive connection to a different server.
pub fn dedicated_client() -> Result<reqwest::Client, ProviderError> {
    build_client()
}

pub fn new_client() -> Result<reqwest::Client, ProviderError> {
    if let Some(client) = SHARED_CLIENT.get() {
        return Ok(client.clone());
    }
    let client = build_client()?;
    let _ = SHARED_CLIENT.set(client.clone());
    Ok(SHARED_CLIENT.get().cloned().unwrap_or(client))
}
