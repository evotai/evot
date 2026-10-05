//! Tests for the CompactionController.

use std::sync::Arc;

use evotengine::context::compaction::config::CompactionConfig;
use evotengine::context::compaction::controller::CompactionController;
use evotengine::context::compaction::types::AfterResponseAction;
use evotengine::context::compaction::types::CompactionPhase;
use evotengine::context::compaction::types::ModelId;
use evotengine::context::compaction::types::UsageSnapshot;
use evotengine::context::SummarizerContext;
use evotengine::context::SummarizerMode;
use evotengine::provider::ApiProtocol;
use evotengine::provider::MockProvider;
use evotengine::provider::MockResponse;
use evotengine::provider::ModelConfig;
use evotengine::types::*;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

use super::fixtures::recording_provider::RecordingProvider;
use super::fixtures::recording_provider::Reply;

fn responses_model(base_url: &str) -> ModelConfig {
    ModelConfig::resolve(evotengine::provider::ResolveModelRequest {
        protocol: ApiProtocol::OpenAiResponses,
        provider: "openai".into(),
        model_id: "gpt-5.6-sol".into(),
        base_url: base_url.into(),
        headers: Default::default(),
        compat: None,
        route_capabilities: evotengine::provider::RouteCapabilities {
            verbosity: false,
            remote_compaction: true,
        },
        overrides: Default::default(),
    })
}

fn user_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::User {
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        timestamp: 0,
    })
}

fn assistant_msg(text: &str) -> AgentMessage {
    assistant_msg_with_usage(text, 0, 0)
}

fn assistant_msg_with_usage(text: &str, input: u64, output: u64) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        stop_reason: evotengine::StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage {
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            total_tokens: input + output,
            reasoning_output: 0,
        },
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn big_text(n: usize) -> String {
    "x".repeat(n)
}

fn tool_result_msg(id: &str, text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::ToolResult {
        tool_call_id: id.to_string(),
        tool_name: "read".to_string(),
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        is_error: false,
        timestamp: 0,
        retention: Retention::default(),
    })
}

fn model_id() -> ModelId {
    ModelId {
        provider: "test".into(),
        model: "test".into(),
    }
}

fn config_small() -> CompactionConfig {
    CompactionConfig {
        context_window: 10_000,
        reserve_tokens: 2_000,
        advertised_context_window: None,
        trigger_tokens: None,
        keep_recent_tokens: 1_000,
        summarizer_mode: SummarizerMode::default(),
        summary_max_bytes: 4000,
    }
}

#[tokio::test]
async fn controller_reports_live_local_phase_order() {
    let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = Arc::clone(&phases);
    let observer: evotengine::CompactionObserver = Arc::new(move |phase| {
        if let Ok(mut phases) = observed.lock() {
            phases.push(phase);
        }
    });
    let mut ctrl = CompactionController::new(config_small()).with_observer(observer);
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }

    let result = ctrl
        .compact_on_estimate(
            &mut messages,
            9_000,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(result.stats.is_some());
    let phases = phases.lock().unwrap_or_else(|error| error.into_inner());
    assert_eq!(phases.as_slice(), [
        CompactionPhase::Planning,
        CompactionPhase::Local,
        CompactionPhase::Complete,
    ]);
}

#[tokio::test]
async fn controller_skips_when_below_threshold() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg("hello"), assistant_msg("hi")];

    let usage = UsageSnapshot {
        input: 500,
        cache_read: 0,
        cache_write: 0,
        output: 100,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Stop,
        error_message: None,
    };

    let cancel = CancellationToken::new();
    let response = ctrl
        .after_response(&mut messages, &usage, &model_id(), None, cancel)
        .await;
    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_none());
    assert_eq!(messages.len(), 2); // unchanged
}

#[tokio::test]
async fn controller_compacts_on_threshold() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let original_count = messages.len();

    // Usage that exceeds threshold (10_000 - 2_000 = 8_000)
    let usage = UsageSnapshot {
        input: 8_500,
        cache_read: 0,
        cache_write: 0,
        output: 500,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Stop,
        error_message: None,
    };

    let cancel = CancellationToken::new();
    let response = ctrl
        .after_response(&mut messages, &usage, &model_id(), None, cancel)
        .await;
    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_some());
    assert!(messages.len() < original_count);
}

