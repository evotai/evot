//! Tool execution behavior: sequential vs parallel vs batched strategies,
//! streaming updates (`on_update`), progress messages, cross-model tool-name
//! aliasing, and the execution-duration limit excluding tool wall-time.

use evotengine::provider::mock::*;
use evotengine::provider::MockProvider;
use evotengine::types::AgentContext;
use evotengine::*;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::common::ProgressTool;
use crate::fixtures::agent_harness::collect_events;
use crate::fixtures::agent_harness::make_config;
use crate::fixtures::agent_harness::MockTool;
use crate::fixtures::agent_harness::TestHarness;

// ---------------------------------------------------------------------------
// Truncated tool-call safety
// ---------------------------------------------------------------------------

/// A length-limited response may carry arguments that provider JSON repair
/// salvaged into parseable-but-incomplete input. Every call in the batch must
/// fail, not just the one that was cut off mid-stream.
#[tokio::test]
async fn length_limited_tool_calls_are_failed_without_execution() {
    let output = TestHarness::new()
        .responses(vec![
            MockResponse::ToolCallsWithStop {
                calls: vec![
                    MockToolCall {
                        name: "first_tool".into(),
                        arguments: serde_json::json!({ "command": "complete command" }),
                    },
                    MockToolCall {
                        name: "second_tool".into(),
                        arguments: serde_json::json!({ "command": "partial comm" }),
                    },
                ],
                stop_reason: StopReason::Length,
            },
            MockResponse::Text("retried safely".into()),
        ])
        .tool(MockTool::ok("first_tool", "FIRST RAN"))
        .tool(MockTool::ok("second_tool", "SECOND RAN"))
        .run("run the tools")
        .await;

    output.assert_completed();

    // The whole batch fails, including the call whose arguments look complete.
    assert_eq!(output.tool_errors().len(), 2);
    let truncation_errors = output
        .events
        .iter()
        .filter(|event| {
            matches!(event, AgentEvent::ToolExecutionEnd { result, .. }
                if result.content.iter().any(|block| matches!(block, Content::Text { text }
                    if text.contains("arguments may be truncated"))))
        })
        .count();
    assert_eq!(
        truncation_errors, 2,
        "every call in a truncated batch must report the truncation error"
    );

    assert!(
        output.context_messages.iter().all(|message| {
            !matches!(message, AgentMessage::Llm(Message::ToolResult { content, .. })
                if content.iter().any(|block| matches!(block, Content::Text { text }
                    if text == "FIRST RAN" || text == "SECOND RAN")))
        }),
        "no underlying tool may execute for a truncated batch"
    );
}

// ---------------------------------------------------------------------------
// Parallel tool execution tests
// ---------------------------------------------------------------------------

/// A tool that records execution timestamps to verify parallelism.
struct TimedTool {
    name: String,
    delay_ms: u64,
}

#[async_trait::async_trait]
impl AgentTool for TimedTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn label(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        "Timed tool"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
        Ok(ToolResult {
            content: vec![Content::Text {
                text: format!("done:{}", self.name),
            }],
            details: serde_json::Value::Null,
            retention: Retention::Normal,
        })
    }
}

#[tokio::test]
async fn test_parallel_tool_execution_faster_than_sequential() {
    // 3 tools each taking 50ms. Sequential = 150ms+, Parallel = ~50ms.
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![
            MockToolCall {
                name: "tool_a".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "tool_b".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "tool_c".into(),
                arguments: serde_json::json!({}),
            },
        ]),
        MockResponse::Text("All done.".into()),
    ]);

    let mut config = make_config(provider);
    config.tool_execution = ToolExecutionStrategy::Parallel;

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![
            Box::new(TimedTool {
                name: "tool_a".into(),
                delay_ms: 50,
            }),
            Box::new(TimedTool {
                name: "tool_b".into(),
                delay_ms: 50,
            }),
            Box::new(TimedTool {
                name: "tool_c".into(),
                delay_ms: 50,
            }),
        ],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("Run all tools"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let start = std::time::Instant::now();
    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let _elapsed = start.elapsed();

    let events = collect_events(rx);

    // All 3 tool results should be present
    let tool_results: Vec<_> = new_messages
        .iter()
        .filter(|m| m.role() == "toolResult")
        .collect();
    assert_eq!(tool_results.len(), 3);

    // Parallel execution should complete faster than sequential would (~150ms+),
    // but we don't assert absolute wall-clock time since CI machines are slow.
    // The sequential test (test_sequential_tool_execution_is_slower) covers timing.

    // Should have 3 ToolExecutionStart and 3 ToolExecutionEnd events
    let starts = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolExecutionStart { .. }))
        .count();
    let ends = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolExecutionEnd { .. }))
        .count();
    assert_eq!(starts, 3);
    assert_eq!(ends, 3);
}

