//! Context compaction inside the agent loop: usage-driven triggers, overflow
//! recovery, budget reporting, and replayable-thinking preservation.

use evotengine::provider::mock::*;
use evotengine::provider::MockProvider;
use evotengine::provider::ProviderError;
use evotengine::provider::StreamConfig;
use evotengine::provider::StreamEvent;
use evotengine::provider::StreamOutcome;
use evotengine::provider::StreamProvider;
use evotengine::types::AgentContext;
use evotengine::*;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::fixtures::agent_harness::collect_events;
use crate::fixtures::agent_harness::make_config;
use crate::fixtures::agent_harness::MockTool;
use crate::fixtures::agent_harness::TestHarness;

// ---------------------------------------------------------------------------
// Context compaction direct-entry tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_compact_messages_reduces_over_budget_context() {
    use evotengine::context::compaction::config::CompactionConfig;
    use evotengine::context::compaction::controller::CompactionController;
    use evotengine::context::SummarizerMode;
    use tokio_util::sync::CancellationToken;

    let mut messages = Vec::new();
    for i in 0..100 {
        messages.push(AgentMessage::Llm(Message::user(format!(
            "Message {} {}",
            i,
            "x".repeat(200)
        ))));
    }

    let config = CompactionConfig {
        context_window: 2_000,
        reserve_tokens: 500,
        advertised_context_window: None,
        trigger_tokens: None,
        keep_recent_tokens: 500,
        summarizer_mode: SummarizerMode::default(),
        summary_max_bytes: 4000,
    };

    let mut ctrl = CompactionController::new(config);
    let cancel = CancellationToken::new();
    ctrl.force_compact(&mut messages, None, cancel).await;

    assert!(
        messages.len() < 100,
        "compaction should have reduced messages"
    );
    assert!(
        messages.len() >= 2,
        "compacted context should contain a summary and retained tail"
    );
}

// ---------------------------------------------------------------------------
// Context compaction event tests
// ---------------------------------------------------------------------------

// NOTE: Compaction is now triggered post-response based on usage, not pre-turn.
// These tests are adapted to the new architecture where compaction events are
// only emitted when the controller detects threshold/overflow conditions.

#[tokio::test]
async fn test_compaction_not_emitted_without_context_config() {
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("ok".into())])
        .system_prompt("")
        .run("hi")
        .await;

    assert_eq!(output.event_count("CompactionEnd"), 0);
}

#[tokio::test]
async fn test_aborted_usage_compacts_only_before_next_explicit_prompt() {
    use evotengine::context::ContextConfig;

    let provider = MockProvider::new(vec![
        MockResponse::TextWithUsageAndStop {
            text: "aborted response".into(),
            usage: Usage {
                input: 900,
                output: 10,
                total_tokens: 910,
                ..Default::default()
            },
            stop_reason: StopReason::Aborted,
        },
        // Consumed by the compaction summarizer before the second prompt.
        MockResponse::Text("summary".into()),
        MockResponse::Text("second answer".into()),
    ]);
    let mut config = make_config(provider);
    config.context_config = Some(ContextConfig {
        max_context_tokens: 1_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(125),
        trigger_tokens: None,
        keep_recent_tokens: Some(200),
    });

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: (0..20)
            .map(|index| {
                AgentMessage::Llm(Message::user(format!(
                    "history {index} {}",
                    "x".repeat(200)
                )))
            })
            .collect(),
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let (first_tx, first_rx) = mpsc::unbounded_channel();
    agent_loop(
        vec![AgentMessage::Llm(Message::user("first prompt"))],
        &mut context,
        &config,
        first_tx,
        CancellationToken::new(),
    )
    .await;
    let first_events = collect_events(first_rx);
    assert!(first_events
        .iter()
        .all(|event| !matches!(event, AgentEvent::ContextCompactionEnd { .. })));

    let (second_tx, second_rx) = mpsc::unbounded_channel();
    agent_loop(
        vec![AgentMessage::Llm(Message::user("second prompt"))],
        &mut context,
        &config,
        second_tx,
        CancellationToken::new(),
    )
    .await;
    let second_events = collect_events(second_rx);
    let compact_index = second_events
        .iter()
        .position(|event| matches!(event, AgentEvent::ContextCompactionEnd { .. }))
        .expect("aborted usage should compact before the next explicit prompt");
    let prompt_index = second_events
        .iter()
        .position(|event| matches!(
            event,
            AgentEvent::MessageStart {
                message: AgentMessage::Llm(Message::User { content, .. }),
            } if content.iter().any(|block| matches!(block, Content::Text { text } if text == "second prompt"))
        ))
        .expect("second prompt should be emitted");
    assert!(compact_index < prompt_index);
    assert!(second_events.iter().any(|event| matches!(
        event,
        AgentEvent::MessageEnd {
            message: AgentMessage::Llm(Message::Assistant { content, .. }),
        } if content.iter().any(|block| matches!(block, Content::Text { text } if text == "second answer"))
    )));
}

