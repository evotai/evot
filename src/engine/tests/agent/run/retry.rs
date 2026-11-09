//! Retry behavior: bounded backoff for transient errors, quota wait states,
//! outage probes, and empty-response retries.

use evotengine::agent_loop;
use evotengine::provider::MockProvider;
use evotengine::provider::ProviderError;
use evotengine::provider::StreamConfig;
use evotengine::provider::StreamEvent;
use evotengine::provider::StreamOutcome;
use evotengine::provider::StreamProvider;
use evotengine::types::AgentContext;
use evotengine::AgentLoopConfig;
use evotengine::*;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::common::FailThenSucceedProvider;
use crate::fixtures::agent_harness::collect_events;

#[tokio::test]
async fn replay_repairs_run_after_custom_conversion_without_mutating_context() {
    use crate::fixtures::agent_harness::make_config;
    use crate::fixtures::compaction_assert::assert_no_orphan_tool_pairs;
    use crate::fixtures::recording_provider::RecordingProvider;
    use crate::fixtures::recording_provider::Reply;

    let provider = std::sync::Arc::new(RecordingProvider::new(vec![Reply::text("ok")]));
    let captured = provider.captured();
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider;
    config.retry_policy = RetryPolicy::disabled();
    config.convert_to_llm = Some(Box::new(|messages| {
        messages
            .iter()
            .filter_map(|m| match m {
                AgentMessage::Llm(Message::ToolResult { .. }) => None,
                AgentMessage::Llm(m) => Some(m.clone()),
                AgentMessage::Extension(_) => None,
            })
            .collect()
    }));
    let history = vec![
        AgentMessage::Llm(Message::user("read file")),
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "a".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "README.md"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "old-model".into(),
            provider: "test".into(),
            usage: Usage::default(),
            timestamp: 1,
            error_message: None,
            response_id: None,
        }),
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "a".into(),
            tool_name: "read".into(),
            content: vec![Content::Text {
                text: "real file contents".into(),
            }],
            is_error: false,
            timestamp: 2,
            retention: Retention::Normal,
        }),
    ];
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: history.clone(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let output = agent_loop(
        vec![Message::user("continue").into()],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let requests = captured.lock();
    assert_eq!(requests.len(), 1);
    assert!(matches!(&requests[0].messages[2], Message::ToolResult {
        tool_call_id, is_error: true, ..
    } if tool_call_id == "a"));
    let replay: Vec<AgentMessage> = requests[0]
        .messages
        .iter()
        .cloned()
        .map(AgentMessage::Llm)
        .collect();
    assert_no_orphan_tool_pairs(&replay);
    assert_eq!(&context.messages[..history.len()], history.as_slice());
    assert!(output
        .iter()
        .all(|m| !matches!(m, AgentMessage::Llm(Message::ToolResult { .. }))));
    let events = collect_events(rx);
    assert!(events
        .iter()
        .all(|event| !matches!(event, AgentEvent::ToolExecutionStart { .. })));
    assert!(events.iter().any(
        |event| matches!(event, AgentEvent::LlmCallStart { request, .. }
        if request.messages == requests[0].messages)
    ));
}

// ---------------------------------------------------------------------------
// Retry with backoff tests
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn test_retry_on_rate_limit_uses_local_backoff_and_succeeds() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 2,
            error: ProviderError::RateLimited {
                message: "Rate limited".into(),
            },
            inner: MockProvider::text("Success after retries"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(3),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("hi"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    // Should have succeeded after 2 failures + 1 success
    assert_eq!(new_messages.len(), 2); // user + assistant
    let events = collect_events(rx);
    let retry_events: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::LlmCallRetry {
                attempt,
                max_retries,
                delay_ms,
                error,
                ..
            } => Some((*attempt, *max_retries, *delay_ms, error.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(retry_events.len(), 2);
    assert_eq!(retry_events[0].0, 1);
    assert_eq!(retry_events[0].1, 3);
    assert!((1_600..=2_400).contains(&retry_events[0].2));
    assert_eq!(retry_events[0].3, "Rate limited");
    assert_eq!(retry_events[1].0, 2);
    assert_eq!(retry_events[1].1, 3);
    assert!((3_200..=4_800).contains(&retry_events[1].2));
    assert_eq!(retry_events[1].3, "Rate limited");
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::AgentEnd { .. })));

    // Verify the provider was called 3 times (2 failures + 1 success)
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        3
    );
}