#[tokio::test]
async fn test_sequential_tool_execution_is_slower() {
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![
            MockToolCall {
                name: "tool_a".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "tool_b".into(),
                arguments: serde_json::json!({}),
            },
        ]),
        MockResponse::Text("Done.".into()),
    ]);

    let mut config = make_config(provider);
    config.tool_execution = ToolExecutionStrategy::Sequential;

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![
            Box::new(TimedTool {
                name: "tool_a".into(),
                delay_ms: 50,
            }),
            Box::new(TimedTool {
                name: "tool_b".into(),
                delay_ms: 50,
            }),
        ],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("Run tools"));
    let (tx, _rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let start = std::time::Instant::now();
    let _new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let elapsed = start.elapsed();

    // Sequential should take 100ms+ (2 × 50ms)
    assert!(
        elapsed.as_millis() >= 95,
        "Sequential execution took {}ms, expected >=95ms",
        elapsed.as_millis()
    );
}

#[tokio::test]
async fn test_batched_tool_execution() {
    // 4 tools, batch size 2: two batches of 2
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![
            MockToolCall {
                name: "tool_a".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "tool_b".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "tool_c".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "tool_d".into(),
                arguments: serde_json::json!({}),
            },
        ]),
        MockResponse::Text("All done.".into()),
    ]);

    let mut config = make_config(provider);
    config.tool_execution = ToolExecutionStrategy::Batched { size: 2 };

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![
            Box::new(TimedTool {
                name: "tool_a".into(),
                delay_ms: 50,
            }),
            Box::new(TimedTool {
                name: "tool_b".into(),
                delay_ms: 50,
            }),
            Box::new(TimedTool {
                name: "tool_c".into(),
                delay_ms: 50,
            }),
            Box::new(TimedTool {
                name: "tool_d".into(),
                delay_ms: 50,
            }),
        ],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("Run all tools"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    let events = collect_events(rx);

    // All 4 results present
    let tool_results: Vec<_> = new_messages
        .iter()
        .filter(|m| m.role() == "toolResult")
        .collect();
    assert_eq!(tool_results.len(), 4);

    // With batch size 2, the first two tools must complete before the second
    // pair starts. Within each pair, tools are allowed to run concurrently.
    let start_order: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolExecutionStart { tool_name, .. } => Some(tool_name.as_str()),
            _ => None,
        })
        .collect();
    let end_order: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolExecutionEnd { tool_name, .. } => Some(tool_name.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(start_order, vec!["tool_a", "tool_b", "tool_c", "tool_d"]);
    assert_eq!(end_order, vec!["tool_a", "tool_b", "tool_c", "tool_d"]);

    let first_second_batch_start = events.iter().position(
        |e| matches!(e, AgentEvent::ToolExecutionStart { tool_name, .. } if tool_name == "tool_c"),
    );
    let first_batch_last_end = events.iter().position(
        |e| matches!(e, AgentEvent::ToolExecutionEnd { tool_name, .. } if tool_name == "tool_b"),
    );

    assert!(first_batch_last_end < first_second_batch_start);
}
// ---------------------------------------------------------------------------
// Streaming tool output (on_update callback) tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_tool_execution_update_events_emitted() {
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "progress_tool".into(),
            arguments: serde_json::json!({}),
        }]),
        MockResponse::Text("All done.".into()),
    ]);

    let config = make_config(provider);

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![Box::new(ProgressTool)],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("go"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    let events = collect_events(rx);

    let updates: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolExecutionUpdate { partial_result, .. } => {
                if let Some(Content::Text { text }) = partial_result.content.first() {
                    Some(text.clone())
                } else {
                    None
                }
            }
            _ => None,
        })
        .collect();

    assert_eq!(updates, vec!["step 1/3", "step 2/3", "step 3/3"]);
}
// ---------------------------------------------------------------------------
// ProgressMessage tests (Addition 1)
// ---------------------------------------------------------------------------

