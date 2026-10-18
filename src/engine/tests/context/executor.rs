//! Tests for the executor module.

use evotengine::context::compaction::config::CompactionConfig;
use evotengine::context::compaction::executor;
use evotengine::context::compaction::executor::ExecutionResult;
use evotengine::context::compaction::summary::LlmPolicy;
use evotengine::context::compaction::types::CompactionOutcome;
use evotengine::context::CompactionPlan;
use evotengine::context::SummarizerMode;
use evotengine::context::DEFAULT_SUMMARY_MAX_BYTES;
use evotengine::types::*;
use tokio_util::sync::CancellationToken;

fn user_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        timestamp: 0,
    })
}

fn assistant_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        stop_reason: StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn tool_call_msg(id: &str, name: &str, path: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: serde_json::json!({"path": path}),
            metadata: None,
        }],
        stop_reason: StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
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

fn big_text(n: usize) -> String {
    "x".repeat(n)
}

#[test]
fn normalize_small_histories_preserves_exchange_invariants() {
    use super::fixtures::compaction_assert::assert_no_orphan_tool_pairs;

    let mut failed = multi_tool_call_msg(&["a"]);
    if let AgentMessage::Llm(Message::Assistant { stop_reason, .. }) = &mut failed {
        *stop_reason = StopReason::Error;
    }
    let choices = [
        user_msg("next"),
        multi_tool_call_msg(&["a", "b", "a"]),
        tool_result_msg("a", "real a"),
        tool_result_msg("b", "real b"),
        extension_msg(),
        failed,
    ];
    assert!(evotengine::sanitize_tool_pairs(Vec::new()).is_empty());
    // Exhaust all short combinations: missing/duplicate results, interruptions,
    // repeated IDs, partial failures, and UI-only entries.
    for mut pattern in 0..choices.len().pow(5) {
        let mut history = Vec::new();
        for _ in 0..5 {
            history.push(choices[pattern % choices.len()].clone());
            pattern /= choices.len();
        }
        let replay = evotengine::sanitize_tool_pairs(history);
        assert_no_orphan_tool_pairs(&replay);
        assert_eq!(evotengine::sanitize_tool_pairs(replay.clone()), replay);
    }
}

