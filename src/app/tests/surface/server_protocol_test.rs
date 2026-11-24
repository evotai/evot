use evot::session::conversation::*;
use evot::types::*;

#[test]
fn transcript_round_trip_preserves_ordered_assistant_blocks_and_provider_metadata(
) -> Result<(), Box<dyn std::error::Error>> {
    let message = evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
        content: vec![
            evot_engine::Content::Thinking {
                thinking: "plan".into(),
                metadata: Some(evot_engine::ThinkingMetadata::completions_text_only(
                    evot_engine::types::ReasoningField::Reasoning,
                )),
            },
            evot_engine::Content::ToolCall {
                id: "call-1".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "a"}),
                metadata: Some(evot_engine::ToolCallMetadata::OpenAiResponses {
                    item_id: "fc-1".into(),
                }),
            },
            evot_engine::Content::Text {
                text: "done".into(),
            },
        ],
        stop_reason: evot_engine::StopReason::ToolUse,
        model: "model".into(),
        provider: "provider".into(),
        usage: evot_engine::Usage::default(),
        timestamp: 1,
        error_message: None,
        response_id: None,
    });

    let transcript = evot::session::conversation::convert::transcript_from_agent_message(&message);
    let serialized = serde_json::to_string(&transcript)?;
    let transcript: TranscriptItem = serde_json::from_str(&serialized)?;
    let restored = evot::session::conversation::convert::agent_message_from_transcript(&transcript);

    assert!(matches!(
        restored,
        evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant { content, .. })
            if matches!(&content[..], [
                evot_engine::Content::Thinking { thinking, metadata },
                evot_engine::Content::ToolCall {
                    id,
                    metadata: Some(evot_engine::ToolCallMetadata::OpenAiResponses { item_id }),
                    ..
                },
                evot_engine::Content::Text { text },
            ] if thinking == "plan"
                && matches!(metadata, Some(evot_engine::ThinkingMetadata::OpenAiCompletions {
                    field: evot_engine::types::ReasoningField::Reasoning,
                    ..
                }))
                && id == "call-1"
                && item_id == "fc-1"
                && text == "done")
    ));
    Ok(())
}

#[test]
fn legacy_responses_tool_ids_migrate_at_transcript_load_boundary() {
    let items = vec![
        TranscriptItem::Assistant {
            content: vec![AssistantBlock::ToolCall {
                id: "call-1|fc-1".into(),
                name: "read".into(),
                input: serde_json::json!({"path": "a"}),
                metadata: None,
            }],
            stop_reason: "tool_use".into(),
            usage: UsageSummary::default(),
            model: "gpt-5.5".into(),
            provider: "openai".into(),
            timestamp: 1,
            error_message: None,
        },
        TranscriptItem::ToolResult {
            tool_call_id: "call-1|fc-1".into(),
            tool_name: "read".into(),
            content: "ok".into(),
            is_error: false,
            details: serde_json::Value::Null,
        },
    ];

    let restored = evot::session::conversation::convert::into_agent_messages(&items);
    assert!(matches!(
        &restored[..],
        [
            evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant { content, .. }),
            evot_engine::AgentMessage::Llm(evot_engine::Message::ToolResult { tool_call_id, .. }),
        ] if matches!(&content[..], [evot_engine::Content::ToolCall {
            id,
            metadata: Some(evot_engine::ToolCallMetadata::OpenAiResponses { item_id }),
            ..
        }] if id == "call-1" && item_id == "fc-1") && tool_call_id == "call-1"
    ));
}

#[test]
fn run_event_round_trip_run_started() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        0,
        RunEventPayload::RunStarted {},
    );
    let json = serde_json::to_string(&event).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    // Verify top-level shape: { event_id, run_id, session_id, turn, kind, payload, created_at }
    assert_eq!(parsed["kind"], "run_started");
    assert_eq!(parsed["run_id"], "run-1");
    assert_eq!(parsed["session_id"], "sess-1");
    assert_eq!(parsed["turn"], 0);
    assert!(parsed["event_id"].is_string());
    assert!(parsed["created_at"].is_string());
    assert!(parsed["payload"].is_object());

    // Round-trip
    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.run_id, "run-1");
    assert!(matches!(
        deserialized.payload,
        RunEventPayload::RunStarted {}
    ));
}