/// A tool that calls on_progress to emit user-facing progress messages.
struct ProgressMessageTool;

#[async_trait::async_trait]
impl AgentTool for ProgressMessageTool {
    fn name(&self) -> &str {
        "progress_msg_tool"
    }
    fn label(&self) -> &str {
        "ProgressMsg"
    }
    fn description(&self) -> &str {
        "Emits progress messages"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        if let Some(ref progress) = ctx.on_progress {
            progress("Working...".into());
        }
        Ok(ToolResult {
            content: vec![Content::Text {
                text: "done".into(),
            }],
            details: serde_json::Value::Null,
            retention: Retention::Normal,
        })
    }
}

#[tokio::test]
async fn test_progress_message_event_emitted() {
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "progress_msg_tool".into(),
            arguments: serde_json::json!({}),
        }]),
        MockResponse::Text("ok".into()),
    ]);
    let config = make_config(provider);

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![Box::new(ProgressMessageTool)],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("go"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let events = collect_events(rx);

    let progress_msgs: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ProgressMessage {
                tool_call_id,
                tool_name,
                text,
            } => Some((tool_call_id.clone(), tool_name.clone(), text.clone())),
            _ => None,
        })
        .collect();

    assert_eq!(progress_msgs.len(), 1);
    assert_eq!(progress_msgs[0].1, "progress_msg_tool");
    assert_eq!(progress_msgs[0].2, "Working...");
}

/// A tool that does NOT call on_progress — should cause no panics, no events.
struct SilentTool;

#[async_trait::async_trait]
impl AgentTool for SilentTool {
    fn name(&self) -> &str {
        "silent_tool"
    }
    fn label(&self) -> &str {
        "Silent"
    }
    fn description(&self) -> &str {
        "Does not call progress"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        // Intentionally ignores on_progress
        Ok(ToolResult {
            content: vec![Content::Text {
                text: "quiet".into(),
            }],
            details: serde_json::Value::Null,
            retention: Retention::Normal,
        })
    }
}

#[tokio::test]
async fn test_tool_ignoring_progress_no_panic() {
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "silent_tool".into(),
            arguments: serde_json::json!({}),
        }]),
        MockResponse::Text("ok".into()),
    ]);
    let config = make_config(provider);

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![Box::new(SilentTool)],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("go"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let events = collect_events(rx);

    // No ProgressMessage events
    let progress_count = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ProgressMessage { .. }))
        .count();
    assert_eq!(progress_count, 0);
}

/// Two parallel tools both emit progress — events are distinguishable by tool_call_id.
struct NamedProgressTool {
    tool_name: String,
}

#[async_trait::async_trait]
impl AgentTool for NamedProgressTool {
    fn name(&self) -> &str {
        &self.tool_name
    }
    fn label(&self) -> &str {
        &self.tool_name
    }
    fn description(&self) -> &str {
        "Named progress tool"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        if let Some(ref progress) = ctx.on_progress {
            progress(format!("progress from {}", self.tool_name));
        }
        Ok(ToolResult {
            content: vec![Content::Text {
                text: format!("done:{}", self.tool_name),
            }],
            details: serde_json::Value::Null,
            retention: Retention::Normal,
        })
    }
}