#[tokio::test]
async fn test_quota_limit_waits_without_using_bounded_retry_budget() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 2,
            error: ProviderError::QuotaLimited {
                message: "Quota exceeded".into(),
            },
            inner: MockProvider::text("Success after quota reset"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::disabled(),
        before_turn: None,
        after_turn: None,
        spill: None,
    };
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    // Abort while the first quota wait is sleeping; this verifies cancellation
    // remains responsive without waiting for the production retry interval.
    let cancel = CancellationToken::new();
    let cancel_after_wait = cancel.clone();
    let events_after_wait = std::sync::Arc::new(tokio::sync::Notify::new());
    let notify = events_after_wait.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let watcher = tokio::spawn(async move {
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            let quota_wait = matches!(event, AgentEvent::QuotaWait { .. });
            events.push(event);
            if quota_wait {
                notify.notify_one();
                break;
            }
        }
        events
    });
    let cancellation = tokio::spawn(async move {
        events_after_wait.notified().await;
        cancel_after_wait.cancel();
    });

    let messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("hi"))],
        &mut context,
        &config,
        tx,
        cancel,
    )
    .await;
    let _ = cancellation.await;
    let events = watcher.await.unwrap_or_default();

    assert_eq!(messages.len(), 2);
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let quota_waits: Vec<(u64, &str)> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::QuotaWait { delay_ms, error } => Some((*delay_ms, error.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(quota_waits, vec![(5_000, "Quota limited: Quota exceeded")]);
    assert!(!events
        .iter()
        .any(|event| matches!(event, AgentEvent::LlmCallRetry { .. })));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::LlmCallStart { .. }))
            .count(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn test_quota_probes_use_local_backoff_and_recover() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 6,
            error: ProviderError::QuotaLimited {
                message: "HTTP 429: rate_limit_error: usage limit reached".into(),
            },
            inner: MockProvider::text("Success after quota probe"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::disabled(),
        before_turn: None,
        after_turn: None,
        spill: None,
    };
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("hi"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(messages.len(), 2);
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        7
    );
    let events = collect_events(rx);
    let quota_waits: Vec<u64> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::QuotaWait { delay_ms, .. } => Some(*delay_ms),
            _ => None,
        })
        .collect();
    assert_eq!(quota_waits, vec![
        5_000, 10_000, 20_000, 40_000, 60_000, 60_000
    ]);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::LlmCallStart { .. }))
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| matches!(event, AgentEvent::LlmCallRetry { .. })));
}