#[tokio::test]
async fn test_compaction_after_tool_use_waits_for_tool_results() {
    use std::collections::HashSet;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    struct ToolUseThenTextProvider {
        requests: std::sync::Arc<parking_lot::Mutex<Vec<Vec<Message>>>>,
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for ToolUseThenTextProvider {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            if cancel.is_cancelled() {
                return Err(ProviderError::Cancelled);
            }

            self.requests.lock().push(config.messages.clone());
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let _ = tx.send(StreamEvent::Start);

            let message = if call == 0 {
                let id = "tc-high-usage".to_string();
                let arguments = serde_json::json!({"path": "file.txt"});
                let _ = tx.send(StreamEvent::ToolCallStart {
                    content_index: 0,
                    id: id.clone(),
                    name: "read".into(),
                });
                let _ = tx.send(StreamEvent::ToolCallEnd {
                    content_index: 0,
                    id: id.clone(),
                    name: "read".into(),
                    arguments: arguments.clone(),
                });
                Message::Assistant {
                    content: vec![Content::ToolCall {
                        id,
                        name: "read".into(),
                        arguments,
                        metadata: None,
                    }],
                    stop_reason: StopReason::ToolUse,
                    model: "mock".into(),
                    provider: "mock".into(),
                    usage: Usage {
                        input: 980,
                        output: 20,
                        ..Default::default()
                    },
                    timestamp: evotengine::now_ms() + 60_000,
                    error_message: None,
                    response_id: None,
                }
            } else {
                let text = "done".to_string();
                let _ = tx.send(StreamEvent::TextDelta {
                    content_index: 0,
                    delta: text.clone(),
                });
                Message::Assistant {
                    content: vec![Content::Text { text }],
                    stop_reason: StopReason::Stop,
                    model: "mock".into(),
                    provider: "mock".into(),
                    usage: Usage::default(),
                    timestamp: 2,
                    error_message: None,
                    response_id: None,
                }
            };

            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let requests = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
    let provider = std::sync::Arc::new(ToolUseThenTextProvider {
        requests: requests.clone(),
        calls: AtomicUsize::new(0),
    });

    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider;
    config.context_config = Some(ContextConfig {
        max_context_tokens: 1_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(125),
        trigger_tokens: None,
        keep_recent_tokens: Some(200),
    });

    let mut prior_messages = Vec::new();
    for i in 0..20 {
        prior_messages.push(AgentMessage::Llm(Message::user(format!(
            "history {i} {}",
            "x".repeat(200)
        ))));
    }

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: prior_messages,
        tools: vec![Box::new(MockTool::ok("read", "tool output"))],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("read the file"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let events = collect_events(rx);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AgentEvent::ContextCompactionEnd { .. })),
        "expected compaction to run after the tool result was appended"
    );
    assert!(
        events.iter().all(|event| !matches!(
            event,
            AgentEvent::ContextCompactionStarted {
                will_retry: true,
                ..
            } | AgentEvent::ContextCompactionEnd {
                will_retry: true,
                ..
            }
        )),
        "run-end threshold compaction must never claim overflow retry"
    );

    let captured_requests = requests.lock().clone();
    assert!(
        captured_requests.len() >= 2,
        "expected a second LLM request after executing the tool"
    );
    let second_request = match captured_requests.get(1) {
        Some(messages) => messages,
        None => panic!("missing second LLM request"),
    };

    let mut tool_call_ids = HashSet::new();
    let mut tool_result_ids = HashSet::new();
    for message in second_request {
        match message {
            Message::Assistant { content, .. } => {
                for content in content {
                    if let Content::ToolCall { id, .. } = content {
                        tool_call_ids.insert(id.clone());
                    }
                }
            }
            Message::ToolResult { tool_call_id, .. } => {
                tool_result_ids.insert(tool_call_id.clone());
            }
            _ => {}
        }
    }

    assert!(
        tool_result_ids.is_subset(&tool_call_ids),
        "second request contains orphan tool results: calls={tool_call_ids:?}, results={tool_result_ids:?}"
    );
}

#[tokio::test]
async fn test_non_overflow_error_compacts_from_usage_anchor() {
    use evotengine::context::ContextConfig;

    // Provider whose agent call fails with a non-overflow "overloaded" error
    // carrying zero usage. The error response has no usable token counts, so the
    // post-response path must fall back to the local estimate and compact.
    //
    // Summarizer calls (identified by the summarization system prompt) succeed,
    // so the estimate-driven compaction can actually run.
    struct OverloadedProvider;

    #[async_trait::async_trait]
    impl StreamProvider for OverloadedProvider {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            if cancel.is_cancelled() {
                return Err(ProviderError::Cancelled);
            }
            let _ = tx.send(StreamEvent::Start);

            // Summarizer calls succeed so compaction can complete.
            if config
                .system_prompt
                .starts_with("You are a context summarization")
            {
                let message = Message::Assistant {
                    content: vec![Content::Text {
                        text: "summary".into(),
                    }],
                    stop_reason: StopReason::Stop,
                    model: "mock".into(),
                    provider: "mock".into(),
                    usage: Usage::default(),
                    timestamp: 3,
                    error_message: None,
                    response_id: None,
                };
                let _ = tx.send(StreamEvent::Done {
                    message: message.clone(),
                });
                return Ok(StreamOutcome::complete(message));
            }

            // Agent call: non-overflow error with zero usage.
            let message = Message::Assistant {
                content: vec![Content::Text {
                    // The terminal error body pushes the post-response local
                    // estimate over the threshold despite carrying zero usage.
                    text: "x".repeat(1_500),
                }],
                stop_reason: StopReason::Error,
                model: "mock".into(),
                provider: "mock".into(),
                usage: Usage::default(),
                timestamp: 1,
                error_message: Some(
                    "API error: Our servers are currently overloaded. Please try again later."
                        .into(),
                ),
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Error {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let mut config = make_config(MockProvider::text("unused"));
    config.provider = std::sync::Arc::new(OverloadedProvider);
    // Disable retry so the overloaded error reaches the compaction path as a
    // terminal error response (isolates the estimate fallback under test).
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 1_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(125),
        trigger_tokens: None,
        keep_recent_tokens: Some(200),
    });

    // The previous successful response is the real usage anchor. It remains
    // below the threshold at prompt time; the new prompt and terminal error are
    // estimated as trailing messages and push the final context over budget.
    let usage_anchor = AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: "previous answer".into(),
        }],
        stop_reason: StopReason::Stop,
        model: "mock".into(),
        provider: "mock".into(),
        usage: Usage {
            input: 700,
            total_tokens: 700,
            ..Default::default()
        },
        timestamp: evotengine::now_ms() + 60_000,
        error_message: None,
        response_id: None,
    });
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: vec![
            AgentMessage::Llm(Message::user("x".repeat(500))),
            AgentMessage::Llm(Message::user("x".repeat(500))),
            AgentMessage::Llm(Message::user("x".repeat(500))),
            AgentMessage::Llm(Message::user("x".repeat(500))),
            usage_anchor,
        ],
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user(format!(
        "trigger overload {}",
        "x".repeat(1_000)
    )));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let events = collect_events(rx);

    // The previous assistant remains below threshold at prompt time; this
    // compaction comes from the final error plus its anchored trailing estimate.
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::Error { .. })),
        "expected an error event"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ContextCompactionEnd { .. })),
        "expected estimate-based compaction to run after a non-overflow error"
    );
}