#[tokio::test]
async fn test_streams_parallel_tool_calls_before_execution() {
    let output = TestHarness::new()
        .responses(vec![
            MockResponse::ToolCalls(vec![
                MockToolCall {
                    name: "read_a".into(),
                    arguments: serde_json::json!({"path": "a.rs"}),
                },
                MockToolCall {
                    name: "read_b".into(),
                    arguments: serde_json::json!({"path": "b.rs"}),
                },
            ]),
            MockResponse::Text("done".into()),
        ])
        .tool(MockTool::ok("read_a", "a"))
        .tool(MockTool::ok("read_b", "b"))
        .run("go")
        .await;

    let streamed: Vec<_> = output
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageUpdate {
                delta:
                    StreamDelta::ToolCallEnd {
                        content_index,
                        id,
                        name,
                        arguments,
                    },
                ..
            } => Some((*content_index, id.as_str(), name.as_str(), arguments)),
            _ => None,
        })
        .collect();

    assert_eq!(streamed.len(), 2);
    assert_eq!(streamed[0].0, 0);
    assert_eq!(streamed[0].2, "read_a");
    assert_eq!(streamed[0].3["path"], "a.rs");
    assert_eq!(streamed[1].0, 1);
    assert_eq!(streamed[1].2, "read_b");
    assert_eq!(streamed[1].3["path"], "b.rs");
}

#[tokio::test]
async fn test_parallel_tools_progress_distinguishable() {
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![
            MockToolCall {
                name: "pa".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "pb".into(),
                arguments: serde_json::json!({}),
            },
        ]),
        MockResponse::Text("done".into()),
    ]);
    let config = make_config(provider);

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![
            Box::new(NamedProgressTool {
                tool_name: "pa".into(),
            }),
            Box::new(NamedProgressTool {
                tool_name: "pb".into(),
            }),
        ],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("go"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let events = collect_events(rx);

    let progress_msgs: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ProgressMessage {
                tool_name, text, ..
            } => Some((tool_name.clone(), text.clone())),
            _ => None,
        })
        .collect();

    assert_eq!(progress_msgs.len(), 2);
    let names: Vec<&str> = progress_msgs.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"pa"));
    assert!(names.contains(&"pb"));
}

#[tokio::test]
async fn test_on_update_still_works_after_refactor() {
    // Existing ProgressTool uses on_update (not on_progress) — ensure it still works.
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "progress_tool".into(),
            arguments: serde_json::json!({}),
        }]),
        MockResponse::Text("ok".into()),
    ]);
    let config = make_config(provider);

    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![Box::new(ProgressTool)],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("go"));
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();

    agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;
    let events = collect_events(rx);

    let updates: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolExecutionUpdate { partial_result, .. } => {
                if let Some(Content::Text { text }) = partial_result.content.first() {
                    Some(text.clone())
                } else {
                    None
                }
            }
            _ => None,
        })
        .collect();

    assert_eq!(updates, vec!["step 1/3", "step 2/3", "step 3/3"]);
}

// ---------------------------------------------------------------------------
// Cross-model tool-name aliasing (resume scenario)
// ---------------------------------------------------------------------------

/// When a session is resumed under a non-Claude model, the model may call a
/// tool using the capitalized alias (e.g. `Edit`) it saw in history. Dispatch
/// must still resolve to the tool, and edit-specific coercion (legacy
/// single-edit args) must still apply — gated on the tool's canonical name,
/// not the called alias.
#[tokio::test]
async fn test_aliased_edit_call_dispatches_and_coerces() {
    use evotengine::tools::EditFileTool;

    let tmp = std::env::temp_dir().join("evot-harden-alias-edit.txt");
    std::fs::write(&tmp, "alpha\n").expect("write temp file");
    let path = tmp.to_string_lossy().to_string();

    let output = TestHarness::new()
        .responses(vec![
            // Model calls the Claude-style alias with legacy top-level
            // old_text/new_text (no edits array) — both paths must work.
            MockResponse::ToolCalls(vec![MockToolCall {
                name: "Edit".into(),
                arguments: serde_json::json!({
                    "path": path,
                    "old_text": "alpha",
                    "new_text": "beta",
                }),
            }]),
            MockResponse::Text("done".into()),
        ])
        .tool_boxed(Box::new(EditFileTool::new()))
        .run("edit it")
        .await;

    output.assert_completed();

    // The tool result must not be a dispatch failure.
    assert!(
        output.tool_errors().is_empty(),
        "aliased Edit call should dispatch and succeed without tool errors"
    );

    let content = std::fs::read_to_string(&tmp).expect("read temp file");
    let _ = std::fs::remove_file(&tmp);
    assert!(
        content.contains("beta"),
        "edit coercion should have applied the legacy single-edit, file: {:?}",
        content
    );
}

