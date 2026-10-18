//! Tests for provider-native remote compaction.

use std::sync::Arc;

use evotengine::context::compaction::config::CompactionConfig;
use evotengine::context::compaction::executor;
use evotengine::context::compaction::executor::ExecutionResult;
use evotengine::context::compaction::remote;
use evotengine::context::compaction::summary::LlmPolicy;
use evotengine::context::compaction::types::CompactionMethod;
use evotengine::context::CompactionPlan;
use evotengine::context::SummarizerContext;
use evotengine::context::SUMMARIZER_INPUT_MAX_BYTES;
use evotengine::provider::ApiProtocol;
use evotengine::provider::MockProvider;
use evotengine::provider::ModelConfig;
use evotengine::types::*;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

fn user(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![Content::Text { text: text.into() }],
        timestamp: 0,
    })
}

fn assistant(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text { text: text.into() }],
        stop_reason: StopReason::Stop,
        model: "gpt-5.6-sol".into(),
        provider: "openai".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn context(api: ApiProtocol, model: &str, base_url: &str) -> SummarizerContext {
    SummarizerContext {
        provider: Arc::new(MockProvider::text("local fallback")),
        model: model.into(),
        api_key: "test-key".into(),
        thinking_level: ThinkingLevel::Low,
        system_prompt: "You are a test agent.".into(),
        tools: vec![],
        max_tokens: None,
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config: Some(ModelConfig::resolve(
            evotengine::provider::ResolveModelRequest {
                protocol: api,
                provider: "openai".into(),
                model_id: model.into(),
                base_url: base_url.into(),
                headers: Default::default(),
                compat: None,
                route_capabilities: evotengine::provider::RouteCapabilities {
                    verbosity: false,
                    remote_compaction: api == ApiProtocol::OpenAiResponses,
                },
                overrides: Default::default(),
            },
        )),
    }
}

fn successful_sse(encrypted: &str) -> String {
    format!(
        "event: response.output_item.done\n\
         data: {{\"type\":\"response.output_item.done\",\"item\":{{\"type\":\"compaction\",\"encrypted_content\":\"{encrypted}\"}}}}\n\n\
         event: response.completed\n\
         data: {{\"type\":\"response.completed\",\"response\":{{\"usage\":{{\"total_tokens\":42}}}}}}\n\n"
    )
}

#[test]
fn prefixes_previous_local_summary_but_not_when_absent() {
    let evicted = vec![user("newer history")];
    let prefixed = remote::with_previous_local_summary(&evicted, Some("older local summary"));
    assert_eq!(prefixed.len(), 2);
    assert!(matches!(
        &prefixed[0],
        AgentMessage::Llm(Message::User { content, .. })
            if matches!(content.first(), Some(Content::Text { text })
                if text.contains("older local summary"))
    ));
    assert_eq!(remote::with_previous_local_summary(&evicted, None).len(), 1);
}

#[test]
fn downgrades_only_compaction_replay_items() {
    let messages = vec![Message::Assistant {
        content: vec![
            Content::Thinking {
                thinking: "portable summary".into(),
                metadata: Some(ThinkingMetadata::OpenAiResponses {
                    item: serde_json::json!({
                        "type": "compaction",
                        "encrypted_content": "opaque",
                    }),
                }),
            },
            Content::Thinking {
                thinking: "ordinary reasoning".into(),
                metadata: Some(ThinkingMetadata::OpenAiResponses {
                    item: serde_json::json!({
                        "type": "reasoning",
                        "encrypted_content": "reasoning-opaque",
                    }),
                }),
            },
        ],
        stop_reason: StopReason::Stop,
        model: "gpt-5.6-sol".into(),
        provider: "openai".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    }];

    let (downgraded, found) = remote::downgrade_replay_messages(&messages);
    assert!(found);
    assert!(matches!(
        &downgraded[0],
        Message::Assistant { content, .. }
            if matches!(content.first(), Some(Content::Text { text }) if text == "portable summary")
                && matches!(content.get(1), Some(Content::Thinking {
                    metadata: Some(ThinkingMetadata::OpenAiResponses { item }), ..
                }) if item["type"] == "reasoning")
    ));
}