#[tokio::test]
async fn test_overflow_retry_removes_failed_response_from_active_context() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    struct LengthOverflowThenSuccess {
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for LengthOverflowThenSuccess {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            let is_summary = config
                .system_prompt
                .starts_with("You are a context summarization");
            let call = if is_summary {
                None
            } else {
                Some(self.calls.fetch_add(1, Ordering::SeqCst))
            };
            let text = match call {
                None => "compacted history",
                Some(0) => "abandoned partial",
                Some(_) => "recovered answer",
            };
            let _ = tx.send(StreamEvent::Start);
            let _ = tx.send(StreamEvent::TextDelta {
                content_index: 0,
                delta: text.into(),
            });
            let message = Message::Assistant {
                content: vec![Content::Text { text: text.into() }],
                stop_reason: if call == Some(0) {
                    StopReason::Length
                } else {
                    StopReason::Stop
                },
                model: "mock".into(),
                provider: "mock".into(),
                usage: if call == Some(0) {
                    Usage {
                        input: 1_100,
                        output: 0,
                        total_tokens: 1_100,
                        ..Default::default()
                    }
                } else {
                    Usage {
                        input: 500,
                        output: 20,
                        total_tokens: 520,
                        ..Default::default()
                    }
                },
                timestamp: evotengine::now_ms() + 60_000,
                error_message: if call == Some(0) {
                    Some("response incomplete: max_output_tokens".into())
                } else {
                    None
                },
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let provider = std::sync::Arc::new(LengthOverflowThenSuccess {
        calls: AtomicUsize::new(0),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 1_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(125),
        trigger_tokens: None,
        keep_recent_tokens: Some(200),
    });

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: (0..10)
            .map(|i| AgentMessage::Llm(Message::user(format!("history {i} {}", "x".repeat(100)))))
            .collect(),
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let prompt = AgentMessage::Llm(Message::user("continue"));
    let (tx, rx) = mpsc::unbounded_channel();

    let new_messages = agent_loop(
        vec![prompt],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::ContextCompactionEnd {
            will_retry: true,
            ..
        })));
    let completed_assistant_texts: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageEnd {
                message: AgentMessage::Llm(Message::Assistant { content, .. }),
            } => Some(
                content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>(),
            ),
            _ => None,
        })
        .collect();
    assert_eq!(completed_assistant_texts, vec![
        "abandoned partial",
        "recovered answer"
    ]);
    assert!(new_messages.iter().all(|message| !matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "abandoned partial"))
    )));
    assert!(context.messages.iter().all(|message| !matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "abandoned partial"))
    )));
}