#[test]
fn run_event_round_trip_assistant_delta_text_only() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::AssistantDelta {
            content_index: 2,
            content_type: AssistantContentType::Text,
            delta: "hello".into(),
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["kind"], "assistant_delta");
    assert_eq!(parsed["payload"]["content_index"], 2);
    assert_eq!(parsed["payload"]["content_type"], "text");
    assert_eq!(parsed["payload"]["delta"], "hello");

    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();
    if let RunEventPayload::AssistantDelta {
        content_index,
        content_type,
        delta,
    } = &deserialized.payload
    {
        assert_eq!(*content_index, 2);
        assert!(matches!(content_type, AssistantContentType::Text));
        assert_eq!(delta, "hello");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn run_event_round_trip_assistant_delta_thinking_only() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::AssistantDelta {
            content_index: 0,
            content_type: AssistantContentType::Thinking,
            delta: "hmm".into(),
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["payload"]["content_index"], 0);
    assert_eq!(parsed["payload"]["content_type"], "thinking");
    assert_eq!(parsed["payload"]["delta"], "hmm");

    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();
    if let RunEventPayload::AssistantDelta {
        content_index,
        content_type,
        delta,
    } = &deserialized.payload
    {
        assert_eq!(*content_index, 0);
        assert!(matches!(content_type, AssistantContentType::Thinking));
        assert_eq!(delta, "hmm");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn run_event_round_trip_assistant_tool_call() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::AssistantToolCall {
            content_index: 2,
            tool_call_id: "call-2".into(),
            tool_name: "edit".into(),
            phase: ToolCallStreamPhase::End,
            delta: None,
            args: Some(serde_json::json!({"path": "src/lib.rs"})),
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["kind"], "assistant_tool_call");
    assert_eq!(parsed["payload"]["content_index"], 2);
    assert_eq!(parsed["payload"]["tool_call_id"], "call-2");
    assert_eq!(parsed["payload"]["tool_name"], "edit");
    assert_eq!(parsed["payload"]["phase"], "end");
    assert_eq!(parsed["payload"]["args"]["path"], "src/lib.rs");
}

#[test]
fn run_event_round_trip_assistant_completed() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::AssistantCompleted {
            content: vec![
                AssistantBlock::Text { text: "hi".into() },
                AssistantBlock::ToolCall {
                    id: "tc-1".into(),
                    name: "read".into(),
                    input: serde_json::json!({"path": "/tmp"}),
                    metadata: None,
                },
            ],
            usage: Some(UsageSummary {
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
            }),
            stop_reason: "toolUse".into(),
            error_message: None,
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();

    if let RunEventPayload::AssistantCompleted {
        content,
        usage,
        stop_reason,
        ..
    } = &deserialized.payload
    {
        assert_eq!(content.len(), 2);
        assert!(usage.is_some());
        assert_eq!(usage.as_ref().unwrap().input, 100);
        assert_eq!(stop_reason, "toolUse");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn run_event_round_trip_tool_finished() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::ToolFinished {
            tool_call_id: "tc-1".into(),
            tool_name: "read".into(),
            content: "file contents".into(),
            is_error: false,
            details: serde_json::Value::Null,
            result_tokens: 3,
            duration_ms: 100,
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["kind"], "tool_finished");
    assert_eq!(parsed["payload"]["tool_name"], "read");
    assert_eq!(parsed["payload"]["is_error"], false);

    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        deserialized.payload,
        RunEventPayload::ToolFinished { .. }
    ));
}

#[test]
fn run_event_round_trip_quota_waiting() -> Result<(), Box<dyn std::error::Error>> {
    let event = RunEvent::new(
        "run-quota".into(),
        "session-quota".into(),
        3,
        RunEventPayload::QuotaWaiting {
            delay_ms: 1_800_000,
            error: "HTTP 429: rate_limit_error: five-hour usage limit reached".into(),
        },
    );
    let json = serde_json::to_string(&event)?;
    let parsed: serde_json::Value = serde_json::from_str(&json)?;
    assert_eq!(parsed["kind"], "quota_waiting");
    assert_eq!(parsed["payload"]["delay_ms"], 1_800_000);
    assert_eq!(
        parsed["payload"]["error"],
        "HTTP 429: rate_limit_error: five-hour usage limit reached"
    );
    let decoded: RunEvent = serde_json::from_str(&json)?;
    assert!(matches!(decoded.payload, RunEventPayload::QuotaWaiting {
        delay_ms: 1_800_000,
        ref error
    } if error == "HTTP 429: rate_limit_error: five-hour usage limit reached"));

    let legacy_json = r#"{"event_id":"evt-legacy","run_id":"run-quota","session_id":"session-quota","turn":3,"kind":"quota_waiting","payload":{"delay_ms":60000},"created_at":"2026-01-01T00:00:00Z"}"#;
    let legacy: RunEvent = serde_json::from_str(legacy_json)?;
    assert!(matches!(legacy.payload, RunEventPayload::QuotaWaiting {
        delay_ms: 60_000,
        ref error
    } if error.is_empty()));
    Ok(())
}

