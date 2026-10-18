//! Resumed history must keep the provider's own token counts usable as the
//! context-size anchor. Replayed user / tool-result items carry no persisted
//! timestamp; if conversion stamped them with "now", every stored assistant
//! would look older than the messages before it and `ContextTracker` would
//! reject its usage, falling back to the full-history byte estimate (the
//! "context: 212%" footer after a resume).

use evot::conversation::convert::into_agent_messages;
use evot::observability::UsageSummary;
use evot::types::TranscriptItem;
use evot_engine::context::ContextTracker;
use evot_engine::AgentMessage;
use evot_engine::Message;

fn history_with_anchor(
    anchor_input: u64,
    anchor_cache_read: u64,
    anchor_output: u64,
) -> Vec<TranscriptItem> {
    let big = "x".repeat(400_000);
    vec![
        TranscriptItem::User {
            provenance: None,
            text: big.clone(),
            content: Vec::new(),
        },
        TranscriptItem::ToolResult {
            tool_call_id: "call-1".into(),
            tool_name: "Read".into(),
            content: big,
            is_error: false,
            details: serde_json::Value::Null,
        },
        TranscriptItem::Assistant {
            content: Vec::new(),
            stop_reason: "stop".into(),
            usage: UsageSummary {
                input: anchor_input,
                output: anchor_output,
                cache_read: anchor_cache_read,
                cache_write: 0,
            },
            model: "kimi-k3".into(),
            provider: "evot-pro".into(),
            // Stored wall-clock time, far in the past relative to a resume.
            timestamp: 1_700_000_000_000,
            error_message: None,
        },
    ]
}

#[test]
fn replayed_history_does_not_outdate_stored_assistant_anchor() {
    let messages = into_agent_messages(&history_with_anchor(30_000, 90_000, 100));

    for message in &messages {
        if let AgentMessage::Llm(Message::User { timestamp, .. })
        | AgentMessage::Llm(Message::ToolResult { timestamp, .. }) = message
        {
            assert_eq!(
                *timestamp, 0,
                "replayed history must not be stamped with resume time"
            );
        }
    }

    let tracker = ContextTracker::new();
    let estimate =
        tracker.estimate_context_tokens_for_model(&messages, Some("evot-pro"), Some("kimi-k3"));
    assert_eq!(
        estimate, 120_100,
        "provider usage must anchor the estimate after resume, got {estimate}"
    );
}

#[test]
fn replayed_history_without_usage_falls_back_to_local_estimate() {
    let messages = into_agent_messages(&history_with_anchor(0, 0, 0));
    let tracker = ContextTracker::new();
    let estimate =
        tracker.estimate_context_tokens_for_model(&messages, Some("evot-pro"), Some("kimi-k3"));
    assert!(
        estimate > 150_000,
        "all-zero usage (e.g. a gateway dropping usage on tool_use responses) cannot anchor: {estimate}"
    );
}