#[tokio::test]
async fn test_model_switch_sends_first_request_without_precompaction() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;
    use evotengine::provider::ModelConfig;

    struct ModelSwitchProvider {
        calls: AtomicUsize,
        main_budgets: parking_lot::Mutex<Vec<u32>>,
    }

    #[async_trait::async_trait]
    impl StreamProvider for ModelSwitchProvider {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let is_summary = config
                .system_prompt
                .starts_with("You are a context summarization");
            if !is_summary {
                self.main_budgets.lock().push(config.resolved_max_tokens());
            }
            let text = if is_summary {
                "compacted history"
            } else {
                "answer after model switch"
            };
            let message = Message::Assistant {
                content: vec![Content::Text { text: text.into() }],
                stop_reason: StopReason::Stop,
                model: config.model,
                provider: "local".into(),
                usage: Usage::default(),
                timestamp: 1,
                error_message: None,
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Start);
            let _ = tx.send(StreamEvent::TextDelta {
                content_index: 0,
                delta: text.into(),
            });
            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let provider = std::sync::Arc::new(ModelSwitchProvider {
        calls: AtomicUsize::new(0),
        main_budgets: parking_lot::Mutex::new(Vec::new()),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.model = "new-model".into();
    let model_config = ModelConfig::resolve(evotengine::provider::ResolveModelRequest {
        protocol: evotengine::provider::ApiProtocol::OpenAiCompletions,
        provider: "local".into(),
        model_id: "new-model".into(),
        base_url: String::new(),
        headers: Default::default(),
        compat: Some(evotengine::provider::OpenAiCompat::default()),
        route_capabilities: Default::default(),
        overrides: evotengine::provider::ModelOverrides {
            context_window: Some(10_000),
            max_output_tokens: Some(500),
            ..Default::default()
        },
    });
    config.model_config = Some(model_config);
    config.context_config = Some(ContextConfig {
        max_context_tokens: 10_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(1250),
        trigger_tokens: None,
        keep_recent_tokens: Some(2000),
    });

    let old_assistant = AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: "old answer ".repeat(100),
        }],
        stop_reason: StopReason::Stop,
        model: "old-model".into(),
        provider: "local".into(),
        usage: Usage {
            // Deliberately above the new model's 8,750-token threshold. This
            // belongs to old-model and must not trigger pre-prompt compaction;
            // the history's own local estimate (~3.3k tokens) stays below it.
            input: 9_000,
            output: 100,
            total_tokens: 9_100,
            ..Default::default()
        },
        timestamp: 1,
        error_message: None,
        response_id: None,
    });
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: vec![
            AgentMessage::Llm(Message::user("pinned")),
            AgentMessage::Llm(Message::user("x".repeat(1_000))),
            AgentMessage::Llm(Message::user("recent ".repeat(1_700))),
            old_assistant,
        ],
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    agent_loop(
        vec![AgentMessage::Llm(Message::user("next prompt"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert!(events
        .iter()
        .all(|event| !matches!(event, AgentEvent::ContextCompactionEnd { .. })));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    // The input limit drives compaction while the independent output limit is
    // preserved at the provider boundary. The request is sent before compaction.
    assert_eq!(provider.main_budgets.lock().as_slice(), &[500]);
}

#[tokio::test]
async fn test_sanitized_413_compacts_and_retries_once() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    struct RequestTooLargeThenSuccess {
        calls: AtomicUsize,
        request_chars: parking_lot::Mutex<Vec<usize>>,
    }

    #[async_trait::async_trait]
    impl StreamProvider for RequestTooLargeThenSuccess {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            let is_summary = config
                .system_prompt
                .starts_with("You are a context summarization");
            let call = if is_summary {
                None
            } else {
                Some(self.calls.fetch_add(1, Ordering::SeqCst))
            };
            let chars = config
                .messages
                .iter()
                .map(|message| match message {
                    Message::User { content, .. }
                    | Message::Assistant { content, .. }
                    | Message::ToolResult { content, .. } => content
                        .iter()
                        .map(|block| match block {
                            Content::Text { text } => text.len(),
                            _ => 0,
                        })
                        .sum::<usize>(),
                })
                .sum();
            if call.is_some() {
                self.request_chars.lock().push(chars);
            }

            if call == Some(0) {
                return Err(ProviderError::classify(
                    413,
                    r#"HTTP 413: {"type":"error","error":{"type":"api_error","message":"Upstream request failed."}}"#,
                ));
            }

            let text = if is_summary {
                "compacted history"
            } else {
                "recovered after compaction"
            };
            let message = Message::Assistant {
                content: vec![Content::Text { text: text.into() }],
                stop_reason: StopReason::Stop,
                model: config.model,
                provider: "openai".into(),
                usage: Usage::default(),
                timestamp: evotengine::now_ms() + 60_000,
                error_message: None,
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Start);
            let _ = tx.send(StreamEvent::TextDelta {
                content_index: 0,
                delta: text.into(),
            });
            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let provider = std::sync::Arc::new(RequestTooLargeThenSuccess {
        calls: AtomicUsize::new(0),
        request_chars: parking_lot::Mutex::new(Vec::new()),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 2_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(250),
        trigger_tokens: None,
        keep_recent_tokens: Some(300),
    });

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: (0..12)
            .map(|index| {
                AgentMessage::Llm(Message::user(format!(
                    "old history {index} {}",
                    "x".repeat(1_000)
                )))
            })
            .collect(),
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    let new_messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("continue"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let request_chars = provider.request_chars.lock();
    assert_eq!(request_chars.len(), 2);
    assert!(
        request_chars[1] < request_chars[0],
        "retry payload should shrink after compaction: {request_chars:?}"
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::ContextCompactionEnd {
            reason: evotengine::context::CompactReason::Overflow,
            will_retry: true,
            ..
        })));
    assert!(events
        .iter()
        .all(|event| !matches!(event, AgentEvent::LlmCallRetry { .. })));
    assert!(new_messages.iter().any(|message| matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "recovered after compaction"))
    )));
}

#[tokio::test]
async fn test_overflow_recovery_survives_summarizer_failure() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    // The relay rejects oversized payloads by bytes. Both the main request and
    // the LLM summarize request hit the same limit; only the compacted retry
    // fits. Mirrors the claude-fable-5@droid 11MB incident.
    struct RejectsMainAndSummarizer {
        main_calls: AtomicUsize,
        summary_calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for RejectsMainAndSummarizer {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            let is_summary = config
                .system_prompt
                .starts_with("You are a context summarization");
            if is_summary {
                self.summary_calls.fetch_add(1, Ordering::SeqCst);
                return Err(ProviderError::classify(
                    413,
                    r#"HTTP 413: {"type":"error","error":{"type":"api_error","message":"Upstream request failed."}}"#,
                ));
            }
            let call = self.main_calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                return Err(ProviderError::classify(
                    413,
                    r#"HTTP 413: {"type":"error","error":{"type":"api_error","message":"Upstream request failed."}}"#,
                ));
            }

            let message = Message::Assistant {
                content: vec![Content::Text {
                    text: "recovered after emergency compaction".into(),
                }],
                stop_reason: StopReason::Stop,
                model: config.model,
                provider: "openai".into(),
                usage: Usage::default(),
                timestamp: evotengine::now_ms() + 60_000,
                error_message: None,
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Start);
            let _ = tx.send(StreamEvent::TextDelta {
                content_index: 0,
                delta: "recovered after emergency compaction".into(),
            });
            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let provider = std::sync::Arc::new(RejectsMainAndSummarizer {
        main_calls: AtomicUsize::new(0),
        summary_calls: AtomicUsize::new(0),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 2_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(250),
        trigger_tokens: None,
        keep_recent_tokens: Some(300),
    });

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: (0..12)
            .map(|index| {
                AgentMessage::Llm(Message::user(format!(
                    "old history {index} {}",
                    "x".repeat(1_000)
                )))
            })
            .collect(),
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    let new_messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("continue"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert_eq!(provider.main_calls.load(Ordering::SeqCst), 2);
    assert!(
        provider.summary_calls.load(Ordering::SeqCst) >= 1,
        "the LLM summarizer must be attempted before the emergency fallback"
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::ContextCompactionEnd {
            reason: evotengine::context::CompactReason::Overflow,
            will_retry: true,
            ..
        })));
    assert!(events.iter().all(|event| !matches!(
        event,
        AgentEvent::Error { error } if error.message.contains("recovery failed")
    )));
    assert!(new_messages.iter().any(|message| matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "recovered after emergency compaction"))
    )));
}

