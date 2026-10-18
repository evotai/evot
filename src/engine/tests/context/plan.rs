//! Tests for the unified compaction planner (`plan_compaction` / `plan_messages`).
//!
//! The planner operates on sequence-numbered transcript entries (manual
//! `/compact` path) or plain message lists (automatic agent-loop path) and
//! returns a declarative plan rather than a rewritten message list.

use evotengine::plan_compaction;
use evotengine::types::*;
use evotengine::CompactEntry;

fn entry(seq: u64, message: AgentMessage) -> CompactEntry {
    CompactEntry { seq, message }
}

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
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn extension() -> AgentMessage {
    AgentMessage::Extension(ExtensionMessage::new(
        "note",
        serde_json::json!({ "text": "ui-only" }),
    ))
}

fn tool_call(name: &str, path: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::ToolCall {
            id: "tc".into(),
            name: name.into(),
            arguments: serde_json::json!({ "path": path }),
            metadata: None,
        }],
        stop_reason: StopReason::ToolUse,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn big(n: usize) -> String {
    "x".repeat(n)
}

/// Build a sequence-numbered transcript from message factories.
/// Sequence numbers start at 1 (seq 0 is reserved for the session header).
fn transcript(messages: Vec<AgentMessage>) -> Vec<CompactEntry> {
    messages
        .into_iter()
        .enumerate()
        .map(|(i, m)| entry(i as u64 + 1, m))
        .collect()
}

#[test]
fn empty_returns_none() {
    assert!(plan_compaction(&[], None, 100).is_none());
}

#[test]
fn large_budget_returns_none_without_forced_eviction() {
    let entries = transcript(vec![user("hi"), assistant("there"), user("more")]);
    assert!(plan_compaction(&entries, None, 100_000).is_none());
}

#[test]
fn evicts_old_messages_and_keeps_recent() {
    let mut messages = vec![user(&big(400)), assistant(&big(400))];
    for _ in 0..10 {
        messages.push(user(&big(400)));
        messages.push(assistant(&big(400)));
    }
    messages.push(user("recent question"));
    messages.push(assistant("recent answer"));
    let entries = transcript(messages);

    let plan = match plan_compaction(&entries, None, 200) {
        Some(plan) => plan,
        None => panic!("expected a compaction plan"),
    };

    // Summarize range is non-empty and starts at the beginning (no prior boundary).
    assert_eq!(plan.summarize.start, 0);
    assert!(plan.summarize.end > plan.summarize.start);
    // The first kept entry maps to a real sequence number past the summarized span.
    assert!(plan.first_kept_seq > 1);
    assert_eq!(plan.messages_before, entries.len());
    assert!(plan.tokens_before > 0);
}

#[test]
fn boundary_seq_skips_already_summarized_prefix() {
    let mut messages = vec![user("old summarized 1"), assistant("old summarized 2")];
    for _ in 0..10 {
        messages.push(user(&big(400)));
        messages.push(assistant(&big(400)));
    }
    messages.push(user("recent"));
    messages.push(assistant("recent answer"));
    let entries = transcript(messages);

    // Pretend a prior compaction kept everything from seq 5 onward.
    let boundary_seq = 5;
    let plan = match plan_compaction(&entries, Some(boundary_seq), 200) {
        Some(plan) => plan,
        None => panic!("expected a compaction plan"),
    };

    // Summarization must not reach back before the previous boundary.
    let summarize_start_seq = entries[plan.summarize.start].seq;
    assert!(
        summarize_start_seq >= boundary_seq,
        "summarize started at {summarize_start_seq}, before boundary {boundary_seq}"
    );
}

#[test]
fn boundary_at_last_entry_returns_none() {
    // When the previous boundary already keeps everything up to the last entry,
    // there is nothing new to summarize.
    let entries = transcript(vec![user("a"), assistant("b"), user("c")]);
    let last_seq = entries[entries.len() - 1].seq;
    assert!(plan_compaction(&entries, Some(last_seq), 1).is_none());
}