#[tokio::test]
async fn controller_keeps_successful_silent_overflow_and_does_not_retry() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("completed answer"));

    let usage = UsageSnapshot {
        input: 10_100,
        cache_read: 0,
        cache_write: 0,
        output: 100,
        total_tokens: 10_200,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Stop,
        error_message: None,
    };

    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Continue);
    assert_eq!(
        response.reason,
        Some(evotengine::context::CompactReason::Overflow)
    );
    assert!(response.stats.is_some());
    assert!(messages.iter().any(|message| matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "completed answer"))
    )));
}

#[tokio::test]
async fn controller_retries_on_overflow() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    // This is the error message that will be removed
    messages.push(assistant_msg("error response"));

    let original_count = messages.len();

    let usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    let cancel = CancellationToken::new();
    let response = ctrl
        .after_response(&mut messages, &usage, &model_id(), None, cancel)
        .await;
    assert_eq!(response.action, AfterResponseAction::Retry);
    // Error message should have been popped
    assert!(messages.len() < original_count);
}

#[tokio::test]
async fn overflow_falls_back_to_emergency_when_summarizer_fails() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config.clone());
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("overflow error"));
    let original_count = messages.len();

    // The summarize request goes to the same provider that just rejected the
    // oversized payload and fails the same way.
    let provider = Arc::new(RecordingProvider::new(vec![
        Reply::error("HTTP 413: request too large"),
        Reply::error("HTTP 413: request too large"),
    ]));
    let captured = provider.captured();
    let ctx = SummarizerContext {
        provider,
        model: "test".into(),
        api_key: "key".into(),
        thinking_level: ThinkingLevel::Off,
        system_prompt: big_text(2_400),
        tools: vec![],
        max_tokens: Some(1024),
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config: None,
    };

    let usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: evotengine::context::now_ms() + 60_000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    let planning_messages = messages[..messages.len() - 1].to_vec();
    let overhead = evotengine::context::estimate_tokens(&ctx.system_prompt);
    let expected_plan = evotengine::context::plan_messages(
        &planning_messages,
        config.retained_tail_budget(overhead),
    );
    let expected_evicted = expected_plan.map(|plan| plan.first_kept);

    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            Some(&ctx),
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Retry);
    assert!(response.stats.is_some());
    assert_eq!(
        response.stats.as_ref().map(|stats| stats.messages_evicted),
        expected_evicted,
        "emergency degradation must preserve the active request overhead budget"
    );
    assert!(!response.overflow_recovery_failed);
    assert!(messages.len() < original_count);
    assert!(
        !captured.lock().is_empty(),
        "the LLM summarizer must be attempted before the emergency fallback"
    );
}

#[tokio::test]
async fn cancelled_summarizer_does_not_fall_back_or_compact() {
    let mut ctrl = CompactionController::new(config_small());
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("overflow error"));

    let provider = Arc::new(RecordingProvider::new(vec![Reply::Cancel]));
    let captured = provider.captured();
    let ctx = SummarizerContext {
        provider,
        model: "test".into(),
        api_key: "key".into(),
        thinking_level: ThinkingLevel::Off,
        system_prompt: String::new(),
        tools: vec![],
        max_tokens: Some(1024),
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config: None,
    };
    let usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: evotengine::context::now_ms() + 60_000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };
    let cancel = CancellationToken::new();

    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            Some(&ctx),
            cancel.clone(),
        )
        .await;

    assert!(cancel.is_cancelled());
    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_none());
    assert!(!response.overflow_recovery_failed);
    assert_eq!(
        captured.lock().len(),
        1,
        "must not issue a fallback request"
    );
    assert!(matches!(
        messages.last(),
        Some(AgentMessage::Llm(Message::User { content, .. }))
            if matches!(content.first(), Some(Content::Text { text }) if text == "recent")
    ));
}