#[tokio::test]
async fn test_unrecoverable_overflow_surfaces_visible_error() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    struct AlwaysRequestTooLarge {
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for AlwaysRequestTooLarge {
        async fn stream(
            &self,
            _config: StreamConfig,
            _tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::classify(
                413,
                r#"HTTP 413: {"type":"error","error":{"type":"api_error","message":"Upstream request failed."}}"#,
            ))
        }
    }

    let provider = std::sync::Arc::new(AlwaysRequestTooLarge {
        calls: AtomicUsize::new(0),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 2_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(250),
        trigger_tokens: None,
        keep_recent_tokens: Some(300),
    });

    // A single oversized message leaves the planner nothing to evict, so
    // recovery cannot compact. The failure must be user-visible.
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: vec![AgentMessage::Llm(Message::user("x".repeat(4_000)))],
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    agent_loop(
        vec![AgentMessage::Llm(Message::user("continue"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(events
        .iter()
        .all(|event| !matches!(event, AgentEvent::ContextCompactionEnd { .. })));
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::Error { error }
                if error.message.contains("Context overflow recovery failed: could not compact")
        )),
        "a failed overflow recovery must not end the run silently"
    );
}

/// A context that cannot be compacted below the window is still sent: the
/// provider is the authority on whether it fits, and an overflow response is
/// recovered by the post-response compact-and-retry path. Mirrors pi, which
/// checks compaction once before a prompt and never refuses locally.
#[tokio::test]
async fn test_uncompactable_context_is_still_sent_to_the_provider() {
    use evotengine::context::ContextConfig;

    // Local estimate: prior user = 3956/4 + 4 = 993, current user =
    // 8/4 + 4 = 6, system prompt = 4/4 = 1, totaling exactly 1000.
    // The request must still proceed even if best-effort compaction cannot make
    // the provider accept it.
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("sent anyway".into())])
        .prior_messages(vec![AgentMessage::Llm(Message::user("x".repeat(3_956)))])
        .context_config(ContextConfig {
            max_context_tokens: 1_000,
            system_prompt_tokens: 0,
            advertised_context_window: None,
            reserve_tokens: Some(125),
            trigger_tokens: None,
            keep_recent_tokens: Some(200),
        })
        .run("continue")
        .await;

    assert!(output
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::LlmCallStart { .. })));
    assert!(output.events.iter().all(|event| !matches!(
        event,
        AgentEvent::Error { error } if error.message.contains("request was not sent")
    )));
    assert!(output.messages.iter().any(|message| matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "sent anyway"))
    )));
}

/// A large-window model must not compact just because its history is a large
/// absolute number. With a fixed 16k reserve, a 272k-window model still has ~256k
/// of headroom, so a 120k context is nowhere near the threshold. The previous
/// window/8 reserve plus window/5 retention made big-window models compact far
/// too eagerly and then fail to shrink below the window.
#[tokio::test]
async fn test_large_window_model_does_not_compact_mid_window() {
    use evotengine::context::ContextConfig;

    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("answer".into())])
        .prior_messages(vec![
            AgentMessage::Llm(Message::user("history")),
            AgentMessage::Llm(Message::Assistant {
                content: vec![Content::Text {
                    text: "prior answer".into(),
                }],
                stop_reason: StopReason::Stop,
                model: "test-model".into(),
                provider: "test".into(),
                usage: Usage {
                    input: 120_000,
                    output: 2_000,
                    total_tokens: 122_000,
                    ..Default::default()
                },
                timestamp: 1,
                error_message: None,
                response_id: None,
            }),
        ])
        .context_config(ContextConfig::from_context_window(272_000))
        .run("next")
        .await;

    assert!(
        output
            .events
            .iter()
            .all(|event| !matches!(event, AgentEvent::ContextCompactionEnd { .. })),
        "a 122k context in a 272k window is well under the threshold"
    );
    assert!(output
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::LlmCallStart { .. })));
}

/// Gateway accounting faults (a whole run's prompt tokens summed into the last
/// response) report a context far above the window while the real history is
/// tiny. That usage must not read as a silent overflow: no compaction, no
/// overflow error, the prompt goes out against the actual history.
#[tokio::test]
async fn test_implausible_usage_does_not_trigger_overflow_compaction() {
    use evotengine::context::ContextConfig;

    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("answer".into())])
        .prior_messages(vec![
            AgentMessage::Llm(Message::user("history ".repeat(4_000))),
            AgentMessage::Llm(Message::Assistant {
                content: vec![Content::Text {
                    text: "prior answer".into(),
                }],
                stop_reason: StopReason::Stop,
                model: "test-model".into(),
                provider: "test".into(),
                usage: Usage {
                    input: 305_000,
                    output: 9_000,
                    cache_read: 4_900_000,
                    total_tokens: 5_214_000,
                    ..Default::default()
                },
                timestamp: 1,
                error_message: None,
                response_id: None,
            }),
        ])
        .context_config(ContextConfig::from_context_window(1_000_000))
        .run("next")
        .await;

    assert!(
        output
            .events
            .iter()
            .all(|event| !matches!(event, AgentEvent::ContextCompactionEnd { .. })),
        "5.2M reported on an ~8k history must not compact"
    );
    assert!(
        output
            .events
            .iter()
            .all(|event| !matches!(event, AgentEvent::Error { .. })),
        "implausible usage is not an overflow"
    );
    assert!(output
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::LlmCallStart { .. })));
}

