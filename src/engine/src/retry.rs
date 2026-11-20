//! Retry policy for transient provider errors.
//!
//! Defines [`RetryPolicy`] (backoff timing) and [`should_retry()`] (error
//! classification). The agent loop combines both to decide whether and
//! when to re-attempt a failed provider call.

use std::time::Duration;

use crate::provider::ProviderError;

/// Retry policy with exponential backoff.
///
/// Controls *how many* times and *how long* to wait between retries.
/// Use [`RetryPolicy::disabled()`] to fail immediately on any error.
///
/// When retries are enabled, exhausting the bounded budget on a still
/// retryable transport/service error does not fail the agent loop: it switches
/// to the cancellable long-wait path (see `OutageWait`) and keeps probing until
/// recovery. Protocol-incomplete responses are the exception: they use a small
/// bounded budget and then fail clearly because identical replays commonly
/// reproduce malformed model output. Only [`disabled()`] (`max_retries == 0`)
/// keeps the strict fail-fast contract for every error.
///
/// Internal backoff parameters (2 s initial, 2× multiplier, 30 s cap,
/// ±20 % jitter) are intentionally not exposed — callers express intent
/// via [`new()`](RetryPolicy::new) and the
/// implementation is free to evolve.
///
/// [`disabled()`]: RetryPolicy::disabled
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    max_retries: usize,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_retries: 10 }
    }
}

// Internal backoff constants.
const INITIAL_DELAY_MS: f64 = 2000.0;
const BACKOFF_MULTIPLIER: f64 = 2.0;
const MAX_DELAY_MS: f64 = 30_000.0;

impl RetryPolicy {
    /// No retries — fail immediately on any error.
    pub fn disabled() -> Self {
        Self { max_retries: 0 }
    }

    /// Create a policy that retries up to `n` times.
    pub fn new(n: usize) -> Self {
        Self { max_retries: n }
    }

    /// Maximum number of retry attempts (0 = no retries).
    pub fn max_retries(&self) -> usize {
        self.max_retries
    }

    /// Calculate the delay for a given attempt (1-indexed).
    /// Uses exponential backoff with ±20 % jitter.
    pub fn delay_for_attempt(&self, attempt: usize) -> Duration {
        let base_ms = INITIAL_DELAY_MS * BACKOFF_MULTIPLIER.powi((attempt - 1) as i32);
        let capped_ms = base_ms.min(MAX_DELAY_MS);

        // Jitter: ±20 % (multiply by 0.8–1.2)
        let jitter = 0.8 + rand::random::<f64>() * 0.4;
        Duration::from_millis((capped_ms * jitter) as u64)
    }
}

/// Whether this provider error is safe to retry.
///
/// Classification happens at the provider layer (HTTP status and structured
/// error types — see [`ProviderError::classify`] and
/// `provider::error::classify_stream_error`), which yields semantic variants.
/// Retryable: rate limits (429), network/transient errors, overloaded (529).
/// Not retryable: auth (401/403), context overflow, cancellation,
/// client errors (4xx), quota exhaustion, proxy configuration errors.
///
/// Bare [`ProviderError::Api`] errors from paths without status/type context
/// fall back to keyword matching as a last resort.
pub fn should_retry(error: &ProviderError) -> bool {
    if error.is_transient() {
        return true;
    }
    match error {
        // Protocol-declared permanent errors never enter the legacy text fallback.
        ProviderError::ModelNotFound(_) | ProviderError::InvalidRequest(_) => false,
        // A bare Api error that is really a context overflow must never retry,
        // even if its wording also contains a transient phrase like "try again".
        // Overflow is handled by compaction, not retry.
        ProviderError::Api(message) => {
            !crate::provider::error::is_context_overflow_message(message)
                && is_retryable_api_message(message)
        }
        _ => false,
    }
}

/// Legacy keyword fallback for bare `Api` errors constructed without HTTP
/// status or structured type context (e.g. internally-generated errors).
/// New code paths should classify structurally instead of extending this list.
fn is_retryable_api_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("rate limit")
        || lower.contains("overloaded")
        || lower.contains("try again")
        || lower.contains("temporarily unavailable")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("internal server error")
        || lower.contains("server error")
        // OpenAI-compatible APIs commonly return the structured error type
        // `server_error` with an empty human-readable message. Preserve the raw
        // body for diagnostics, but still recognize the machine-readable type
        // as transient.
        || lower.contains("server_error")
        || lower.contains("bad gateway")
        || lower.contains("service unavailable")
        || lower.contains("gateway timeout")
        || lower.contains("stream interrupted")
        || lower.contains("please retry")
        // xAI (Grok) proxies surface transient upstream failures as an inline
        // SSE error with this wording and no HTTP status to classify by.
        || lower.contains("upstream request failed")
        || lower.contains("upstream error")
        // A successful response with no usable content is a transient provider
        // or proxy defect even when usage accounting is present. Retry before
        // an empty assistant message can be accepted into session history.
        || lower.contains("empty response from provider")
        || has_retryable_http_status(&lower)
}

/// Match an HTTP status embedded in provider error text, e.g. `HTTP 520:`.
/// All 5xx responses are server/proxy failures and safe to retry; 4xx remains
/// non-retryable unless classified by an earlier, explicit rule.
fn has_retryable_http_status(message: &str) -> bool {
    let mut parts = message.split_ascii_whitespace();
    while let Some(part) = parts.next() {
        if !part.eq_ignore_ascii_case("http") {
            continue;
        }
        let Some(status) = parts.next() else {
            return false;
        };
        let digits = status.trim_matches(|c: char| !c.is_ascii_digit());
        if digits.len() == 3
            && digits
                .parse::<u16>()
                .is_ok_and(|status| (500..600).contains(&status))
        {
            return true;
        }
    }
    false
}