#[test]
fn extracts_file_ops_from_summarized_zone() {
    let mut messages = vec![user(&big(400)), assistant(&big(400))];
    for i in 0..8 {
        messages.push(user(&big(400)));
        messages.push(tool_call(
            if i % 2 == 0 { "edit" } else { "read" },
            &format!("src/file{i}.rs"),
        ));
    }
    messages.push(user("recent"));
    messages.push(assistant("recent answer"));
    let entries = transcript(messages);

    let plan = match plan_compaction(&entries, None, 200) {
        Some(plan) => plan,
        None => panic!("expected a compaction plan"),
    };

    assert!(
        !plan.file_ops.edited.is_empty() || !plan.file_ops.read.is_empty(),
        "expected file ops extracted from summarized zone"
    );
}

#[test]
fn keeps_adjacent_ui_metadata_with_the_retained_tail() {
    let entries = transcript(vec![user(&big(100)), extension(), assistant("a")]);

    let plan = match plan_compaction(&entries, None, 1) {
        Some(plan) => plan,
        None => panic!("expected old history to be evicted"),
    };
    assert_eq!(plan.summarize, 0..0);
    assert_eq!(plan.turn_prefix, Some(0..1));
    assert_eq!(plan.first_kept, 1);
    assert!(matches!(
        entries[plan.first_kept].message,
        AgentMessage::Extension(_)
    ));
}

#[test]
fn detects_split_turn_when_cut_lands_mid_turn() {
    // An old turn followed by a single large turn that must be split.
    let mut messages = vec![user("old turn")];
    messages.push(user(&big(400))); // turn start
    for _ in 0..6 {
        messages.push(tool_call("read", "a.rs"));
        messages.push(assistant(&big(400)));
    }
    messages.push(assistant("tail of the turn"));
    let entries = transcript(messages);

    // Small token budget forces the cut inside the big turn.
    if let Some(plan) = plan_compaction(&entries, None, 100) {
        if let Some(split) = &plan.split_turn {
            // turn_prefix must be present and align with the split.
            let prefix = match &plan.turn_prefix {
                Some(range) => range.clone(),
                None => panic!("split turn must carry a turn_prefix range"),
            };
            assert!(prefix.start < prefix.end);
            assert!(split.turn_start_seq <= split.cut_seq);
        }
    }
}

// ---------------------------------------------------------------------------
// `plan_messages` — the automatic agent-loop frontend
// ---------------------------------------------------------------------------

#[test]
fn messages_no_plan_when_everything_fits_the_retention_budget() {
    let messages = vec![user("hello"), assistant("hi")];
    assert!(evotengine::context::plan_messages(&messages, 100_000).is_none());
    assert!(evotengine::context::plan_messages(&[], 100).is_none());
}

#[test]
fn messages_plan_evicts_old_history_and_keeps_recent() {
    let mut messages = vec![user(&big(200)), assistant(&big(200))];
    for _ in 0..20 {
        messages.push(user(&big(300)));
        messages.push(assistant(&big(300)));
    }
    messages.push(user("recent question"));
    messages.push(assistant("recent answer"));

    let plan = match evotengine::context::plan_messages(&messages, 250) {
        Some(plan) => plan,
        None => panic!("expected planner to evict old history"),
    };
    // Nothing is pinned: the summary represents all evicted history.
    assert_eq!(plan.summarize.start, 0);
    assert!(plan.first_kept > 0);
    assert!(plan.first_kept < messages.len());
    assert_eq!(plan.messages_before, messages.len());
}

#[test]
fn messages_plan_always_retains_the_newest_message() {
    let mut messages = vec![user("oldest")];
    for _ in 0..10 {
        messages.push(user(&big(300)));
        messages.push(assistant(&big(300)));
    }
    messages.push(user("fresh prompt must survive preflight"));

    let plan = match evotengine::context::plan_messages(&messages, 0) {
        Some(plan) => plan,
        None => panic!("expected planner to evict middle context"),
    };
    assert!(plan.first_kept < messages.len());
    assert!(matches!(
        &messages[messages.len() - 1],
        AgentMessage::Llm(Message::User { content, .. })
            if matches!(content.first(), Some(Content::Text { text }) if text == "fresh prompt must survive preflight")
    ));
}