// ---------------------------------------------------------------------------
// Execution duration limit excludes tool wall-time (issue: long tool killed run)
// ---------------------------------------------------------------------------

/// A single tool call that runs far longer than `max_duration` must not
/// terminate the agent. The loop pauses the idle clock around every tool, so
/// the tool's wall-time is excluded from the duration limit — only the agent's
/// own work counts. Before this fix, a long bash command (e.g. a training run)
/// would trip `max_duration` at the top of the next turn and stop the loop even
/// though the tool returned normally.
#[tokio::test]
async fn slow_tool_does_not_trip_duration_limit() {
    let output = TestHarness::new()
        .execution_limits(evotengine::context::ExecutionLimits {
            max_turns: 1_000_000,
            max_total_tokens: usize::MAX,
            max_duration: std::time::Duration::from_millis(30),
        })
        .responses(vec![
            MockResponse::ToolCalls(vec![MockToolCall {
                name: "slow_build".into(),
                arguments: serde_json::json!({}),
            }]),
            MockResponse::Text("build finished".into()),
        ])
        // Tool runs ~4x longer than the duration limit.
        .tool(MockTool::ok("slow_build", "done").with_delay(std::time::Duration::from_millis(120)))
        .run("run the build")
        .await;

    output.assert_completed();
    output.assert_no_errors();
    // The loop reached the second turn and produced the final text rather than
    // stopping with an "[Agent stopped: Max duration ...]" message.
    output.assert_last_role("assistant");
    assert!(
        output.tool_errors().is_empty(),
        "the slow tool returned normally; there should be no tool error"
    );
    let stopped = output.context_messages.iter().any(|m| {
        matches!(m, AgentMessage::Llm(Message::User { content, .. })
            if content.iter().any(|c| matches!(c, Content::Text { text } if text.contains("Agent stopped"))))
    });
    assert!(!stopped, "a long tool must not trip the duration limit");
}

/// Interactive parity with pi: with no execution limits, the loop never injects
/// an "[Agent stopped]" message regardless of how much work it does.
#[tokio::test]
async fn no_limits_runs_without_stop_message() {
    let output = TestHarness::new()
        // execution_limits left as None (interactive default)
        .responses(vec![
            MockResponse::ToolCalls(vec![MockToolCall {
                name: "slow_build".into(),
                arguments: serde_json::json!({}),
            }]),
            MockResponse::Text("done".into()),
        ])
        .tool(MockTool::ok("slow_build", "ok").with_delay(std::time::Duration::from_millis(40)))
        .run("go")
        .await;

    output.assert_completed();
    output.assert_last_role("assistant");
    let stopped = output.context_messages.iter().any(|m| {
        matches!(m, AgentMessage::Llm(Message::User { content, .. })
            if content.iter().any(|c| matches!(c, Content::Text { text } if text.contains("Agent stopped"))))
    });
    assert!(!stopped, "no limits means no stop message");
}

// ---------------------------------------------------------------------------
// Run-settling tools (`ends_turn`)
// ---------------------------------------------------------------------------

fn call(name: &str) -> MockToolCall {
    MockToolCall {
        name: name.into(),
        arguments: serde_json::json!({}),
    }
}

/// A successful `ends_turn` tool call settles the run: the result is recorded
/// and the provider is not asked for a follow-up response.
#[tokio::test]
async fn ends_turn_tool_settles_run_without_follow_up_call() {
    let output = TestHarness::new()
        .responses(vec![
            MockResponse::ToolCalls(vec![call("schedule_wakeup")]),
            MockResponse::Text("must never be requested".into()),
        ])
        .tool(MockTool::ok("schedule_wakeup", "Next wakeup in 30m.").ends_turn())
        .run("watch the PR")
        .await;

    output.assert_completed();
    output.assert_no_errors();
    assert_eq!(output.event_count("LlmCallStart"), 1);
    assert_eq!(output.event_count("ToolExecEnd"), 1);
    assert_eq!(output.last_role(), Some("toolResult"));
}

