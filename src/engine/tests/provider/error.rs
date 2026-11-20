use evotengine::provider::error::*;

#[test]
fn classify_anthropic_overflow() {
    let err = ProviderError::classify(400, "prompt is too long: 213462 tokens > 200000 maximum");
    assert!(err.is_context_overflow());
}

#[test]
fn classify_openai_overflow() {
    let err = ProviderError::classify(400, "Your input exceeds the context window of this model");
    assert!(err.is_context_overflow());
}

#[test]
fn classify_google_overflow() {
    let err = ProviderError::classify(
        400,
        "The input token count (1196265) exceeds the maximum number of tokens allowed",
    );
    assert!(err.is_context_overflow());
}

#[test]
fn classify_bedrock_overflow() {
    let err = ProviderError::classify(400, "input is too long for requested model");
    assert!(err.is_context_overflow());
}

#[test]
fn classify_xai_overflow() {
    let err = ProviderError::classify(
        400,
        "This model's maximum prompt length is 131072 but request contains 537812 tokens",
    );
    assert!(err.is_context_overflow());
}

#[test]
fn classify_groq_overflow() {
    let err = ProviderError::classify(
        400,
        "Please reduce the length of the messages or completion",
    );
    assert!(err.is_context_overflow());
}

#[test]
fn classify_request_size_overflow() {
    let empty = ProviderError::classify(413, "");
    assert!(empty.is_context_overflow());

    // Regression: llmproxy deliberately replaces provider details with this
    // safe body. HTTP status remains the only request-size signal.
    let sanitized = ProviderError::classify(
        413,
        r#"HTTP 413: {"type":"error","error":{"type":"api_error","message":"Upstream request failed."}}"#,
    );
    assert!(sanitized.is_context_overflow());
    assert!(is_context_overflow_message(&sanitized.to_string()));

    let empty_400 = ProviderError::classify(400, "  ");
    assert!(empty_400.is_context_overflow());
}

#[test]
fn classify_rate_limit() {
    let err = ProviderError::classify(429, "rate limit exceeded");
    assert!(matches!(err, ProviderError::RateLimited { .. }));
}

#[test]
fn classify_quota_exhausted_429_uses_waitable_and_fatal_paths() {
    // Periodic quota windows are waitable and use the agent's cancellable,
    // unbounded quota retry path.
    let kimi = "rate_limit_error: You've reached your usage limit for this period. \
        Your quota will be refreshed in the next period. Upgrade to get more.";
    let err = ProviderError::classify(429, kimi);
    assert!(matches!(err, ProviderError::QuotaLimited { .. }));
    assert!(err.is_quota_limited());
    assert!(!evotengine::retry::should_retry(&err));

    let err = ProviderError::classify(429, "quota exceeded");
    assert!(matches!(err, ProviderError::QuotaLimited { .. }));

    // Billing failures have no automatic reset and remain fatal.
    for msg in ["insufficient_quota", "out of budget"] {
        let err = ProviderError::classify(429, msg);
        assert!(matches!(err, ProviderError::Other(_)), "{msg}");
        assert!(!evotengine::retry::should_retry(&err), "{msg}");
    }
}

#[test]
fn retry_policy_default_matches_claude_style_backoff_budget() {
    let policy = evotengine::RetryPolicy::default();
    assert_eq!(policy.max_retries(), 10);

    let first = policy.delay_for_attempt(1).as_millis();
    let second = policy.delay_for_attempt(2).as_millis();
    let late = policy.delay_for_attempt(10).as_millis();

    assert!((1600..=2400).contains(&first));
    assert!((3200..=4800).contains(&second));
    assert!((24000..=36000).contains(&late));
}