#[tokio::test]
async fn overflow_recovery_compacts_unsplittable_tool_result_tail() {
    let mut ctrl = CompactionController::new(config_small());
    let mut messages = vec![
        user_msg("generate the presentation"),
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "call-read".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "slides.md"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "test".into(),
            provider: "test".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }),
        tool_result_msg("call-read", &big_text(50_000)),
        assistant_msg("overflow response"),
    ];
    let usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Retry);
    assert!(!response.overflow_recovery_failed);
    let stats = match response.stats {
        Some(stats) => stats,
        None => panic!("overflow fallback should compact the oversized active turn"),
    };
    assert_eq!(stats.messages_evicted, 3);
    assert_eq!(messages.len(), 1);
    assert!(matches!(
        messages.first(),
        Some(AgentMessage::Llm(Message::User { .. }))
    ));
}

#[tokio::test]
async fn controller_does_not_retry_when_overflow_cannot_be_compacted() {
    let mut ctrl = CompactionController::new(config_small());
    let mut messages = vec![user_msg("recent"), assistant_msg("overflow")];
    let usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_none());
    assert!(!response.overflow_exhausted);
    assert!(
        response.overflow_recovery_failed,
        "an unrecoverable overflow must be surfaced, not silently dropped"
    );
}

#[tokio::test]
async fn restored_state_suppresses_pre_compaction_overflow() {
    let seeded = evotengine::CompactionState {
        timestamp: 1000,
        generation: 1,
        ..Default::default()
    };
    let mut ctrl = CompactionController::new(config_small()).with_state(seeded);
    let mut messages = vec![user_msg("recent"), assistant_msg("stale overflow")];
    let stale_usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    let response = ctrl
        .after_response(
            &mut messages,
            &stale_usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_none());
    assert_eq!(messages.len(), 2);
}

#[tokio::test]
async fn controller_does_not_retry_twice() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("error"));

    let usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    // First overflow triggers retry
    let cancel = CancellationToken::new();
    let response = ctrl
        .after_response(&mut messages, &usage, &model_id(), None, cancel)
        .await;
    assert_eq!(response.action, AfterResponseAction::Retry);

    // Add another error message
    messages.push(assistant_msg("error again"));
    let usage2 = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: 2000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    // Second overflow should NOT retry
    let cancel2 = CancellationToken::new();
    let response2 = ctrl
        .after_response(&mut messages, &usage2, &model_id(), None, cancel2)
        .await;
    assert_eq!(response2.action, AfterResponseAction::Continue);
    assert!(response2.stats.is_none());
}

#[tokio::test]
async fn controller_state_carries_across_compactions_and_seed() {
    use evotengine::context::CompactionState;

    // Seed: as if restored from a persisted session that compacted 3 times.
    let mut seeded = CompactionState {
        generation: 3,
        last_summary: Some("PREVIOUS SUMMARY".into()),
        context_summary_message: Some("RESTORED SUMMARY MESSAGE".into()),
        ..Default::default()
    };
    seeded.file_ops.read.insert("src/seeded.rs".to_string());

    let mut ctrl = CompactionController::new(config_small()).with_state(seeded);

    let mut messages = vec![
        user_msg("RESTORED SUMMARY MESSAGE"),
        user_msg(&big_text(200)),
        assistant_msg(&big_text(200)),
    ];
    // A tool call in the evict zone so file-op accumulation is observable.
    messages.push(AgentMessage::Llm(Message::Assistant {
        content: vec![Content::ToolCall {
            id: "call-read".into(),
            name: "read".into(),
            arguments: serde_json::json!({ "path": "src/evicted.rs" }),
            metadata: None,
        }],
        stop_reason: evotengine::StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    }));
    messages.push(AgentMessage::Llm(Message::ToolResult {
        tool_call_id: "call-read".into(),
        tool_name: "read".into(),
        content: vec![Content::Text {
            text: "contents".into(),
        }],
        is_error: false,
        timestamp: 0,
        retention: Default::default(),
    }));
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let stats = ctrl
        .force_compact(&mut messages, None, CancellationToken::new())
        .await;
    assert!(stats.is_some());

    let state = ctrl.state();
    // Generation continues from the seed instead of restarting at 1.
    assert_eq!(state.generation, 4);
    // File ops accumulate: seeded entry + the newly evicted read.
    assert!(state.file_ops.read.contains("src/seeded.rs"));
    assert!(state.file_ops.read.contains("src/evicted.rs"));
    // The new summary replaces the seeded one for the next round. The restored
    // summary message is removed before planning, while its semantic content is
    // merged exactly once through `previous_summary`.
    let summary = state.last_summary.as_deref().unwrap_or_default();
    assert_eq!(summary.matches("PREVIOUS SUMMARY").count(), 1);
    assert!(!summary.contains("RESTORED SUMMARY MESSAGE"));
    assert_eq!(state.context_summary_message.as_deref(), Some(summary));
    assert!(!messages.iter().any(
        |message| matches!(message, AgentMessage::Llm(Message::User { content, .. })
            if matches!(content.as_slice(), [Content::Text { text }] if text == "RESTORED SUMMARY MESSAGE"))
    ));
}