#[test]
fn messages_plan_does_not_cut_at_tool_result() {
    let mut messages = vec![user(&big(200)), assistant(&big(200))];
    for i in 0..10 {
        messages.push(user(&big(300)));
        messages.push(tool_call("read", &format!("f{i}.rs")));
        messages.push(tool_result(&big(300)));
    }
    messages.push(user("recent"));
    messages.push(assistant("answer"));

    if let Some(plan) = evotengine::context::plan_messages(&messages, 250) {
        assert!(!matches!(
            &messages[plan.first_kept],
            AgentMessage::Llm(Message::ToolResult { .. })
        ));
    }
}

#[test]
fn messages_overflow_fallback_can_evict_the_entire_unsplittable_tail() {
    let messages = vec![
        user("generate the presentation"),
        tool_call("read", "slides.md"),
        tool_result(&big(20_000)),
    ];

    // The normal plan cannot cut after the final ToolResult, so it keeps the
    // whole oversized tool batch and can only evict what precedes it.
    let plan = match evotengine::context::plan_messages(&messages, 100) {
        Some(plan) => plan,
        None => panic!("the prompt before the tool batch is still evictable"),
    };
    assert_eq!(plan.first_kept, 1);

    // Once the provider has rejected that request, overflow recovery may evict
    // the whole active turn. Keeping no verbatim suffix is preferable to
    // resending a known-bad payload; the summary preserves the turn semantics.
    let plan =
        match evotengine::context::plan_messages_from_boundary(&messages, 100, messages.len()) {
            Some(plan) => plan,
            None => panic!("overflow fallback should produce an emergency plan"),
        };
    assert_eq!(plan.summarize, 0..messages.len());
    assert_eq!(plan.first_kept, messages.len());
    assert!(plan.turn_prefix.is_none());
}

#[test]
fn messages_plan_keeps_the_final_tool_batch_when_its_result_exceeds_the_budget() {
    // A tool-heavy run whose newest result alone is bigger than the retained
    // budget: snapping forward from it finds no cut, so the planner must cut
    // at the assistant that issued the batch instead of keeping everything.
    let mut messages = vec![user("do the work")];
    for i in 0..5 {
        messages.push(tool_call("bash", &format!("step{i}")));
        messages.push(tool_result(&big(2_000)));
    }

    let plan = match evotengine::context::plan_messages(&messages, 100) {
        Some(plan) => plan,
        None => panic!("earlier tool turns must be evictable"),
    };
    assert_eq!(
        plan.first_kept,
        messages.len() - 2,
        "retain exactly the final tool call and its result"
    );
    assert!(matches!(
        &messages[plan.first_kept],
        AgentMessage::Llm(Message::Assistant { .. })
    ));
    assert!(plan.split_turn.is_some());
    assert_eq!(plan.turn_prefix, Some(0..messages.len() - 2));
}

#[test]
fn messages_plan_detects_split_turn() {
    // One old turn, then a single large turn that must be split.
    let mut messages = vec![user(&big(100))];
    messages.push(user(&big(200)));
    messages.push(tool_call("read", "a.rs"));
    messages.push(tool_result(&big(2000)));
    messages.push(tool_call("read", "b.rs"));
    messages.push(tool_result(&big(2000)));
    messages.push(assistant(&big(100)));

    let plan = match evotengine::context::plan_messages(&messages, 125) {
        Some(plan) => plan,
        None => panic!("large turn should produce a plan"),
    };
    assert!(
        plan.split_turn.is_some(),
        "cut inside a turn should be reported as a split"
    );
    assert!(plan.turn_prefix.is_some());
}

fn tool_result(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::ToolResult {
        tool_call_id: "tc".into(),
        tool_name: "read".into(),
        content: vec![Content::Text { text: text.into() }],
        is_error: false,
        timestamp: 0,
        retention: Retention::default(),
    })
}