#[test]
fn supports_only_catalog_profiled_responses_models() {
    assert!(remote::supports(&context(
        ApiProtocol::OpenAiResponses,
        "gpt-5.6-sol",
        "https://example.com/v1",
    )));
    assert!(!remote::supports(&context(
        ApiProtocol::OpenAiResponses,
        "codex-mini",
        "https://example.com/v1",
    )));
    assert!(!remote::supports(&context(
        ApiProtocol::OpenAiResponses,
        "gpt-5.7-nova",
        "https://example.com/v1",
    )));
    assert!(!remote::supports(&context(
        ApiProtocol::OpenAiResponses,
        "grok-4.5",
        "https://example.com/v1",
    )));
    assert!(!remote::supports(&context(
        ApiProtocol::OpenAiCompletions,
        "gpt-5.6-sol",
        "https://example.com/v1",
    )));
}

#[test]
fn parses_completed_compaction_item() {
    let result = remote::parse_compaction_sse(&successful_sse("opaque-blob"));
    let result = match result {
        Ok(result) => result,
        Err(error) => panic!("expected success, got {error:?}"),
    };
    assert_eq!(result.item["type"], "compaction");
    assert_eq!(result.item["encrypted_content"], "opaque-blob");
    assert_eq!(result.encrypted_bytes, 11);
}

#[test]
fn rejects_stream_without_completed_event() {
    let sse = "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"compaction\",\"encrypted_content\":\"x\"}}\n\n";
    assert!(matches!(
        remote::parse_compaction_sse(sse),
        Err(remote::RemoteError::Failed(message)) if message.contains("response.completed")
    ));
}

#[test]
fn propagates_response_failure_message() {
    let sse = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"not supported\"}}}\n\n";
    assert!(matches!(
        remote::parse_compaction_sse(sse),
        Err(remote::RemoteError::Failed(message)) if message == "not supported"
    ));
}

#[tokio::test]
async fn executor_assembles_replayable_remote_item() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(successful_sse("executor-state"), "text/event-stream"),
        )
        .mount(&server)
        .await;
    let ctx = context(ApiProtocol::OpenAiResponses, "gpt-5.6-sol", &server.uri());
    let messages = vec![
        user("pinned"),
        user("old request"),
        assistant("old answer"),
        user("another old request"),
        user("recent"),
        assistant("recent answer"),
    ];
    let plan = plan_for(&messages, 0..4, 4);

    let outcome = run(messages, &plan, Some(&ctx), LlmPolicy::Required).await;

    assert_eq!(outcome.stats.method, Some(CompactionMethod::Remote));
    assert_eq!(outcome.stats.remote_blob_bytes, Some(14));
    assert!(matches!(
        outcome.messages.first(),
        Some(AgentMessage::Llm(Message::Assistant { content, .. }))
            if matches!(content.first(), Some(Content::Thinking {
                metadata: Some(ThinkingMetadata::OpenAiResponses { item }), ..
            }) if item["type"] == "compaction" && item["encrypted_content"] == "executor-state")
    ));
    assert!(outcome.state.context_summary_message.is_none());
    assert!(outcome.state.last_summary.is_some());
}

#[tokio::test]
async fn executor_uses_deterministic_fallback_after_remote_failure_for_overflow() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(ResponseTemplate::new(500).set_body_string("remote unavailable"))
        .mount(&server)
        .await;
    // Empty mock response queue proves overflow does not make a second LLM call.
    let mut ctx = context(ApiProtocol::OpenAiResponses, "gpt-5.6-sol", &server.uri());
    ctx.provider = Arc::new(MockProvider::new(vec![]));
    let messages = vec![
        user("oldest fact"),
        user("old deterministic fact"),
        assistant("old answer"),
        user("recent"),
        assistant("recent answer"),
    ];
    let plan = plan_for(&messages, 0..3, 3);

    let outcome = run(messages, &plan, Some(&ctx), LlmPolicy::Skip).await;

    assert_eq!(
        outcome.stats.method,
        Some(CompactionMethod::RemoteFailedLocal)
    );
    assert!(outcome.stats.summary.is_some());
    assert!(matches!(
        outcome.messages.first(),
        Some(AgentMessage::Llm(Message::User { content, .. }))
            if matches!(content.first(), Some(Content::Text { text })
                if text.contains("oldest fact") && text.contains("old deterministic fact"))
    ));
}