#[tokio::test]
async fn controller_restores_seeded_summary_when_there_is_no_plan() {
    use evotengine::context::CompactionState;

    let seeded = CompactionState {
        last_summary: Some("previous".into()),
        context_summary_message: Some("summary message".into()),
        ..Default::default()
    };
    let mut ctrl = CompactionController::new(config_small()).with_state(seeded);
    let mut messages = vec![user_msg("summary message"), user_msg("recent")];

    let stats = ctrl
        .force_compact(&mut messages, None, CancellationToken::new())
        .await;

    assert!(stats.is_none());
    assert_eq!(messages.len(), 2);
    assert!(
        matches!(&messages[0], AgentMessage::Llm(Message::User { content, .. })
        if matches!(content.as_slice(), [Content::Text { text }] if text == "summary message"))
    );
}

#[tokio::test]
async fn controller_retries_remote_after_an_earlier_compaction_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(ResponseTemplate::new(500).set_body_string("transient remote failure"))
        .mount(&server)
        .await;
    let provider = Arc::new(MockProvider::new(vec![
        MockResponse::Text("first local summary".into()),
        MockResponse::Text("second local summary".into()),
    ]));
    let ctx = SummarizerContext {
        provider,
        model: "gpt-5.6-sol".into(),
        api_key: "test-key".into(),
        thinking_level: ThinkingLevel::Off,
        system_prompt: String::new(),
        tools: vec![],
        max_tokens: Some(1024),
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config: Some(responses_model(&server.uri())),
    };
    let mut ctrl = CompactionController::new(config_small());
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let first = ctrl
        .force_compact(&mut messages, Some(&ctx), CancellationToken::new())
        .await;
    assert!(matches!(
        first.and_then(|stats| stats.method),
        Some(evotengine::CompactionMethod::RemoteFailedLocal)
    ));

    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    let second = ctrl
        .force_compact(&mut messages, Some(&ctx), CancellationToken::new())
        .await;
    assert!(matches!(
        second.and_then(|stats| stats.method),
        Some(evotengine::CompactionMethod::RemoteFailedLocal)
    ));

    let requests = server.received_requests().await.unwrap_or_default();
    assert_eq!(requests.len(), 2, "each compaction must retry remote");
}

#[tokio::test]
async fn controller_reports_live_remote_fallback_phase_order() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(ResponseTemplate::new(500).set_body_string("transient remote failure"))
        .mount(&server)
        .await;
    let provider = Arc::new(MockProvider::new(vec![MockResponse::Text(
        "local fallback summary".into(),
    )]));
    let ctx = SummarizerContext {
        provider,
        model: "gpt-5.6-sol".into(),
        api_key: "test-key".into(),
        thinking_level: ThinkingLevel::Off,
        system_prompt: String::new(),
        tools: vec![],
        max_tokens: Some(1024),
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config: Some(responses_model(&server.uri())),
    };

    let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = Arc::clone(&phases);
    let observer: evotengine::CompactionObserver = Arc::new(move |phase| {
        if let Ok(mut phases) = observed.lock() {
            phases.push(phase);
        }
    });
    let mut ctrl = CompactionController::new(config_small()).with_observer(observer);
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }

    let stats = ctrl
        .force_compact(&mut messages, Some(&ctx), CancellationToken::new())
        .await;
    assert!(matches!(
        stats.and_then(|stats| stats.method),
        Some(evotengine::CompactionMethod::RemoteFailedLocal)
    ));
    let phases = phases.lock().unwrap_or_else(|error| error.into_inner());
    assert_eq!(phases.as_slice(), [
        CompactionPhase::Planning,
        CompactionPhase::Remote,
        CompactionPhase::LocalFallback,
        CompactionPhase::Complete,
    ]);
}