#[test]
fn classify_auth_error() {
    let err = ProviderError::classify(401, "invalid api key");
    assert!(matches!(err, ProviderError::Auth(_)));
    assert!(!evotengine::retry::should_retry(&err));
    let err = ProviderError::classify(403, "forbidden");
    assert!(matches!(err, ProviderError::Auth(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn classify_400_not_retryable() {
    let err = ProviderError::classify(400, "invalid request format");
    assert!(matches!(err, ProviderError::Other(_)));
    assert!(!evotengine::retry::should_retry(&err));

    let err = ProviderError::Api("HTTP 400 Bad Request: missing text field".into());
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn classify_529_overloaded() {
    let err = ProviderError::classify(529, "overloaded");
    assert!(matches!(err, ProviderError::Overloaded(_)));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn classify_sse_overloaded_error() {
    let err = classify_sse_error_event(r#"{"type":"overloaded_error","message":"Overloaded"}"#);
    assert!(matches!(err, ProviderError::Overloaded(_)));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn classify_overloaded_message_without_status() {
    // Plain-text "overloaded" wording (no 529 status) routes to Overloaded.
    let err = ProviderError::classify(500, "Our servers are currently overloaded");
    assert!(matches!(err, ProviderError::Overloaded(_)));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn classify_model_not_found_is_not_retryable() {
    // A standard model-not-found signal remains fatal even with a retry hint.
    let message = "HTTP 404: model_not_found: Model not found.";
    let err = ProviderError::classify_with_hints(404, message, Some(true));
    assert!(matches!(err, ProviderError::ModelNotFound(_)));
    assert!(!evotengine::retry::should_retry(&err));
    assert!(err.to_string().contains("Model not found."));
}

#[test]
fn classify_outdated_client_version_is_not_retryable() {
    // The backend refuses this client version until the proxy is updated; a
    // retry cannot change either side of that negotiation.
    let message = "HTTP 400: invalid_request_error: Unsupported operation.";
    let err = ProviderError::classify(400, message);
    assert!(matches!(err, ProviderError::Other(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn configuration_gap_stream_error_is_not_retryable() {
    // Same semantics when the proxy surfaces the gap inside an accepted (2xx)
    // stream instead of a non-2xx response.
    let payload = r#"{"type":"response.failed","response":{"error":{"code":"model_not_found","message":"Not available"}}}"#;
    let err = classify_sse_error_event(payload);
    assert!(matches!(err, ProviderError::ModelNotFound(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn unrelated_503_stays_retryable() {
    // Carving configuration errors out of 5xx must not swallow genuine
    // upstream outages, which still recover through the retry budget.
    let err = ProviderError::classify(503, "upstream temporarily unavailable");
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn empty_response_api_error_is_retryable() {
    // Both SSE decoders surface an empty 200 (no content, no usage) as an Api
    // error. It is a transient provider/proxy defect and must retry, matching
    // the Network promotion in the agent loop and pi's retryable stream errors.
    let err = ProviderError::Api("Empty response from provider (no content, no usage)".into());
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn protocol_incomplete_is_retryable_but_distinct_from_network_errors() {
    let err =
        ProviderError::ProtocolIncomplete("Anthropic stream ended before message_stop".into());
    assert_eq!(
        err.to_string(),
        "Upstream response incomplete: Anthropic stream ended before message_stop"
    );
    assert!(evotengine::retry::should_retry(&err));
    assert!(!matches!(err, ProviderError::Network(_)));
}

#[test]
fn overloaded_api_message_is_retryable() {
    // Even when surfaced as a bare Api error, overloaded wording retries.
    let err = ProviderError::Api(
        "API error: Our servers are currently overloaded. Please try again later.".into(),
    );
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn structured_server_error_with_empty_message_is_retryable() {
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"message":"","type":"server_error"}}"#,
    );
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn kiro_api_error_is_structurally_retryable() {
    let payload = r#"{"type":"error","error":{"type":"api_error","message":"Kiro returned invalid JSON for tool edit: Unterminated string starting at: line 1 column 378 (char 377)"}}"#;
    let err = classify_sse_error_event(payload);

    assert!(matches!(&err, ProviderError::Transient { message, .. } if message == payload));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn structured_invalid_request_error_remains_non_retryable() {
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"invalid_request_error","message":"missing required field; please retry"}}"#,
    );
    assert!(matches!(err, ProviderError::InvalidRequest(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn stream_error_without_recognized_type_defaults_to_retryable() {
    // The request was already accepted (HTTP 200 + SSE), so an unrecognized
    // error payload is transient by default. A provider changing its error
    // wording degrades to a bounded retry instead of a hard failure.
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"api_error","message":"Upstream request failed."}}"#,
    );
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));

    // Plain-text payload without any JSON structure.
    let err = classify_sse_error_event("Upstream request failed.");
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));

    // Never-seen-before structured type stays retryable too.
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"brand_new_error_kind","message":"something novel"}}"#,
    );
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn stream_auth_error_is_not_retryable() {
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
    );
    assert!(matches!(err, ProviderError::Auth(_)));
    assert!(!evotengine::retry::should_retry(&err));

    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"permission_error","message":"forbidden"}}"#,
    );
    assert!(matches!(err, ProviderError::Auth(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn stream_quota_error_is_classified_by_recovery_semantics() {
    let fatal = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"rate_limit_error","message":"insufficient_quota: out of budget"}}"#,
    );
    assert!(matches!(fatal, ProviderError::Other(_)));
    assert!(!fatal.is_quota_limited());
    assert!(!evotengine::retry::should_retry(&fatal));

    let waitable = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"quota_error","message":"Quota exceeded."}}"#,
    );
    assert!(matches!(waitable, ProviderError::QuotaLimited { .. }));
    assert!(waitable.is_quota_limited());

    let code_only = classify_sse_error_event(
        r#"{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}"#,
    );
    assert!(matches!(code_only, ProviderError::Other(_)));
    assert!(!code_only.is_quota_limited());
    assert!(!evotengine::retry::should_retry(&code_only));
}

#[test]
fn stream_rate_limit_type_is_retryable() {
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#,
    );
    assert!(matches!(err, ProviderError::RateLimited { .. }));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn classify_http_5xx_and_408_are_transient() {
    // Status is authoritative: server-side failures retry regardless of the
    // body wording, so provider message changes cannot break retry.
    for status in [500, 501, 502, 503, 504, 520, 599, 408] {
        let err = ProviderError::classify(status, "whatever the body says");
        assert!(
            matches!(err, ProviderError::Transient { .. }),
            "HTTP {status}"
        );
        assert!(evotengine::retry::should_retry(&err), "HTTP {status}");
    }
}

#[test]
fn classify_http_425_too_early_is_transient() {
    // 425 Too Early is an explicit "retry later" protocol signal; gateways
    // surface it during connection reuse races. It must not fail the run.
    let err = ProviderError::classify(425, "too early");
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn should_retry_hint_upgrades_only_unknown_classification() {
    // x-should-retry: true lets any gateway mark an unknown 4xx retryable
    // without an evot release.
    let err = ProviderError::classify_with_hints(402, "Payment Required", Some(true));
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));

    // Semantics with their own recovery paths are never overridden.
    let overflow = ProviderError::classify_with_hints(413, "", Some(true));
    assert!(overflow.is_context_overflow());
    let auth = ProviderError::classify_with_hints(401, "invalid key", Some(true));
    assert!(matches!(auth, ProviderError::Auth(_)));
    let quota = ProviderError::classify_with_hints(429, "quota exceeded", Some(true));
    assert!(quota.is_quota_limited());

    // An explicit false never downgrades a server-side failure — resilience
    // must not hinge on a proxy getting this header right.
    let five = ProviderError::classify_with_hints(500, "boom", Some(false));
    assert!(evotengine::retry::should_retry(&five));

    // Absent hint keeps the plain classification.
    let plain = ProviderError::classify_with_hints(402, "Payment Required", None);
    assert!(matches!(plain, ProviderError::Other(_)));
    assert!(!evotengine::retry::should_retry(&plain));
}

#[test]
fn classify_unknown_4xx_is_not_retryable() {
    for status in [402, 410, 418, 451] {
        let err = ProviderError::classify(status, "client-side failure");
        assert!(matches!(err, ProviderError::Other(_)), "HTTP {status}");
        assert!(!evotengine::retry::should_retry(&err), "HTTP {status}");
    }
}

#[test]
fn embedded_http_5xx_errors_are_retryable() {
    for status in [500, 501, 502, 503, 504, 520, 529, 599] {
        let err = ProviderError::Api(format!("API error: HTTP {status}: upstream failed"));
        assert!(evotengine::retry::should_retry(&err), "HTTP {status}");
    }
}

#[test]
fn embedded_http_4xx_errors_are_not_retryable() {
    for status in [400, 401, 403, 404, 422, 429] {
        let err = ProviderError::Api(format!("API error: HTTP {status}: request failed"));
        assert!(!evotengine::retry::should_retry(&err), "HTTP {status}");
    }
}

#[test]
fn try_again_later_is_retryable() {
    let err = ProviderError::Api("The model is busy, please try again later.".into());
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn stream_interrupted_api_error_is_retryable() {
    let err = ProviderError::Api(
        r#"{"type":"error","error":{"type":"api_error","message":"Stream interrupted. Please retry."}}"#
            .into(),
    );
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn upstream_request_failed_is_retryable() {
    // xAI (Grok) surfaces transient upstream failures as an inline SSE error
    // with this wording, classified as a bare Api error (no HTTP status).
    let err = ProviderError::Api("Upstream request failed.".into());
    assert!(evotengine::retry::should_retry(&err));

    let err = ProviderError::Api("API error: upstream error while proxying request".into());
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn malformed_tool_call_error_type_is_retryable() {
    let err = classify_sse_error_event(
        r#"{"type":"error","error":{"type":"invalid_tool_call","message":"wording may change"}}"#,
    );
    assert!(matches!(err, ProviderError::Transient { .. }));
    assert!(evotengine::retry::should_retry(&err));
}

#[test]
fn overflow_message_case_insensitive() {
    assert!(is_context_overflow_message("PROMPT IS TOO LONG"));
    assert!(is_context_overflow_message("Too Many Tokens in request"));
}

#[test]
fn non_overflow_messages() {
    assert!(!is_context_overflow_message("invalid api key"));
    assert!(!is_context_overflow_message("internal server error"));
    assert!(!is_context_overflow_message(""));
}

#[test]
fn classify_404_not_retryable() {
    let err = ProviderError::classify(404, "model not found");
    assert!(matches!(err, ProviderError::ModelNotFound(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn classify_405_not_retryable() {
    let err = ProviderError::classify(405, "method not allowed");
    assert!(matches!(err, ProviderError::Other(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn classify_422_not_retryable() {
    let err = ProviderError::classify(422, "unprocessable entity");
    assert!(matches!(err, ProviderError::Other(_)));
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn overflow_message_with_try_again_is_not_retryable() {
    // Regression: an overflow error whose wording also contains a transient
    // phrase ("try again") must NOT retry — it is handled by compaction.
    let msg = "Your input exceeds the context window of this model. \
               Please adjust your input and try again.";
    assert!(is_context_overflow_message(msg));
    let err = ProviderError::Api(msg.into());
    assert!(!evotengine::retry::should_retry(&err));
}

#[test]
fn throttling_with_too_many_tokens_is_not_overflow() {
    // Bedrock-style throttling contains the "too many tokens" overflow phrase
    // but is a rate-limit error — the non-overflow exclusion must win.
    let msg = "ThrottlingException: Too many tokens, please wait before trying again.";
    assert!(!is_context_overflow_message(msg));
}

#[test]
fn rate_limit_wording_is_not_overflow() {
    assert!(!is_context_overflow_message(
        "Rate limit reached: too many tokens per minute"
    ));
    assert!(!is_context_overflow_message("429 too many requests"));
}

// ---------------------------------------------------------------------------
// format_transport_detail
// ---------------------------------------------------------------------------

use std::error::Error;
use std::fmt;

#[derive(Debug)]
struct FakeError {
    msg: String,
    source: Option<Box<FakeError>>,
}

impl fmt::Display for FakeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl Error for FakeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_ref()
            .map(|s| s.as_ref() as &(dyn Error + 'static))
    }
}

#[test]
fn transport_detail_appends_url_when_missing() {
    let err = FakeError {
        msg: "connection reset".into(),
        source: None,
    };
    let detail = format_transport_detail(&err, Some("https://example.com/v1/messages"));
    assert_eq!(
        detail,
        "connection reset (url: https://example.com/v1/messages)"
    );
}

#[test]
fn transport_detail_does_not_duplicate_url_already_present() {
    let url = "https://example.com/v1/messages";
    let err = FakeError {
        msg: format!("error sending request for url ({url})"),
        source: None,
    };
    let detail = format_transport_detail(&err, Some(url));
    assert_eq!(detail.matches(url).count(), 1);
}

#[test]
fn transport_detail_skips_repeated_source_text() {
    let inner = FakeError {
        msg: "peer closed connection without sending TLS close_notify".into(),
        source: None,
    };
    let middle = FakeError {
        msg: "peer closed connection without sending TLS close_notify".into(),
        source: Some(Box::new(inner)),
    };
    let outer = FakeError {
        msg: "client error (SendRequest): peer closed connection without sending TLS close_notify"
            .into(),
        source: Some(Box::new(middle)),
    };
    let detail = format_transport_detail(&outer, Some("https://example.com/v1/messages"));
    assert_eq!(
        detail
            .matches("peer closed connection without sending TLS close_notify")
            .count(),
        1
    );
}

#[test]
fn transport_detail_surfaces_root_cause_from_chain() {
    // reqwest nests the real failure at the bottom of the source chain. Surface
    // only the deepest cause instead of concatenating every wrapper layer.
    let inner = FakeError {
        msg: "dns lookup failed".into(),
        source: None,
    };
    let outer = FakeError {
        msg: "connect error".into(),
        source: Some(Box::new(inner)),
    };
    let detail = format_transport_detail(&outer, None);
    assert_eq!(detail, "dns lookup failed");
}

#[test]
fn transport_detail_strips_docs_rs_reference() {
    // rustls appends a docs.rs manual link to its Display output; it is noise
    // for users and must be trimmed.
    let err = FakeError {
        msg: "peer closed connection without sending TLS close_notify: \
              https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof"
            .into(),
        source: None,
    };
    let detail = format_transport_detail(&err, Some("https://example.com/v1/messages"));
    assert_eq!(
        detail,
        "peer closed connection without sending TLS close_notify (url: https://example.com/v1/messages)"
    );
}

#[test]
fn content_filter_codes_are_refusals_and_plain_invalid_requests_are_not() {
    use evotengine::provider::stream::http::classify_json_error;

    for value in [
        serde_json::json!({"error": {"message": "filtered", "code": "content_filter"}}),
        serde_json::json!({"error": {
            "message": "filtered",
            "type": "invalid_request_error",
            "innererror": {"code": "ResponsibleAIPolicyViolation"}
        }}),
    ] {
        let error = classify_json_error(&value);
        assert!(is_refusal_message(&error.to_string()), "{value}");
        assert!(!evotengine::retry::should_retry(&error));
    }

    // Message wording alone never classifies a refusal.
    let plain = classify_json_error(&serde_json::json!({"error": {
        "message": "content_filter mentioned in text",
        "type": "invalid_request_error"
    }}));
    assert!(matches!(plain, ProviderError::InvalidRequest(_)));
    assert!(!is_refusal_message(&plain.to_string()));
}

#[test]
fn classify_additional_provider_overflow_wording() {
    for message in [
        r#"{"code":"1261","message":"Prompt too long"}"#,
        r#"{"code":"1261","message":"Prompt exceeds max length"}"#,
        "litellm.ContextWindowExceededError: Context Window exceeded for given call.",
        "Range of input length should be [1, 129024]",
        "Prompt has 300000 tokens, but the configured context size is 262144 tokens",
    ] {
        assert!(
            evotengine::provider::error::is_context_overflow_message(message),
            "{message}"
        );
        assert!(
            ProviderError::classify(400, message).is_context_overflow(),
            "{message}"
        );
    }
}
