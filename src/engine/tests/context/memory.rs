//! Tests for the cumulative compaction state and its extractors.

use evotengine::context::compaction::memory::{self};
use evotengine::context::compaction::types::CompactionState;
use evotengine::types::*;

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
    let mut args = serde_json::Map::new();
    args.insert(
        "path".to_string(),
        serde_json::Value::String(path.to_string()),
    );
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: serde_json::Value::Object(args),
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
fn tool_result_msg(id: &str, name: &str, content: &str) -> AgentMessage {
    AgentMessage::Llm(Message::ToolResult {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        content: vec![Content::Text {
            text: content.to_string(),
        }],
        is_error: false,
        timestamp: 0,
        retention: Retention::Normal,
    })
}

#[test]
fn extracts_user_requests_from_evicted_messages() {
    let evicted = vec![
        user_msg("Fix the typo"),
        assistant_msg("done"),
        user_msg("Add a test"),
        assistant_msg("added"),
    ];
    let requests = memory::extract_user_requests(&evicted);
    assert!(requests.iter().any(|r| r.contains("Fix the typo")));
    assert!(requests.iter().any(|r| r.contains("Add a test")));
}

#[test]
fn extracts_file_ops_split_by_read_and_modified() {
    let evicted = vec![
        user_msg("edit things"),
        tool_call_msg("c1", "Read", "/src/config.rs"),
        tool_result_msg("c1", "Read", "..."),
        tool_call_msg("c2", "Write", "/src/new_file.rs"),
        tool_result_msg("c2", "Write", "ok"),
    ];
    let ops = memory::extract_file_ops(&evicted, None);
    assert!(ops.read.contains("/src/config.rs"));
    assert!(ops.modified().contains(&"/src/new_file.rs".to_string()));
}

#[test]
fn latest_assistant_text_is_the_last_reply() {
    let evicted = vec![
        user_msg("plan"),
        assistant_msg("first thought"),
        assistant_msg("I chose the layered approach"),
    ];
    let conclusion = match memory::latest_assistant_text(&evicted) {
        Some(text) => text,
        None => panic!("an assistant reply exists"),
    };
    assert!(conclusion.contains("layered approach"));
}

#[test]
fn split_turn_prefix_file_ops_join_the_state() {
    let prefix = vec![
        tool_call_msg("p1", "Read", "/src/prefix.rs"),
        tool_result_msg("p1", "Read", "..."),
    ];
    let state = memory::build_state(&[user_msg("refactor the module")], Some(&prefix), None);
    assert!(state.file_ops.read.contains("/src/prefix.rs"));
    assert_eq!(state.generation, 1);
}

#[test]
fn memory_accumulates_state_from_prev() {
    let mut prev_file_ops = evotengine::context::compaction::types::FileOps::default();
    prev_file_ops.read.insert("/old/file.rs".to_string());
    let prev_state = CompactionState {
        file_ops: prev_file_ops,
        env_discoveries: vec!["rust 1.75".to_string()],
        completed_requests: vec!["old request".to_string()],
        timestamp: 1000,
        generation: 1,
        last_summary: None,
        context_summary_message: None,
    };

    let evicted = vec![
        user_msg("new task"),
        tool_call_msg("c1", "Read", "/new/file.rs"),
        tool_result_msg("c1", "Read", "content"),
        assistant_msg("read it"),
    ];

    let state = memory::build_state(&evicted, None, Some(&prev_state));
    assert!(state.file_ops.read.contains("/old/file.rs"));
    assert!(state.file_ops.read.contains("/new/file.rs"));
    assert_eq!(state.generation, 2);
    assert!(state
        .completed_requests
        .contains(&"old request".to_string()));
}