#[tokio::test]
async fn controller_allows_multiple_stateless_compactions() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let first = ctrl
        .force_compact(&mut messages, None, CancellationToken::new())
        .await;
    assert!(first.is_some());

    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }

    let second = ctrl
        .force_compact(&mut messages, None, CancellationToken::new())
        .await;
    assert!(second.is_some());
}

#[tokio::test]
async fn overflow_exhausted_signals_after_second_overflow() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("error"));

    // The first overflow's compaction records last_compaction_ts = now_ms().
    // The second usage must carry a timestamp after that, otherwise it would
    // be skipped as stale rather than treated as overflow-exhausted.
    let future_ts = evotengine::context::now_ms() + 60_000;
    let overflow_usage = |ts: u64| UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: ts,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };

    // First overflow triggers a compact-and-retry.
    let first = ctrl
        .after_response(
            &mut messages,
            &overflow_usage(future_ts),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(first.action, AfterResponseAction::Retry);
    assert!(!first.overflow_exhausted);

    // Second overflow this turn: recovery is exhausted. Do not retry, and
    // signal the loop to surface a user-visible message.
    messages.push(assistant_msg("error again"));
    let second = ctrl
        .after_response(
            &mut messages,
            &overflow_usage(future_ts + 1),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(second.action, AfterResponseAction::Continue);
    assert!(second.overflow_exhausted);
    assert!(second.stats.is_none());
}

#[tokio::test]
async fn estimate_compaction_does_not_reset_overflow_recovery() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);
    let overflow_usage = UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: evotengine::context::now_ms() + 60_000,
        stop_reason: StopReason::Error,
        error_message: Some("prompt is too long: 50000 tokens > 10000 maximum".into()),
    };
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(assistant_msg("first overflow"));

    let first = ctrl
        .after_response(
            &mut messages,
            &overflow_usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(first.action, AfterResponseAction::Retry);

    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    let _ = ctrl
        .compact_on_estimate(
            &mut messages,
            9_000,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    messages.push(assistant_msg("second overflow"));

    let second = ctrl
        .after_response(
            &mut messages,
            &UsageSnapshot {
                timestamp: overflow_usage.timestamp + 1,
                ..overflow_usage
            },
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(second.action, AfterResponseAction::Continue);
    assert!(second.overflow_exhausted);
}

#[tokio::test]
async fn compact_on_estimate_compacts_when_over_threshold() {
    // Mirrors the post-response fallback for a non-overflow error: no usable
    // usage, so the controller compacts purely on the supplied estimate.
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));
    let original_count = messages.len();

    // Estimate over the 8_000 threshold (window 10_000 - reserve 2_000).
    let response = ctrl
        .compact_on_estimate(
            &mut messages,
            9_000,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_some());
    assert!(!response.overflow_exhausted);
    assert!(messages.len() < original_count);
}

