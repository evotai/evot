use evot::session::conversation::chat_projection::map_run_event;
use evot::session::conversation::chat_projection::replay_nodes;
use evot::session::conversation::RunEvent;
use evot::session::conversation::RunEventPayload;
use evot::types::AssistantBlock;
use evot::types::TranscriptItem;
use evot::types::UsageSummary;

#[test]
fn conversation_live_completion_and_replay_share_content_semantics() {
    let content = vec![
        AssistantBlock::Thinking {
            text: "reasoning".into(),
            metadata: None,
        },
        AssistantBlock::Text {
            text: "answer".into(),
        },
    ];
    let usage = UsageSummary::default();
    let event = RunEvent::new(
        "run".into(),
        "session".into(),
        1,
        RunEventPayload::AssistantCompleted {
            content: content.clone(),
            usage: Some(usage.clone()),
            stop_reason: "stop".into(),
            error_message: None,
        },
    );
    let history = TranscriptItem::Assistant {
        content,
        usage,
        stop_reason: "stop".into(),
        error_message: None,
        timestamp: 0,
        model: String::new(),
        provider: String::new(),
    };
    let live: Vec<_> = map_run_event(&event)
        .iter()
        .map(|node| node.to_sse_json())
        .collect();
    let replay: Vec<_> = replay_nodes(&[history])
        .iter()
        .map(|node| node.to_sse_json())
        .collect();
    assert_eq!(live, replay);
    assert_eq!(live[0]["blocks"][0]["kind"], "thinking");
    assert_eq!(live[0]["blocks"][1]["kind"], "text");
}

#[test]
fn conversation_projection_does_not_depend_on_http_transport() {
    let projection = include_str!("../../src/session/conversation/chat_projection.rs");
    assert!(!projection.contains("axum"));
    assert!(!projection.contains("crate::surface::gateway"));
    let stream = include_str!("../../src/surface/gateway/channels/http/stream.rs");
    assert!(stream.contains("crate::session::conversation::chat_projection"));
}