#[tokio::test(start_paused = true)]
async fn test_provider_declared_transient_error_retries_then_succeeds() {
    let payload = r#"{"type":"error","error":{"type":"api_error","message":"wording is not used for retry classification"}}"#;
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 1,
            error: ProviderError::Transient {
                message: payload.into(),
            },
            inner: MockProvider::text("Success after transient error"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(1),
        before_turn: None,
        after_turn: None,
        spill: None,
    };
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    let messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("hi"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(messages.len(), 2);
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    let retry_errors = collect_events(rx)
        .into_iter()
        .filter_map(|event| match event {
            AgentEvent::LlmCallRetry { error, .. } => Some(error),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(retry_errors, vec![format!("API error: {payload}")]);
}

#[tokio::test(start_paused = true)]
async fn test_retry_exhausted_enters_outage_wait_and_recovers() {
    // 5 failures: 1 initial + 2 bounded retries all fail, then the loop must
    // switch to indefinite network probing (10 s cadence) instead of failing
    // the run, and succeed once the upstream recovers on the 6th call.
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 5,
            error: ProviderError::Network("connection reset".into()),
            inner: MockProvider::text("recovered after outage"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(2),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("hi"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    // The run recovers instead of surfacing an error.
    let Some(last) = new_messages.last() else {
        panic!("Expected successful assistant message");
    };
    if let AgentMessage::Llm(Message::Assistant {
        stop_reason,
        content,
        ..
    }) = last
    {
        assert_eq!(*stop_reason, StopReason::Stop);
        assert!(matches!(
            content.first(),
            Some(Content::Text { text }) if text == "recovered after outage"
        ));
    } else {
        panic!("Expected successful assistant message");
    }

    // 1 initial + 2 bounded retries + 3 outage probes = 6 calls.
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        6
    );

    let events = collect_events(rx);
    let outage_waits: Vec<(u64, &str)> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::OutageWait { delay_ms, error } => Some((*delay_ms, error.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(outage_waits.len(), 3);
    for (delay_ms, error) in &outage_waits {
        assert_eq!(*delay_ms, 10_000);
        assert!(error.contains("connection reset"));
    }
    // Bounded retries stay bounded: exactly 2 LlmCallRetry events, and outage
    // probes stay part of the same logical call (no extra LlmCallStart).
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::LlmCallRetry { .. }))
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::LlmCallStart { .. }))
            .count(),
        3
    );
}

#[tokio::test(start_paused = true)]
async fn test_outage_wait_is_cancellable() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: usize::MAX,
            error: ProviderError::Network("gateway unavailable".into()),
            inner: MockProvider::text("never reached"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(1),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let cancel_on_wait = cancel.clone();
    let watcher = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if matches!(event, AgentEvent::OutageWait { .. }) {
                cancel_on_wait.cancel();
                return true;
            }
        }
        false
    });

    let messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("hi"))],
        &mut context,
        &config,
        tx,
        cancel,
    )
    .await;
    let saw_outage_wait = watcher.await.unwrap_or(false);

    assert!(saw_outage_wait);
    assert_eq!(messages.len(), 2);
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(matches!(
        messages.last(),
        Some(AgentMessage::Llm(Message::Assistant {
            stop_reason: StopReason::Aborted,
            ..
        }))
    ));
}

#[tokio::test(start_paused = true)]
async fn test_protocol_incomplete_retries_twice_then_fails_without_outage_wait() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: usize::MAX,
            error: ProviderError::ProtocolIncomplete(
                "Anthropic stream ended before message_stop".into(),
            ),
            inner: MockProvider::text("never reached"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(10),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    let messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("hi"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        3,
        "one initial call plus two bounded retries"
    );
    assert!(matches!(
        messages.last(),
        Some(AgentMessage::Llm(Message::Assistant {
            stop_reason: StopReason::Error,
            error_message: Some(error),
            ..
        })) if error.starts_with("Upstream response incomplete:")
    ));

    let events = collect_events(rx);
    let retries = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::LlmCallRetry {
                attempt,
                max_retries,
                error,
                ..
            } => Some((*attempt, *max_retries, error.as_str())),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(retries.len(), 2);
    assert_eq!(retries[0].0, 1);
    assert_eq!(retries[1].0, 2);
    assert!(retries.iter().all(|(_, max, _)| *max == 2));
    assert!(retries
        .iter()
        .all(|(_, _, error)| error.starts_with("Upstream response incomplete:")));
    assert!(!events
        .iter()
        .any(|event| matches!(event, AgentEvent::OutageWait { .. })));
}