#[tokio::test]
async fn executor_falls_back_to_local_summary_when_remote_fails() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(ResponseTemplate::new(500).set_body_string("remote unavailable"))
        .mount(&server)
        .await;
    let ctx = context(ApiProtocol::OpenAiResponses, "gpt-5.6-sol", &server.uri());
    let messages = vec![
        user("oldest request"),
        user("old request"),
        assistant("old answer"),
        user("recent"),
        assistant("recent answer"),
    ];
    let plan = plan_for(&messages, 0..3, 3);

    let outcome = run(messages, &plan, Some(&ctx), LlmPolicy::Required).await;

    assert_eq!(
        outcome.stats.method,
        Some(CompactionMethod::RemoteFailedLocal)
    );
    assert_eq!(outcome.stats.remote_blob_bytes, None);
    assert!(outcome
        .stats
        .fallback_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("remote unavailable")));
    assert!(matches!(
        outcome.messages.first(),
        Some(AgentMessage::Llm(Message::User { content, .. }))
            if matches!(content.first(), Some(Content::Text { text }) if text == "local fallback")
    ));
    assert_eq!(outcome.stats.messages_evicted, plan.first_kept);
}

fn plan_for(
    messages: &[AgentMessage],
    summarize: std::ops::Range<usize>,
    first_kept: usize,
) -> CompactionPlan {
    CompactionPlan {
        summarize,
        turn_prefix: None,
        first_kept,
        first_kept_seq: first_kept as u64 + 1,
        split_turn: None,
        tokens_before: 0,
        messages_before: messages.len(),
        file_ops: Default::default(),
    }
}

async fn run(
    messages: Vec<AgentMessage>,
    plan: &CompactionPlan,
    ctx: Option<&evotengine::context::SummarizerContext>,
    llm_policy: LlmPolicy,
) -> evotengine::context::CompactionOutcome {
    let result = executor::execute(
        messages,
        plan,
        &CompactionConfig::default(),
        None,
        ctx,
        executor::ExecutionOptions {
            llm_policy,
            observer: None,
            cancel: CancellationToken::new(),
        },
    )
    .await;
    match result {
        ExecutionResult::Compacted(outcome) => *outcome,
        ExecutionResult::Skipped(_) => panic!("expected compaction to run"),
    }
}

#[tokio::test]
async fn oversized_remote_request_is_rejected_before_network_send() {
    let server = MockServer::start().await;
    let ctx = context(ApiProtocol::OpenAiResponses, "gpt-5.6-sol", &server.uri());
    let oversized = "x".repeat(SUMMARIZER_INPUT_MAX_BYTES);

    let result = remote::compact(&ctx, &[user(&oversized)], CancellationToken::new()).await;
    assert!(matches!(
        result,
        Err(remote::RemoteError::Failed(message))
            if message.contains("safety limit") && message.contains("remote compaction request")
    ));
    let request_count = server
        .received_requests()
        .await
        .map_or(0, |requests| requests.len());
    assert_eq!(request_count, 0, "oversized body reached the network");
}

#[tokio::test]
async fn posts_compaction_trigger_and_returns_opaque_item() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .and(body_partial_json(serde_json::json!({
            "model": "gpt-5.6-sol",
            "stream": true,
        })))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(successful_sse("encrypted-state"), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let ctx = context(ApiProtocol::OpenAiResponses, "gpt-5.6-sol", &server.uri());
    let result = remote::compact(
        &ctx,
        &[user("remember ZEBRA-7"), assistant("remembered")],
        CancellationToken::new(),
    )
    .await;
    let result = match result {
        Ok(result) => result,
        Err(error) => panic!("expected success, got {error:?}"),
    };

    assert_eq!(result.item["encrypted_content"], "encrypted-state");
    assert_eq!(result.encrypted_bytes, 15);

    let requests = match server.received_requests().await {
        Some(requests) => requests,
        None => panic!("expected recorded request"),
    };
    let body: serde_json::Value = match serde_json::from_slice(&requests[0].body) {
        Ok(body) => body,
        Err(error) => panic!("invalid request body: {error}"),
    };
    let input = match body["input"].as_array() {
        Some(input) => input,
        None => panic!("expected input array"),
    };
    assert_eq!(
        input.last().and_then(|item| item["type"].as_str()),
        Some("compaction_trigger")
    );
    assert!(body.get("store").is_none());
    assert!(body.get("max_output_tokens").is_none());
    assert_eq!(
        body["include"],
        serde_json::json!(["reasoning.encrypted_content"])
    );
}