/// A failed call to an `ends_turn` tool must come back to the model so it can
/// repair its arguments.
#[tokio::test]
async fn failed_ends_turn_tool_returns_to_model() {
    let output = TestHarness::new()
        .responses(vec![
            MockResponse::ToolCalls(vec![call("schedule_wakeup")]),
            MockResponse::Text("retrying with a reason".into()),
        ])
        .tool(MockTool::err("schedule_wakeup", "reason is required.").ends_turn())
        .run("watch the PR")
        .await;

    output.assert_completed();
    assert_eq!(output.event_count("LlmCallStart"), 2);
    output.assert_last_role("assistant");
}

/// Mixing an `ends_turn` tool with ordinary tools in one batch does not
/// settle: the ordinary results still need the model.
#[tokio::test]
async fn ends_turn_mixed_with_regular_tool_does_not_settle() {
    let output = TestHarness::new()
        .responses(vec![
            MockResponse::ToolCalls(vec![call("bash"), call("schedule_wakeup")]),
            MockResponse::Text("read the bash output".into()),
        ])
        .tool(MockTool::ok("bash", "ok"))
        .tool(MockTool::ok("schedule_wakeup", "Next wakeup in 30m.").ends_turn())
        .run("watch the PR")
        .await;

    output.assert_completed();
    assert_eq!(output.event_count("LlmCallStart"), 2);
    output.assert_last_role("assistant");
}

// ---------------------------------------------------------------------------
// Cancellation inside a sequential batch
// ---------------------------------------------------------------------------

/// Cancels the run when executed; records whether it ran.
struct CancellingTool {
    name: String,
    cancel: Option<CancellationToken>,
    ran: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait::async_trait]
impl AgentTool for CancellingTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn label(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        "Cancelling tool"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        self.ran.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        Ok(ToolResult {
            content: vec![Content::Text {
                text: format!("done:{}", self.name),
            }],
            details: serde_json::Value::Null,
            retention: Retention::Normal,
        })
    }
}

#[tokio::test]
async fn calls_after_a_cancel_in_a_sequential_batch_are_answered_without_running() {
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![
            MockToolCall {
                name: "first".into(),
                arguments: serde_json::json!({}),
            },
            MockToolCall {
                name: "second".into(),
                arguments: serde_json::json!({}),
            },
        ]),
        MockResponse::Text("Done.".into()),
    ]);
    let mut config = make_config(provider);
    config.tool_execution = ToolExecutionStrategy::Sequential;

    let cancel = CancellationToken::new();
    let first_ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let second_ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut context = AgentContext {
        system_prompt: "test".into(),
        messages: Vec::new(),
        tools: vec![
            Box::new(CancellingTool {
                name: "first".into(),
                cancel: Some(cancel.clone()),
                ran: first_ran.clone(),
            }),
            Box::new(CancellingTool {
                name: "second".into(),
                cancel: None,
                ran: second_ran.clone(),
            }),
        ],
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        prompt_cache_key: None,
    };

    let prompt = AgentMessage::Llm(Message::user("Run tools"));
    let (tx, _rx) = mpsc::unbounded_channel();
    let new_messages = agent_loop(vec![prompt], &mut context, &config, tx, cancel).await;

    assert!(first_ran.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!second_ran.load(std::sync::atomic::Ordering::SeqCst));
    let results: Vec<_> = new_messages
        .iter()
        .filter_map(|message| match message {
            AgentMessage::Llm(Message::ToolResult {
                tool_name,
                content,
                is_error,
                ..
            }) => Some((tool_name.clone(), content.clone(), *is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 2, "every call keeps a result");
    assert!(matches!(&results[1], (name, content, true)
        if name == "second"
            && matches!(content.as_slice(), [Content::Text { text }] if text == "Operation aborted")));
}