/// A summarizer that cannot produce a summary must not strand the run: the
/// main request still goes out. Compaction is best-effort, not a gate.
#[tokio::test]
async fn test_failed_summarizer_still_sends_the_main_request() {
    use evotengine::context::ContextConfig;

    struct FailingSummarizerProvider {
        main_calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for FailingSummarizerProvider {
        async fn stream(
            &self,
            config: StreamConfig,
            _tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            if config
                .system_prompt
                .starts_with("You are a context summarization")
            {
                return Err(ProviderError::Api("summary endpoint failed".into()));
            }
            self.main_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(ProviderError::Api("main request ran".into()))
        }
    }

    let provider = std::sync::Arc::new(FailingSummarizerProvider {
        main_calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 1_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(125),
        trigger_tokens: None,
        keep_recent_tokens: Some(200),
    });
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: vec![
            AgentMessage::Llm(Message::user("pinned")),
            AgentMessage::Llm(Message::user("x".repeat(8_000))),
            AgentMessage::Llm(Message::user("recent ".repeat(200))),
        ],
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    agent_loop(
        vec![AgentMessage::Llm(Message::user("next prompt"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert!(
        provider
            .main_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            >= 1,
        "a failed summary must not prevent the main request"
    );
    assert!(events.iter().all(|event| !matches!(
        event,
        AgentEvent::Error { error }
            if error.message.contains("request was not sent")
    )));
}

#[tokio::test]
async fn test_no_usage_anchor_compacts_from_local_estimate() {
    use evotengine::context::ContextConfig;

    // No assistant in the history carries usage (e.g. a gateway that never
    // reports usage on tool_use responses). pi's `estimateContextTokens` then
    // sizes the whole history locally; over the threshold that must compact
    // before the prompt is sent instead of growing past the window forever.
    let output = TestHarness::new()
        .responses(vec![
            // Consumed by the compaction summarizer before the prompt.
            MockResponse::Text("summary".into()),
            MockResponse::Text("provider accepted request".into()),
        ])
        .prior_messages(
            (0..10)
                .flat_map(|index| {
                    [
                        AgentMessage::Llm(Message::user(format!(
                            "history {index} {}",
                            "x".repeat(400)
                        ))),
                        assistant_msg_for_test("tool-use answer without usage"),
                    ]
                })
                .collect(),
        )
        .context_config(ContextConfig {
            max_context_tokens: 1_100,
            system_prompt_tokens: 0,
            advertised_context_window: None,
            reserve_tokens: Some(137),
            trigger_tokens: None,
            keep_recent_tokens: Some(220),
        })
        .run("continue")
        .await;

    let compact_index = output
        .events
        .iter()
        .position(|event| matches!(event, AgentEvent::ContextCompactionEnd { .. }))
        .expect("zero-usage history over the threshold must compact from the local estimate");
    let call_index = output
        .events
        .iter()
        .position(|event| matches!(event, AgentEvent::LlmCallStart { .. }))
        .expect("the prompt must still be sent");
    assert!(
        compact_index < call_index,
        "compaction must precede the request"
    );
    assert!(output.messages.iter().any(|message| matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "provider accepted request"))
    )));
}

#[tokio::test]
async fn test_no_usage_anchor_below_threshold_does_not_compact() {
    use evotengine::context::ContextConfig;

    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("provider accepted request".into())])
        .prior_messages(vec![
            AgentMessage::Llm(Message::user("x".repeat(400))),
            assistant_msg_for_test("pinned assistant"),
        ])
        .context_config(ContextConfig {
            max_context_tokens: 1_100,
            system_prompt_tokens: 0,
            advertised_context_window: None,
            reserve_tokens: Some(137),
            trigger_tokens: None,
            keep_recent_tokens: Some(220),
        })
        .run("continue")
        .await;

    assert!(output
        .events
        .iter()
        .all(|event| !matches!(event, AgentEvent::ContextCompactionEnd { .. })));
    assert!(output
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::LlmCallStart { .. })));
}