#[tokio::test]
async fn test_auth_error_not_retried() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 1,
            error: ProviderError::Auth("invalid key".into()),
            inner: MockProvider::text("recovered"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(3),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("hi"));
    let (tx, _rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    // Auth error should NOT be retried — only 1 call made
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test]
async fn test_retry_none_disables_retries() {
    let provider: std::sync::Arc<FailThenSucceedProvider> =
        std::sync::Arc::new(FailThenSucceedProvider {
            fail_count: std::sync::atomic::AtomicUsize::new(0),
            max_failures: 1,
            error: ProviderError::RateLimited {
                message: "Rate limited".into(),
            },
            inner: MockProvider::text("never reached"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::disabled(), // disabled
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("hi"));
    let (tx, _rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    // Only 1 attempt — no retries
    assert_eq!(
        provider
            .fail_count
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}
// ---------------------------------------------------------------------------
// Empty response retry tests
// ---------------------------------------------------------------------------

/// A provider that returns empty Ok(Message) N times, then delegates to inner.
struct EmptyThenSucceedProvider {
    call_count: std::sync::atomic::AtomicUsize,
    empty_count: usize,
    inner: MockProvider,
}

#[async_trait::async_trait]
impl StreamProvider for EmptyThenSucceedProvider {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let attempt = self
            .call_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if attempt < self.empty_count {
            let _ = tx.send(StreamEvent::Start);
            let msg = Message::Assistant {
                content: vec![],
                stop_reason: StopReason::Stop,
                model: "mock".into(),
                provider: "mock".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Done {
                message: msg.clone(),
            });
            return Ok(StreamOutcome::complete(msg));
        }
        self.inner.stream(config, tx, cancel).await
    }
}

#[tokio::test]
async fn test_empty_response_retried_then_succeeds() {
    let provider: std::sync::Arc<EmptyThenSucceedProvider> =
        std::sync::Arc::new(EmptyThenSucceedProvider {
            call_count: std::sync::atomic::AtomicUsize::new(0),
            empty_count: 2,
            inner: MockProvider::text("Success after empty"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(3),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("hi"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    // Should succeed: 2 empty responses retried, 3rd call returns real text
    assert_eq!(new_messages.len(), 2); // user + assistant
    assert_eq!(new_messages[1].role(), "assistant");

    // Provider called 3 times: 2 empty + 1 success
    assert_eq!(
        provider
            .call_count
            .load(std::sync::atomic::Ordering::SeqCst),
        3
    );

    let events = collect_events(rx);

    // Should have LlmCallEnd events with errors for the empty attempts
    let llm_call_errors: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::LlmCallEnd {
                error: Some(err), ..
            } => Some(err.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(llm_call_errors.len(), 2);
    assert!(llm_call_errors[0].contains("Empty response"));
}

#[tokio::test(start_paused = true)]
async fn test_empty_response_exhausts_bounded_retries_then_recovers() {
    let provider: std::sync::Arc<EmptyThenSucceedProvider> =
        std::sync::Arc::new(EmptyThenSucceedProvider {
            call_count: std::sync::atomic::AtomicUsize::new(0),
            empty_count: 10, // more empties than retries
            inner: MockProvider::text("never reached"),
        });

    let config = AgentLoopConfig {
        provider: provider.clone(),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::new(2),
        before_turn: None,
        after_turn: None,
        spill: None,
    };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("hi"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    // Empty responses are transient provider failures. Once bounded retries
    // are exhausted, the loop enters cancellable outage probing and recovers
    // when the provider eventually returns content.
    let Some(AgentMessage::Llm(Message::Assistant {
        content,
        stop_reason,
        error_message,
        ..
    })) = new_messages.last()
    else {
        panic!("Expected successful assistant message");
    };
    assert_eq!(*stop_reason, StopReason::Stop);
    assert!(error_message.is_none());
    assert!(matches!(
        content.first(),
        Some(Content::Text { text }) if text == "never reached"
    ));

    // 1 initial + 2 bounded retries + 8 outage probes = 11 attempts.
    assert_eq!(
        provider
            .call_count
            .load(std::sync::atomic::Ordering::SeqCst),
        11
    );

    let events = collect_events(rx);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::LlmCallRetry { .. }))
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AgentEvent::OutageWait { .. }))
            .count(),
        8
    );
    assert!(!events
        .iter()
        .any(|event| matches!(event, AgentEvent::Error { .. })));
}