#[test]
fn run_event_round_trip_outage_waiting() -> Result<(), Box<dyn std::error::Error>> {
    let event = RunEvent::new(
        "run-outage".into(),
        "session-outage".into(),
        7,
        RunEventPayload::OutageWaiting {
            delay_ms: 60_000,
            error: "API error: Upstream request failed.".into(),
        },
    );
    let json = serde_json::to_string(&event)?;
    let parsed: serde_json::Value = serde_json::from_str(&json)?;
    assert_eq!(parsed["kind"], "outage_waiting");
    assert_eq!(parsed["payload"]["delay_ms"], 60_000);
    assert_eq!(
        parsed["payload"]["error"],
        "API error: Upstream request failed."
    );
    let decoded: RunEvent = serde_json::from_str(&json)?;
    assert!(matches!(decoded.payload, RunEventPayload::OutageWaiting {
        delay_ms: 60_000,
        ..
    }));
    Ok(())
}

#[test]
fn run_event_round_trip_llm_call_retry() -> Result<(), Box<dyn std::error::Error>> {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::LlmCallRetry {
            turn: 1,
            attempt: 2,
            max_retries: 3,
            delay_ms: 2100,
            error: "tls handshake eof".into(),
        },
    );
    let json = serde_json::to_string(&event)?;
    let parsed: serde_json::Value = serde_json::from_str(&json)?;
    assert_eq!(parsed["kind"], "llm_call_retry");
    assert_eq!(parsed["payload"]["attempt"], 2);
    assert_eq!(parsed["payload"]["delay_ms"], 2100);

    let deserialized: RunEvent = serde_json::from_str(&json)?;
    if let RunEventPayload::LlmCallRetry {
        attempt,
        max_retries,
        delay_ms,
        error,
        ..
    } = &deserialized.payload
    {
        assert_eq!(*attempt, 2);
        assert_eq!(*max_retries, 3);
        assert_eq!(*delay_ms, 2100);
        assert_eq!(error, "tls handshake eof");
    } else {
        panic!("wrong variant");
    }
    Ok(())
}

#[test]
fn run_event_round_trip_run_finished() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        2,
        RunEventPayload::RunFinished {
            text: "done".into(),
            usage: UsageSummary {
                input: 200,
                output: 100,
                cache_read: 0,
                cache_write: 0,
            },
            turn_count: 2,
            duration_ms: 1500,
            transcript_count: 4,
            compact_history: vec![],
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();

    if let RunEventPayload::RunFinished {
        turn_count,
        duration_ms,
        usage,
        ..
    } = &deserialized.payload
    {
        assert_eq!(*turn_count, 2);
        assert_eq!(*duration_ms, 1500);
        assert_eq!(usage.input, 200);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn run_event_round_trip_error() {
    let event = RunEvent::new("run-1".into(), "sess-1".into(), 0, RunEventPayload::Error {
        message: "bad request".into(),
    });
    let json = serde_json::to_string(&event).unwrap();
    let deserialized: RunEvent = serde_json::from_str(&json).unwrap();
    if let RunEventPayload::Error { message } = &deserialized.payload {
        assert_eq!(message, "bad request");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn run_event_deserialize_rejects_missing_fields() {
    // Missing event_id
    let bad_json = r#"{"run_id":"r","session_id":"s","turn":0,"kind":"run_started","payload":{},"created_at":"t"}"#;
    let result = serde_json::from_str::<RunEvent>(bad_json);
    assert!(result.is_err());

    // Missing kind
    let bad_json2 =
        r#"{"event_id":"e","run_id":"r","session_id":"s","turn":0,"payload":{},"created_at":"t"}"#;
    let result2 = serde_json::from_str::<RunEvent>(bad_json2);
    assert!(result2.is_err());

    // Missing run_id
    let bad_json3 = r#"{"event_id":"e","session_id":"s","turn":0,"kind":"run_started","payload":{},"created_at":"t"}"#;
    let result3 = serde_json::from_str::<RunEvent>(bad_json3);
    assert!(result3.is_err());

    // Missing payload
    let bad_json4 = r#"{"event_id":"e","run_id":"r","session_id":"s","turn":0,"kind":"run_started","created_at":"t"}"#;
    let result4 = serde_json::from_str::<RunEvent>(bad_json4);
    assert!(result4.is_err());
}

// ---------------------------------------------------------------------------
// StreamJsonSink output shape test
// ---------------------------------------------------------------------------

#[test]
fn stream_json_output_preserves_shape() {
    let event = RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::AssistantDelta {
            content_index: 0,
            content_type: AssistantContentType::Text,
            delta: "hello".into(),
        },
    );
    let json = serde_json::to_string(&event).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    // StreamJsonSink does serde_json::to_string(event) — verify the shape
    assert!(parsed.get("event_id").is_some());
    assert!(parsed.get("run_id").is_some());
    assert!(parsed.get("session_id").is_some());
    assert!(parsed.get("turn").is_some());
    assert!(parsed.get("kind").is_some());
    assert!(parsed.get("payload").is_some());
    assert!(parsed.get("created_at").is_some());
    // kind is top-level string, not nested
    assert!(parsed["kind"].is_string());
    // payload is object without kind inside
    assert!(parsed["payload"].get("kind").is_none());
}