#[tokio::test]
async fn test_tool_heavy_run_compacts_between_tool_turns() {
    use evotengine::context::ContextConfig;

    // A single run issuing tool call after tool call, each result ~500 tokens,
    // against a 1,100-token window whose provider reports its token count
    // like a real one and never rejects a request. The run must compact as
    // soon as the context reaches the threshold, and again once it has grown
    // back to it, instead of waiting for run end or a provider overflow.
    //
    // The provider answers a few milliseconds late so every response carries
    // a timestamp after the compaction that preceded it; stale usage is
    // ignored by design and would otherwise hide the second compaction.
    struct LateMock(MockProvider);

    #[async_trait::async_trait]
    impl StreamProvider for LateMock {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            tokio::time::sleep(std::time::Duration::from_millis(3)).await;
            self.0.stream(config, tx, cancel).await
        }
    }

    // Distinct arguments keep the doom-loop detector out of the picture; the
    // usage is what the provider saw as input for that call.
    let call = |tool: &str, n: usize, input: u64| MockResponse::ToolCallsWithUsage {
        calls: vec![MockToolCall {
            name: tool.into(),
            arguments: serde_json::json!({ "n": n }),
        }],
        usage: Usage {
            input,
            output: 10,
            ..Default::default()
        },
    };
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = std::sync::Arc::new(LateMock(MockProvider::new(vec![
        call("dump", 1, 40),
        call("dump", 2, 560),
        // Consumed by the summarizer after the second tool result.
        MockResponse::Text("summary".into()),
        // A small step right after the compaction: its usage shows the
        // context back under the line, which re-arms threshold compaction.
        call("peek", 3, 600),
        // The provider counts more tokens than the byte heuristic does, so by
        // the time the local estimate reaches the line its usage is already
        // past it. That must still compact rather than being refused as a
        // repeat of the previous compaction.
        call("dump", 4, 1_000),
        MockResponse::Text("summary 2".into()),
        MockResponse::Text("all done".into()),
    ])));
    config.context_config = Some(ContextConfig {
        max_context_tokens: 1_100,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(137),
        trigger_tokens: None,
        keep_recent_tokens: Some(220),
    });
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![
            Box::new(MockTool::ok("dump", &"x".repeat(2_000))),
            Box::new(MockTool::ok("peek", "ok")),
        ],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();
    agent_loop(
        vec![AgentMessage::Llm(Message::user("dump everything"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    let compaction_ends: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event, AgentEvent::ContextCompactionEnd { .. }))
        .map(|(index, _)| index)
        .collect();
    assert_eq!(
        compaction_ends.len(),
        2,
        "a second threshold compaction must follow once usage recovered"
    );
    let final_text_index = events
        .iter()
        .position(|event| matches!(
            event,
            AgentEvent::MessageEnd { message: AgentMessage::Llm(Message::Assistant { content, .. }) }
                if content.iter().any(|block| matches!(block, Content::Text { text } if text == "all done"))
        ))
        .expect("the run must still finish");
    assert!(
        compaction_ends
            .iter()
            .all(|&index| index < final_text_index),
        "compaction must happen before the run ends, not at run end"
    );
    // Threshold compaction mid-run keeps the fresh tool results and never
    // claims an overflow retry.
    assert!(events.iter().all(
        |event| !matches!(event, AgentEvent::ContextCompactionStarted {
            will_retry: true,
            ..
        })
    ));
    let tool_results = events
        .iter()
        .filter(|event| matches!(event, AgentEvent::ToolExecutionEnd { .. }))
        .count();
    assert_eq!(
        tool_results, 4,
        "every tool call still executes exactly once"
    );
    assert!(events
        .iter()
        .all(|event| !matches!(event, AgentEvent::Error { .. })));
}

fn assistant_msg_for_test(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text { text: text.into() }],
        stop_reason: StopReason::Stop,
        model: "mock".into(),
        provider: "mock".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

#[tokio::test]
async fn test_llm_call_start_carries_budget_and_window() {
    use evotengine::context::ContextConfig;

    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("ok".into())])
        .system_prompt("sys")
        .context_config(ContextConfig {
            max_context_tokens: 100_000,
            system_prompt_tokens: 10_000,
            advertised_context_window: None,
            reserve_tokens: Some(12500),
            trigger_tokens: None,
            keep_recent_tokens: Some(20000),
        })
        .retry_policy(evotengine::RetryPolicy::disabled())
        .run("hi")
        .await;

    let starts: Vec<_> = output
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::LlmCallStart { budget, .. } => Some((
                budget.system_prompt_tokens,
                budget.budget_tokens,
                budget.context_window,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0], (10_000, 90_000, 100_000));
}

#[tokio::test]
async fn test_same_model_preserves_replayable_tool_use_thinking() {
    use evotengine::provider::ModelConfig;

    let model_config = ModelConfig::anthropic("deepseek-reasoner", "deepseek-reasoner");
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("ok".into())])
        .model_config(model_config)
        .prior_messages(vec![
            AgentMessage::Llm(Message::user("do something")),
            AgentMessage::Llm(Message::Assistant {
                content: vec![
                    Content::Thinking {
                        thinking: "old tool thinking".into(),
                        metadata: Some(ThinkingMetadata::Anthropic {
                            signature: "old-sig".into(),
                        }),
                    },
                    Content::ToolCall {
                        id: "tc-old".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "pwd"}),
                        metadata: None,
                    },
                ],
                stop_reason: StopReason::ToolUse,
                model: "deepseek-reasoner".into(),
                provider: "anthropic".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            }),
            AgentMessage::Llm(Message::ToolResult {
                tool_call_id: "tc-old".into(),
                tool_name: "bash".into(),
                content: vec![Content::Text {
                    text: "old result".into(),
                }],
                is_error: false,
                timestamp: 0,
                retention: Retention::Normal,
            }),
            AgentMessage::Llm(Message::Assistant {
                content: vec![
                    Content::Thinking {
                        thinking: "new tool thinking".into(),
                        metadata: Some(ThinkingMetadata::Anthropic {
                            signature: "new-sig".into(),
                        }),
                    },
                    Content::ToolCall {
                        id: "tc-new".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "date"}),
                        metadata: None,
                    },
                ],
                stop_reason: StopReason::ToolUse,
                model: "deepseek-reasoner".into(),
                provider: "anthropic".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            }),
            AgentMessage::Llm(Message::ToolResult {
                tool_call_id: "tc-new".into(),
                tool_name: "bash".into(),
                content: vec![Content::Text {
                    text: "new result".into(),
                }],
                is_error: false,
                timestamp: 0,
                retention: Retention::Normal,
            }),
        ])
        .run_continue()
        .await;

    let request_messages = output
        .events
        .iter()
        .find_map(|event| match event {
            AgentEvent::LlmCallStart { request, .. } => Some(&request.messages),
            _ => None,
        })
        .expect("expected LlmCallStart");
    for expected in ["old tool thinking", "new tool thinking"] {
        assert!(request_messages.iter().any(|message| matches!(
            message,
            Message::Assistant { content, .. }
                if content.iter().any(|content| matches!(
                    content,
                    Content::Thinking { thinking, .. } if thinking == expected
                ))
        )));
    }
}

#[tokio::test]
async fn test_llm_call_start_zero_budget_without_context_config() {
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("ok".into())])
        .system_prompt("")
        .run("hi")
        .await;

    let starts: Vec<_> = output
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::LlmCallStart { budget, .. } => {
                Some((budget.budget_tokens, budget.context_window))
            }
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0], (0, 0));
}