#[tokio::test]
async fn compact_on_estimate_skips_below_threshold() {
    let config = config_small();
    let mut ctrl = CompactionController::new(config);

    let mut messages = vec![user_msg("hello"), assistant_msg("hi")];
    let original_count = messages.len();

    let response = ctrl
        .compact_on_estimate(
            &mut messages,
            1_000,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert_eq!(response.action, AfterResponseAction::Continue);
    assert!(response.stats.is_none());
    assert_eq!(messages.len(), original_count);
}

#[tokio::test]
async fn threshold_suppression_skips_repeat_until_usage_recovers() {
    // droid-style suppression: a threshold compaction that cannot bring usage
    // back under the limit must not repeat every turn.
    let mut ctrl = CompactionController::new(config_small());
    let big_messages = || {
        let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
        for _ in 0..20 {
            messages.push(user_msg(&big_text(300)));
            messages.push(assistant_msg(&big_text(300)));
        }
        messages.push(user_msg("recent"));
        messages.push(assistant_msg("recent answer"));
        messages
    };
    let over_threshold = |ts: u64| UsageSnapshot {
        input: 9_000,
        cache_read: 0,
        cache_write: 0,
        output: 100,
        total_tokens: 0,
        model: model_id(),
        timestamp: ts,
        stop_reason: StopReason::Stop,
        error_message: None,
    };
    let base_ts = evotengine::context::now_ms() + 60_000;

    // First over-threshold usage compacts and arms the suppression.
    let mut messages = big_messages();
    let first = ctrl
        .after_response(
            &mut messages,
            &over_threshold(base_ts),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(first.stats.is_some());

    // Usage still over the threshold: suppressed, no second compaction.
    let mut messages = big_messages();
    let second = ctrl
        .after_response(
            &mut messages,
            &over_threshold(base_ts + 1),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(second.stats.is_none());
    assert!(
        second.reason.is_none(),
        "suppressed threshold must be a skip"
    );

    // Usage recovered below the threshold: suppression clears...
    let recovered = UsageSnapshot {
        input: 500,
        output: 100,
        timestamp: base_ts + 2,
        ..over_threshold(0)
    };
    let mut small = vec![user_msg("hello"), assistant_msg("hi")];
    let third = ctrl
        .after_response(
            &mut small,
            &recovered,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(third.stats.is_none());

    // ...so the next over-threshold usage compacts again.
    let mut messages = big_messages();
    let fourth = ctrl
        .after_response(
            &mut messages,
            &over_threshold(base_ts + 3),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(fourth.stats.is_some());
}

#[tokio::test]
async fn threshold_suppression_is_scoped_to_the_model() {
    let mut ctrl = CompactionController::new(config_small());
    let big_messages = || {
        let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
        for _ in 0..20 {
            messages.push(user_msg(&big_text(300)));
            messages.push(assistant_msg(&big_text(300)));
        }
        messages
    };
    let base_ts = evotengine::context::now_ms() + 60_000;

    let mut messages = big_messages();
    let first = ctrl
        .compact_on_estimate(
            &mut messages,
            9_000,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(first.stats.is_some());

    // Same model, still over: suppressed.
    let mut messages = big_messages();
    let second = ctrl
        .compact_on_estimate(
            &mut messages,
            9_000,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(second.stats.is_none());

    // A different model has its own boundary: not suppressed.
    let other = ModelId {
        provider: "test".into(),
        model: "other".into(),
    };
    let mut messages = big_messages();
    let third = ctrl
        .compact_on_estimate(&mut messages, 9_000, &other, None, CancellationToken::new())
        .await;
    assert!(third.stats.is_some(), "suppression must be per-model");
    let _ = base_ts;
}

/// A judge that wants everything gone: every question answers "no".
struct DropAllJudge;

#[async_trait::async_trait]
impl evotengine::judge::Judge for DropAllJudge {
    async fn ask(
        &self,
        _state: &str,
        questions: &[evotengine::judge::Question],
        _cancel: CancellationToken,
    ) -> Result<
        std::collections::HashMap<String, evotengine::judge::Answer>,
        evotengine::judge::JudgeError,
    > {
        Ok(questions
            .iter()
            .map(|q| {
                (q.id.clone(), evotengine::judge::Answer::Noul {
                    probability: 0.0,
                })
            })
            .collect())
    }
}

fn tool_call_msg(id: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::ToolCall {
            id: id.to_string(),
            name: "read".to_string(),
            arguments: serde_json::json!({"path": "big.log"}),
            metadata: None,
        }],
        stop_reason: evotengine::StopReason::ToolUse,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

/// At the threshold a judge gets to prune first; when the lossless cut is
/// enough there is no summary at all.
#[tokio::test]
async fn threshold_with_judge_prunes_instead_of_summarising() {
    let mut ctrl = CompactionController::new(config_small()).with_judge(Arc::new(DropAllJudge));

    let mut messages = vec![
        user_msg("read the log"),
        tool_call_msg("c1"),
        tool_result_msg("c1", &big_text(30_000)),
    ];
    for _ in 0..6 {
        messages.push(assistant_msg("done"));
    }

    let usage = UsageSnapshot {
        input: 8_500,
        cache_read: 0,
        cache_write: 0,
        output: 100,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Stop,
        error_message: None,
    };

    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    let stats = match response.stats {
        Some(stats) => stats,
        None => panic!("threshold with a judge must compact"),
    };
    assert_eq!(stats.method, Some(evotengine::CompactionMethod::Prune));
    assert!(stats.summary.is_none(), "lossless cut was enough");
    assert!(
        !messages.iter().any(|m| matches!(
            m,
            AgentMessage::Llm(Message::ToolResult { content, .. })
                if content.iter().any(|c| matches!(c, Content::Text { text } if text.len() > 1_000))
        )),
        "the big result was pruned"
    );
}

/// A provider rejection is authoritative even when the local estimate fits.
/// A prune-only cut must not consume the sole compact-and-retry allowance.
#[tokio::test]
async fn overflow_with_judge_summarizes_even_when_pruning_would_fit() {
    for summarizer_fails in [false, true] {
        let config = config_small();
        let mut ctrl = CompactionController::new(config.clone()).with_judge(Arc::new(DropAllJudge));
        let mut messages = vec![
            user_msg(&big_text(8_000)),
            tool_call_msg("c1"),
            tool_result_msg("c1", &big_text(12_000)),
        ];
        // Leave the old tool call outside the judge's protected recent tail.
        for _ in 0..6 {
            messages.push(assistant_msg("done"));
        }
        messages.push(user_msg("continue the task"));
        assert!(evotengine::context::total_tokens(&messages) < config.trigger_threshold());
        messages.push(assistant_msg("overflow error"));

        let replies = if summarizer_fails {
            vec![Reply::error("HTTP 413: request too large"); 2]
        } else {
            vec![Reply::text("Preserve the task and continue investigating."); 2]
        };
        let provider = Arc::new(RecordingProvider::new(replies));
        let captured = provider.captured();
        let ctx = SummarizerContext {
            provider,
            model: "test".into(),
            api_key: "key".into(),
            thinking_level: ThinkingLevel::Off,
            system_prompt: String::new(),
            tools: vec![],
            max_tokens: Some(1024),
            cache_config: CacheConfig::default(),
            prompt_cache_key: None,
            model_config: None,
        };
        let usage = UsageSnapshot {
            input: 0,
            cache_read: 0,
            cache_write: 0,
            output: 0,
            total_tokens: 0,
            model: model_id(),
            timestamp: evotengine::context::now_ms() + 60_000,
            stop_reason: StopReason::Error,
            error_message: Some("HTTP 413: request too large".into()),
        };
        let response = ctrl
            .after_response(
                &mut messages,
                &usage,
                &model_id(),
                Some(&ctx),
                CancellationToken::new(),
            )
            .await;

        assert_eq!(response.action, AfterResponseAction::Retry);
        assert!(!response.overflow_recovery_failed);
        let stats = match response.stats {
            Some(stats) => stats,
            None => panic!("overflow recovery must compact before retrying"),
        };
        assert!(stats.summary.is_some(), "overflow requires a real summary");
        assert_ne!(stats.method, Some(evotengine::CompactionMethod::Prune));
        assert!(stats.after_tokens < stats.before_tokens);
        assert!(!captured.lock().is_empty(), "attempt the LLM summary first");
        assert!(messages.iter().any(|message| matches!(
            message,
            AgentMessage::Llm(Message::User { content, .. })
                if content.iter().any(|block| matches!(block, Content::Text { text } if text == "continue the task"))
        )), "retain the active task for the automatic retry");
    }
}

/// Between the prune threshold (60% of the window) and the summary threshold
/// a response triggers the prune branch alone: pending edits land, the
/// response reports them, and no compaction is planned.
#[tokio::test]
async fn mid_run_prune_fires_between_the_prune_and_summary_thresholds() {
    let config = config_small();
    let prune_at = config.prune_trigger_threshold();
    let summary_at = config.trigger_threshold();
    assert!(prune_at < summary_at, "{prune_at} < {summary_at}");
    let mut ctrl = CompactionController::new(config).with_judge(Arc::new(DropAllJudge));

    // Enough calls to clear the judge's minimum batch (`decide_min_candidates`).
    let mut messages = vec![user_msg("read the logs")];
    for n in 0..10 {
        let id = format!("c{n}");
        messages.push(tool_call_msg(&id));
        messages.push(tool_result_msg(&id, &big_text(3_000)));
    }
    for _ in 0..6 {
        messages.push(assistant_msg("done"));
    }
    let before = messages.len();

    let usage = UsageSnapshot {
        input: (prune_at + summary_at) / 2,
        cache_read: 0,
        cache_write: 0,
        output: 100,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Stop,
        error_message: None,
    };
    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;

    assert!(response.stats.is_none(), "no summary below its threshold");
    let applied = match response.pruned.and_then(|p| p.applied) {
        Some(applied) => applied,
        None => panic!("the prune branch must have applied"),
    };
    assert_eq!(
        applied.trigger,
        evotengine::context::compaction::ApplyTrigger::Threshold
    );
    assert_eq!(
        applied.removed + applied.truncated,
        10,
        "every unpinned call was cut"
    );
    assert!(messages.len() < before);
}

/// Below the prune threshold a response leaves history alone.
#[tokio::test]
async fn below_the_prune_threshold_nothing_is_pruned() {
    let config = config_small();
    let usage_tokens = config.prune_trigger_threshold() / 2;
    let mut ctrl = CompactionController::new(config).with_judge(Arc::new(DropAllJudge));
    let mut messages = vec![
        user_msg("read the log"),
        tool_call_msg("c1"),
        tool_result_msg("c1", &big_text(30_000)),
    ];
    for _ in 0..6 {
        messages.push(assistant_msg("done"));
    }
    let usage = UsageSnapshot {
        input: usage_tokens,
        cache_read: 0,
        cache_write: 0,
        output: 100,
        total_tokens: 0,
        model: model_id(),
        timestamp: 1000,
        stop_reason: StopReason::Stop,
        error_message: None,
    };
    let response = ctrl
        .after_response(
            &mut messages,
            &usage,
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert!(response.stats.is_none() && response.pruned.is_none());
}

fn refusal_usage(ts: u64) -> UsageSnapshot {
    UsageSnapshot {
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        total_tokens: 0,
        model: model_id(),
        timestamp: ts,
        stop_reason: StopReason::Error,
        error_message: Some(evotengine::provider::error::refusal_message("refusal")),
    }
}

#[tokio::test]
async fn refusal_compacts_and_retries_then_exhausts() {
    let mut ctrl = CompactionController::new(config_small());
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("refused"));
    let original = messages.len();
    let future_ts = evotengine::context::now_ms() + 60_000;

    let first = ctrl
        .after_response(
            &mut messages,
            &refusal_usage(future_ts),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(first.action, AfterResponseAction::Retry);
    assert_eq!(
        first.reason,
        Some(evotengine::context::CompactReason::Refusal)
    );
    assert!(first.stats.is_some());
    assert!(messages.len() < original);
    // The refused response must not be resent.
    assert!(messages.iter().all(|message| !matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "refused"))
    )));

    messages.push(assistant_msg("refused again"));
    let second = ctrl
        .after_response(
            &mut messages,
            &refusal_usage(future_ts + 1),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(second.action, AfterResponseAction::Continue);
    assert!(second.overflow_exhausted);
    assert_eq!(
        second.reason,
        Some(evotengine::context::CompactReason::Refusal)
    );
}

#[tokio::test]
async fn refusal_on_single_tool_turn_summarizes_the_whole_turn() {
    let mut ctrl = CompactionController::new(config_small());
    let mut messages = vec![
        user_msg("inspect the project"),
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "call_1".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "ls"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "test".into(),
            provider: "test".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }),
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "call_1".into(),
            tool_name: "bash".into(),
            content: vec![Content::Text {
                text: "refused output".into(),
            }],
            is_error: false,
            timestamp: 0,
            retention: Default::default(),
        }),
        assistant_msg("refused"),
    ];

    let response = ctrl
        .after_response(
            &mut messages,
            &refusal_usage(evotengine::context::now_ms() + 60_000),
            &model_id(),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(response.action, AfterResponseAction::Retry);
    assert!(messages
        .iter()
        .all(|message| !matches!(message, AgentMessage::Llm(Message::ToolResult { .. }))));
}