#[test]
fn normalize_large_parallel_batch_keeps_real_results() {
    let ids: Vec<String> = (0..10_000).map(|i| format!("call-{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut history = vec![multi_tool_call_msg(&refs)];
    history.extend(
        ids.iter()
            .rev()
            .map(|id| tool_result_msg(id, "actual result")),
    );
    assert_eq!(evotengine::sanitize_tool_pairs(history.clone()), history);
}

#[tokio::test]
async fn compact_snapshot_keeps_missing_outcomes_and_failed_turns_unmodified() {
    let mut failed = assistant_msg("partial");
    if let AgentMessage::Llm(Message::Assistant { stop_reason, .. }) = &mut failed {
        *stop_reason = StopReason::Error;
    }
    let tail = vec![
        multi_tool_call_msg(&["a", "b"]),
        tool_result_msg("a", "real"),
        failed,
    ];
    let mut history = vec![user_msg("old context")];
    history.extend(tail.clone());
    let plan = manual_plan(&history, 0..1, None, 1);
    let outcome = compacted(
        run(
            history,
            &plan,
            &config_small(),
            LlmPolicy::Required,
            CancellationToken::new(),
        )
        .await,
    );
    // The compact snapshot can be stored and reloaded without persisting fake
    // executions or deleting the original failed turn.
    assert_eq!(&outcome.messages[1..], tail.as_slice());
    let replay = evotengine::sanitize_tool_pairs(outcome.messages.clone());
    super::fixtures::compaction_assert::assert_no_orphan_tool_pairs(&replay);
    assert!(
        matches!(replay.last(), Some(AgentMessage::Llm(Message::ToolResult {
        tool_call_id, is_error: true, ..
    })) if tool_call_id == "b")
    );
    assert_eq!(&outcome.messages[1..], tail.as_slice());
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

fn planned(messages: &[AgentMessage], config: &CompactionConfig) -> CompactionPlan {
    match evotengine::context::plan_messages(messages, config.keep_recent_tokens) {
        Some(plan) => plan,
        None => panic!("expected compaction plan"),
    }
}

/// Manual plan for tests that need explicit zone boundaries.
fn manual_plan(
    messages: &[AgentMessage],
    summarize: std::ops::Range<usize>,
    turn_prefix: Option<std::ops::Range<usize>>,
    first_kept: usize,
) -> CompactionPlan {
    CompactionPlan {
        summarize,
        turn_prefix,
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
    config: &CompactionConfig,
    llm_policy: LlmPolicy,
    cancel: CancellationToken,
) -> ExecutionResult {
    executor::execute(
        messages,
        plan,
        config,
        None,
        None,
        executor::ExecutionOptions {
            llm_policy,
            observer: None,
            cancel,
        },
    )
    .await
}

fn compacted(result: ExecutionResult) -> CompactionOutcome {
    match result {
        ExecutionResult::Compacted(outcome) => *outcome,
        ExecutionResult::Skipped(_) => panic!("expected compaction to run"),
    }
}

#[tokio::test]
async fn executor_reduces_message_count() {
    let config = config_small();
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let plan = planned(&messages, &config);
    let original_count = messages.len();

    let outcome = compacted(
        run(
            messages,
            &plan,
            &config,
            LlmPolicy::Required,
            CancellationToken::new(),
        )
        .await,
    );

    assert!(outcome.messages.len() < original_count);
    assert!(outcome.stats.messages_evicted > 0);
    assert!(outcome.stats.before_message_count == original_count);
    assert!(outcome.stats.after_message_count == outcome.messages.len());
}

#[tokio::test]
async fn executor_summarizes_the_oldest_history_instead_of_pinning_it() {
    let config = config_small();
    let mut messages = vec![
        user_msg("first user message"),
        assistant_msg("first assistant message"),
    ];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let plan = planned(&messages, &config);
    assert_eq!(plan.summarize.start, 0);
    let outcome = compacted(
        run(
            messages,
            &plan,
            &config,
            LlmPolicy::Required,
            CancellationToken::new(),
        )
        .await,
    );

    let summary = outcome.stats.summary.as_deref().unwrap_or_default();
    assert!(summary.contains("first user message"));
    assert_eq!(outcome.stats.messages_evicted, plan.first_kept);
    assert!(matches!(
        outcome.messages.first(),
        Some(AgentMessage::Llm(Message::User { content, .. }))
            if matches!(content.first(), Some(Content::Text { text }) if text == summary)
    ));
}

#[tokio::test]
async fn executor_inserts_marker() {
    let config = config_small();
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    for _ in 0..20 {
        messages.push(user_msg(&big_text(300)));
        messages.push(assistant_msg(&big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let plan = planned(&messages, &config);
    let outcome = compacted(
        run(
            messages,
            &plan,
            &config,
            LlmPolicy::Required,
            CancellationToken::new(),
        )
        .await,
    );

    // There should be a marker message containing "[Context compacted"
    let has_marker = outcome.messages.iter().any(|m| {
        if let AgentMessage::Llm(Message::User { content, .. }) = m {
            content.iter().any(|c| match c {
                Content::Text { text } => text.contains("[Context compacted"),
                _ => false,
            })
        } else {
            false
        }
    });
    assert!(has_marker, "Expected a compaction marker message");
}

#[tokio::test]
async fn cancelled_executor_leaves_context_unchanged() {
    let config = config_small();
    let messages = vec![
        user_msg(&big_text(2_000)),
        assistant_msg(&big_text(2_000)),
        user_msg("recent"),
    ];
    let original = serde_json::to_value(&messages).unwrap_or(serde_json::Value::Null);
    let plan = manual_plan(&messages, 0..2, None, 2);
    let cancel = CancellationToken::new();
    cancel.cancel();

    let result = run(messages, &plan, &config, LlmPolicy::Skip, cancel).await;

    let ExecutionResult::Skipped(messages) = result else {
        panic!("cancelled execution must not compact");
    };
    assert_eq!(
        serde_json::to_value(&messages).unwrap_or(serde_json::Value::Null),
        original
    );
}

#[tokio::test]
async fn executor_bounds_summary_consistently() {
    let mut config = config_small();
    config.summary_max_bytes = 256;
    let mut messages = vec![user_msg("pinned")];
    for i in 0..30 {
        messages.push(user_msg(&format!("request {i} {}", "x".repeat(300))));
    }
    messages.push(assistant_msg("latest critical conclusion must survive"));
    messages.push(user_msg("recent prompt"));
    let plan = manual_plan(&messages, 0..32, None, 32);

    let outcome = compacted(
        run(
            messages,
            &plan,
            &config,
            LlmPolicy::Required,
            CancellationToken::new(),
        )
        .await,
    );
    let summary = match outcome.stats.summary.as_deref() {
        Some(summary) => summary,
        None => panic!("expected summary"),
    };
    assert!(summary.len() <= config.summary_max_bytes);
    assert!(summary.contains("compaction summary truncated"));
    assert!(summary.contains("latest critical conclusion must survive"));
    assert_eq!(outcome.state.last_summary.as_deref(), Some(summary));
    assert!(matches!(
        outcome.messages.first(),
        Some(AgentMessage::Llm(Message::User { content, .. }))
            if matches!(content.first(), Some(Content::Text { text }) if text == summary)
    ));
}

#[tokio::test]
async fn overflow_fallback_does_not_reinsert_split_turn_verbatim() {
    let config = CompactionConfig::from_context_window(1_000_000);
    let messages = vec![
        user_msg(&format!("ORIGINAL_REQUEST\n{}", "x".repeat(200_000))),
        assistant_msg("LATEST_PREFIX_CONCLUSION"),
        user_msg("retained suffix"),
    ];
    let plan = manual_plan(&messages, 0..0, Some(0..2), 2);

    let outcome = compacted(
        run(
            messages,
            &plan,
            &config,
            LlmPolicy::Skip,
            CancellationToken::new(),
        )
        .await,
    );
    let summary = match outcome.stats.summary.as_deref() {
        Some(summary) => summary,
        None => panic!("expected emergency summary"),
    };

    assert!(summary.len() <= DEFAULT_SUMMARY_MAX_BYTES);
    assert!(summary.contains("ORIGINAL_REQUEST"));
    assert!(summary.contains("LATEST_PREFIX_CONCLUSION"));
    assert!(summary.contains("compaction summary truncated"));
    assert!(matches!(
        outcome.messages.first(),
        Some(AgentMessage::Llm(Message::User { content, .. }))
            if matches!(content.first(), Some(Content::Text { text }) if text == summary)
    ));
}

#[tokio::test]
async fn executor_tracks_file_ops_in_state() {
    let config = config_small();
    let mut messages = vec![user_msg(&big_text(200)), assistant_msg(&big_text(200))];
    // Add tool calls with file paths in the evict zone
    for i in 0..10 {
        messages.push(user_msg(&big_text(300)));
        messages.push(tool_call_msg(
            &format!("tc{i}"),
            "edit",
            &format!("src/file{i}.rs"),
        ));
        messages.push(tool_result_msg(&format!("tc{i}"), &big_text(300)));
    }
    messages.push(user_msg("recent"));
    messages.push(assistant_msg("recent answer"));

    let plan = planned(&messages, &config);
    let outcome = compacted(
        run(
            messages,
            &plan,
            &config,
            LlmPolicy::Required,
            CancellationToken::new(),
        )
        .await,
    );

    // State should have tracked file edits
    assert!(!outcome.state.file_ops.edited.is_empty());
}

#[test]
fn sanitize_tool_pairs_completes_orphans() {
    let messages = vec![
        user_msg("hello"),
        tool_call_msg("tc1", "read", "foo.rs"),
        // No matching tool result for tc1
        user_msg("next"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages);
    // The call remains, with an explicit missing-outcome result.
    let has_tool_call = result.iter().any(|m| {
        if let AgentMessage::Llm(Message::Assistant { content, .. }) = m {
            content
                .iter()
                .any(|c| matches!(c, Content::ToolCall { .. }))
        } else {
            false
        }
    });
    assert!(has_tool_call);
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 1);
}

fn is_tool_result(msg: &AgentMessage) -> bool {
    matches!(msg, AgentMessage::Llm(Message::ToolResult { .. }))
}

fn count_tool_calls(messages: &[AgentMessage]) -> usize {
    messages
        .iter()
        .filter_map(|m| match m {
            AgentMessage::Llm(Message::Assistant { content, .. }) => Some(
                content
                    .iter()
                    .filter(|c| matches!(c, Content::ToolCall { .. }))
                    .count(),
            ),
            _ => None,
        })
        .sum()
}

#[test]
fn sanitize_drops_tool_result_separated_from_its_call() {
    // A crash mid-tool-execution can persist an "Interrupted." user message
    // between the assistant tool_use and its tool_result. The id still exists
    // globally, but the Anthropic-compatible API rejects the non-adjacent
    // tool_result with HTTP 400. The sanitizer must drop it.
    let messages = vec![
        user_msg("hello"),
        tool_call_msg("call_00", "read", "foo.rs"),
        user_msg("Interrupted."),
        tool_result_msg("call_00", "file contents"),
        user_msg("continue"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages);

    // Replace the misplaced result with a missing-outcome marker before the
    // interrupting user, never move a real result across a user boundary.
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 1);
    assert_eq!(count_tool_calls(&result), 1);
    assert!(matches!(&result[2], AgentMessage::Llm(Message::ToolResult {
        is_error: true, content, ..
    }) if content == &vec![Content::Text { text: "No result provided".into() }]));
}

#[test]
fn sanitize_keeps_adjacent_tool_pair() {
    let messages = vec![
        user_msg("hello"),
        tool_call_msg("call_00", "read", "foo.rs"),
        tool_result_msg("call_00", "file contents"),
        assistant_msg("done"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages.clone());

    // Valid adjacency — nothing is removed.
    assert_eq!(result.len(), messages.len());
    assert_eq!(count_tool_calls(&result), 1);
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 1);
}

#[test]
fn sanitize_drops_duplicate_tool_result() {
    // Two results for the same call: only the adjacent one is valid; the
    // duplicate is an orphan that providers reject.
    let messages = vec![
        user_msg("hello"),
        tool_call_msg("call_00", "read", "foo.rs"),
        tool_result_msg("call_00", "first"),
        tool_result_msg("call_00", "duplicate"),
        assistant_msg("done"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages);

    // Exactly one tool_result survives, alongside its matched call.
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 1);
    assert_eq!(count_tool_calls(&result), 1);
}

#[test]
fn sanitize_drops_duplicate_tool_use_ids_within_one_message() {
    // Anthropic rejects a request whose assistant content repeats a tool_use id.
    let messages = vec![
        user_msg("hello"),
        multi_tool_call_msg(&["dup", "dup", "other"]),
        tool_result_msg("dup", "first"),
        tool_result_msg("other", "second"),
        assistant_msg("done"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages);

    // The repeated "dup" id collapses to a single call; "other" is untouched.
    let ids: Vec<String> = result
        .iter()
        .filter_map(|m| match m {
            AgentMessage::Llm(Message::Assistant { content, .. }) => Some(content),
            _ => None,
        })
        .flatten()
        .filter_map(|c| match c {
            Content::ToolCall { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(ids.iter().filter(|id| *id == "dup").count(), 1);
    assert_eq!(ids.iter().filter(|id| *id == "other").count(), 1);
}

fn multi_tool_call_msg(ids: &[&str]) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: ids
            .iter()
            .map(|id| Content::ToolCall {
                id: id.to_string(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "foo.rs"}),
                metadata: None,
            })
            .collect(),
        stop_reason: StopReason::ToolUse,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn extension_msg() -> AgentMessage {
    AgentMessage::Extension(evotengine::ExtensionMessage::new(
        "note",
        serde_json::json!({ "text": "ui-only" }),
    ))
}

#[test]
fn sanitize_keeps_parallel_tool_calls_with_all_results() {
    // One assistant turn issues two calls; both results follow contiguously.
    let messages = vec![
        user_msg("hello"),
        multi_tool_call_msg(&["call_a", "call_b"]),
        tool_result_msg("call_a", "a"),
        tool_result_msg("call_b", "b"),
        assistant_msg("done"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages.clone());

    assert_eq!(result.len(), messages.len());
    assert_eq!(count_tool_calls(&result), 2);
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 2);
}

#[test]
fn sanitize_completes_only_unmatched_parallel_call() {
    // Keep the real result and synthesize only the missing parallel outcome.
    let messages = vec![
        user_msg("hello"),
        multi_tool_call_msg(&["call_a", "call_b"]),
        tool_result_msg("call_a", "a"),
        user_msg("next"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages);

    assert_eq!(count_tool_calls(&result), 2);
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 2);
    assert!(matches!(&result[3], AgentMessage::Llm(Message::ToolResult {
        tool_call_id, is_error: true, ..
    }) if tool_call_id == "call_b"));
    let kept_call_a = result.iter().any(|m| match m {
        AgentMessage::Llm(Message::Assistant { content, .. }) => content
            .iter()
            .any(|c| matches!(c, Content::ToolCall { id, .. } if id == "call_a")),
        _ => false,
    });
    assert!(kept_call_a);
}

#[test]
fn sanitize_extension_between_call_and_result_stays_valid() {
    // Extension messages are dropped before the request is built, so they must
    // not break adjacency between a call and its result.
    let messages = vec![
        user_msg("hello"),
        tool_call_msg("call_00", "read", "foo.rs"),
        extension_msg(),
        tool_result_msg("call_00", "contents"),
        assistant_msg("done"),
    ];

    let result = evotengine::sanitize_tool_pairs(messages.clone());

    assert_eq!(result.len(), messages.len());
    assert_eq!(count_tool_calls(&result), 1);
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 1);
}

#[test]
fn sanitize_handles_reused_tool_call_id_across_turns() {
    // A reused id: the first occurrence is matched, the second is a trailing
    // orphan. Per-instance tracking must complete that exchange, not assume
    // the id is globally answered just because the earlier one matched.
    let messages = vec![
        user_msg("hello"),
        tool_call_msg("call_x", "read", "foo.rs"),
        tool_result_msg("call_x", "first"),
        assistant_msg("thinking"),
        tool_call_msg("call_x", "read", "bar.rs"),
        // No result for the second call_x.
    ];

    let result = evotengine::sanitize_tool_pairs(messages);

    // The first real result survives; the second exchange gets a failed marker.
    assert_eq!(count_tool_calls(&result), 2);
    assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 2);
    assert!(matches!(
        result.last(),
        Some(AgentMessage::Llm(Message::ToolResult {
            is_error: true,
            ..
        }))
    ));
}

#[test]
fn sanitize_missing_results_is_ordered_and_idempotent() {
    let mut calls = multi_tool_call_msg(&["a", "b", "c", "d"]);
    if let AgentMessage::Llm(Message::Assistant { content, .. }) = &mut calls {
        content.push(Content::Thinking {
            thinking: "plan".into(),
            metadata: Some(evotengine::ThinkingMetadata::Anthropic {
                signature: "sig".into(),
            }),
        });
    }
    let result = evotengine::sanitize_tool_pairs(vec![
        user_msg("summary"),
        calls.clone(),
        extension_msg(),
        tool_result_msg("b", "real result"),
        assistant_msg("next"),
    ]);
    assert_eq!(result[1], calls);
    let missing: Vec<&str> = result
        .iter()
        .filter_map(|message| match message {
            AgentMessage::Llm(Message::ToolResult {
                tool_call_id,
                is_error: true,
                content,
                ..
            }) => {
                assert_eq!(content, &vec![Content::Text {
                    text: "No result provided".into()
                }]);
                Some(tool_call_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(missing, vec!["a", "c", "d"]);
    assert_eq!(evotengine::sanitize_tool_pairs(result.clone()), result);
}

#[test]
fn sanitize_skips_failed_assistants_and_their_results() {
    for reason in [StopReason::Error, StopReason::Aborted] {
        let mut failed = multi_tool_call_msg(&["bad"]);
        if let AgentMessage::Llm(Message::Assistant { stop_reason, .. }) = &mut failed {
            *stop_reason = reason;
        }
        let result = evotengine::sanitize_tool_pairs(vec![
            user_msg("hello"),
            multi_tool_call_msg(&["pending"]),
            failed,
            tool_result_msg("bad", "partial"),
            user_msg("next"),
        ]);
        assert_eq!(count_tool_calls(&result), 1);
        assert_eq!(result.iter().filter(|m| is_tool_result(m)).count(), 1);
        assert!(matches!(&result[2], AgentMessage::Llm(Message::ToolResult {
            tool_call_id, is_error: true, ..
        }) if tool_call_id == "pending"));
        assert_eq!(result.len(), 4);
    }
}
