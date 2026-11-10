use evot::agent::run::projection::map_agent_event;
use evot::agent::run::projection::RuntimeEvent;
use evot::session::conversation::AssistantContentType;
use evot::session::conversation::RunEventPayload;
use evot_engine::AgentEvent;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::StreamDelta;
use evot_engine::ToolResult;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn turn_start_updates_lifecycle_before_public_delivery() {
    assert!(map_agent_event(&AgentEvent::AgentStart).is_empty());
    assert!(matches!(
        map_agent_event(&AgentEvent::TurnStart).as_slice(),
        [
            RuntimeEvent::TurnStarted,
            RuntimeEvent::Public(RunEventPayload::TurnStarted { .. }),
        ]
    ));
}

#[test]
fn deltas_keep_content_identity_without_copying_message_snapshots_to_public_events() {
    let message = AgentMessage::Llm(Message::user("not part of the delta"));
    let projected = map_agent_event(&AgentEvent::MessageUpdate {
        message,
        delta: StreamDelta::Text {
            content_index: 7,
            delta: "片段".into(),
        },
    });
    assert!(
        matches!(projected.as_slice(), [RuntimeEvent::Public(RunEventPayload::AssistantDelta {
        content_index: 7, content_type: AssistantContentType::Text, delta,
    })] if delta == "片段")
    );
}

#[test]
fn tool_completion_persists_result_and_stats_before_public_delivery() -> TestResult {
    for details in [
        json!(null),
        json!([1, false]),
        json!({"extension": {"future": true}}),
    ] {
        let projected = map_agent_event(&AgentEvent::ToolExecutionEnd {
            tool_call_id: "call".into(),
            tool_name: "custom".into(),
            result: ToolResult {
                content: vec![Content::Text {
                    text: "output".into(),
                }],
                details: details.clone(),
                retention: Default::default(),
            },
            is_error: true,
            result_tokens: 13,
            duration_ms: 21,
        });
        match projected.as_slice() {
            [RuntimeEvent::Transcript(item), RuntimeEvent::Transcript(stats), RuntimeEvent::Public(payload)] =>
            {
                let persisted = serde_json::to_value(item)?;
                assert_eq!(persisted["details"], details);
                assert_eq!(persisted["content"], "output");
                let stats = serde_json::to_value(stats)?;
                assert!(stats.to_string().contains("tool_finished"));
                assert!(
                    matches!(payload, RunEventPayload::ToolFinished { details: value, result_tokens: 13, duration_ms: 21, is_error: true, .. } if value == &details)
                );
            }
            _ => return Err("unexpected projection order".into()),
        }
    }
    Ok(())
}

#[test]
fn compaction_rebase_precedes_public_completion_even_for_noop() {
    let projected = map_agent_event(&AgentEvent::ContextCompactionEnd {
        reason: evot_engine::CompactReason::Overflow,
        stats: Default::default(),
        messages: vec![],
        state: Default::default(),
        summary: None,
        context_window: 100,
        will_retry: true,
    });
    assert!(matches!(projected.as_slice(), [
        RuntimeEvent::CompactionCompleted {
            result: evot::observability::CompactionResult::NoOp,
            will_retry: true,
            ..
        },
        RuntimeEvent::Public(RunEventPayload::ContextCompactionCompleted {
            result: evot::observability::CompactionResult::NoOp,
            will_retry: true,
            ..
        }),
    ]));
}

#[test]
fn assistant_completion_and_engine_end_keep_distinct_persistence_roles() {
    let message = AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: "answer".into(),
        }],
        stop_reason: evot_engine::StopReason::Stop,
        model: "fixture".into(),
        provider: "fixture".into(),
        usage: evot_engine::Usage {
            input: 10,
            output: 5,
            cache_read: 2,
            cache_write: 3,
            ..Default::default()
        },
        timestamp: 0,
        error_message: None,
        response_id: None,
    });
    let projected = map_agent_event(&AgentEvent::MessageEnd {
        message: message.clone(),
    });
    assert!(matches!(projected.as_slice(), [
        RuntimeEvent::Transcript(evot::types::TranscriptItem::Assistant { .. }),
        RuntimeEvent::Public(RunEventPayload::AssistantCompleted { usage: Some(usage), stop_reason, .. }),
    ] if usage.input == 10 && usage.cache_read == 2 && stop_reason == "stop"));
    // AgentEnd aggregates but must not write the same assistant a second time.
    let ended = map_agent_event(&AgentEvent::AgentEnd {
        messages: vec![message],
    });
    assert!(
        matches!(ended.as_slice(), [RuntimeEvent::EngineCompleted { last_text, usage, transcript_count: 1 }]
        if last_text == "answer" && usage.output == 5 && usage.cache_write == 3)
    );
    // The same engine boundary admits initial, steering and follow-up inputs.
    // MessageStart and AgentEnd must not persist them a second time.
    let user = AgentMessage::Llm(Message::user("also check for new issues"));
    assert!(map_agent_event(&AgentEvent::MessageStart {
        message: user.clone(),
    })
    .is_empty());
    assert!(matches!(map_agent_event(&AgentEvent::MessageEnd {
        message: user.clone(),
    }).as_slice(), [RuntimeEvent::Transcript(evot::types::TranscriptItem::User { text, .. })]
        if text == "also check for new issues"));
    assert!(matches!(
        map_agent_event(&AgentEvent::AgentEnd {
            messages: vec![user],
        })
        .as_slice(),
        [RuntimeEvent::EngineCompleted { .. }]
    ));
}

#[test]
fn projection_has_no_lifecycle_or_transport_dependencies() {
    let source = include_str!("../../src/agent/run/projection.rs");
    for forbidden in [
        "tokio::",
        "Session;",
        "EventSender",
        "RunRegistry",
        "build_engine",
        "session.write",
    ] {
        assert!(!source.contains(forbidden), "{forbidden}");
    }
    let runtime = include_str!("../../src/agent/run/runtime.rs");
    assert!(!runtime.contains("fn map_agent_event"));
    assert!(runtime.contains("use super::projection::"));
}