#[tokio::test]
async fn test_llm_call_stats_image_tokens_separate_from_user() {
    use evotengine::context::compute_call_stats;
    use evotengine::types::Content;
    use evotengine::types::Message;

    let messages = vec![
        Message::User {
            provenance: None,
            content: vec![
                Content::Text {
                    text: "describe this image".into(),
                },
                Content::Image {
                    mime_type: "image/png".into(),
                    source: evotengine::ImageSource::Base64 {
                        data: "A".repeat(3000),
                    },
                },
            ],
            timestamp: 0,
        },
        Message::Assistant {
            content: vec![Content::Text {
                text: "It shows a cat.".into(),
            }],
            stop_reason: evotengine::types::StopReason::Stop,
            model: "test".into(),
            provider: "test".into(),
            usage: evotengine::types::Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        },
    ];

    let stats = compute_call_stats(&messages);

    // user_tokens should NOT include image tokens
    assert!(stats.user_tokens > 0);
    assert!(stats.image_tokens > 0);
    assert_eq!(stats.image_count, 1);
    assert_eq!(stats.user_count, 1);
    assert_eq!(stats.assistant_count, 1);
    // image tokens are separate — total = user + assistant + image
    let total = stats.user_tokens + stats.assistant_tokens + stats.image_tokens;
    assert!(total > stats.user_tokens + stats.assistant_tokens);
}

#[tokio::test]
async fn test_llm_call_stats_no_images() {
    use evotengine::context::compute_call_stats;
    use evotengine::types::Content;
    use evotengine::types::Message;

    let messages = vec![Message::User {
        provenance: None,
        content: vec![Content::Text {
            text: "hello".into(),
        }],
        timestamp: 0,
    }];

    let stats = compute_call_stats(&messages);
    assert_eq!(stats.image_count, 0);
    assert_eq!(stats.image_tokens, 0);
    assert_eq!(stats.user_count, 1);
    assert!(stats.user_tokens > 0);
}

/// A safety refusal caused by content already in the context compacts it and
/// retries once, so the user does not have to run `/compact` by hand.
#[tokio::test]
async fn test_refusal_compacts_and_retries_once() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    struct RefusesOnce {
        main_calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for RefusesOnce {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            let is_summary = config
                .system_prompt
                .starts_with("You are a context summarization");
            let call = if is_summary {
                None
            } else {
                Some(self.main_calls.fetch_add(1, Ordering::SeqCst))
            };
            let refused = call == Some(0);
            let text = match call {
                None => "compacted history",
                Some(0) => "",
                Some(_) => "recovered after refusal",
            };
            let message = Message::Assistant {
                content: vec![Content::Text { text: text.into() }],
                stop_reason: if refused {
                    StopReason::Error
                } else {
                    StopReason::Stop
                },
                model: config.model,
                provider: "mock".into(),
                usage: Usage::default(),
                timestamp: evotengine::now_ms() + 60_000,
                error_message: refused
                    .then(|| evotengine::provider::error::refusal_message("refusal")),
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Start);
            if !text.is_empty() {
                let _ = tx.send(StreamEvent::TextDelta {
                    content_index: 0,
                    delta: text.into(),
                });
            }
            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let provider = std::sync::Arc::new(RefusesOnce {
        main_calls: AtomicUsize::new(0),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 100_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(1_000),
        trigger_tokens: None,
        keep_recent_tokens: Some(300),
    });

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: (0..12)
            .map(|index| {
                AgentMessage::Llm(Message::user(format!(
                    "old history {index} {}",
                    "x".repeat(1_000)
                )))
            })
            .collect(),
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    let new_messages = agent_loop(
        vec![AgentMessage::Llm(Message::user("continue"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert_eq!(provider.main_calls.load(Ordering::SeqCst), 2);
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::ContextCompactionEnd {
            reason: evotengine::context::CompactReason::Refusal,
            will_retry: true,
            ..
        })));
    assert!(new_messages.iter().any(|message| matches!(
        message,
        AgentMessage::Llm(Message::Assistant { content, .. })
            if content.iter().any(|block| matches!(block, Content::Text { text } if text == "recovered after refusal"))
    )));
}

/// A refusal that recurs after the one compact-and-retry ends the run with a
/// visible error instead of looping.
#[tokio::test]
async fn test_repeated_refusal_stops_after_one_retry() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use evotengine::context::ContextConfig;

    struct AlwaysRefuses {
        main_calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl StreamProvider for AlwaysRefuses {
        async fn stream(
            &self,
            config: StreamConfig,
            tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Result<StreamOutcome, ProviderError> {
            if !config
                .system_prompt
                .starts_with("You are a context summarization")
            {
                self.main_calls.fetch_add(1, Ordering::SeqCst);
            }
            // Refuse the summarizer too: recovery must fall back to the
            // deterministic summary rather than give up. The timestamp is in
            // the future so the second refusal is never read as stale usage
            // from before the compaction.
            let message = Message::Assistant {
                content: vec![Content::Text {
                    text: String::new(),
                }],
                stop_reason: StopReason::Error,
                model: config.model,
                provider: "mock".into(),
                usage: Usage::default(),
                timestamp: evotengine::now_ms() + 60_000,
                error_message: Some(evotengine::provider::error::refusal_message("refusal")),
                response_id: None,
            };
            let _ = tx.send(StreamEvent::Start);
            let _ = tx.send(StreamEvent::Done {
                message: message.clone(),
            });
            Ok(StreamOutcome::complete(message))
        }
    }

    let provider = std::sync::Arc::new(AlwaysRefuses {
        main_calls: AtomicUsize::new(0),
    });
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider.clone();
    config.retry_policy = evotengine::RetryPolicy::disabled();
    config.context_config = Some(ContextConfig {
        max_context_tokens: 100_000,
        system_prompt_tokens: 0,
        advertised_context_window: None,
        reserve_tokens: Some(1_000),
        trigger_tokens: None,
        keep_recent_tokens: Some(300),
    });

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: (0..12)
            .map(|index| {
                AgentMessage::Llm(Message::user(format!(
                    "old history {index} {}",
                    "x".repeat(1_000)
                )))
            })
            .collect(),
        tools: vec![],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();

    agent_loop(
        vec![AgentMessage::Llm(Message::user("continue"))],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let events = collect_events(rx);

    assert_eq!(provider.main_calls.load(Ordering::SeqCst), 2);
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::Error { error }
            if error.message.contains("refused the request again after compacting")
    )));
}
