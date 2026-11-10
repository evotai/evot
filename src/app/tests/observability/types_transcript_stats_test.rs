use evot::observability::*;
use evot::types::*;

// ---------------------------------------------------------------------------
// TranscriptStats serde round-trip
// ---------------------------------------------------------------------------

#[test]
fn stats_llm_call_started_round_trip() {
    let stats = TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 5,
        message_bytes: 1200,
        system_prompt_tokens: 300,
        tool_definition_tokens: 50,
        ..Default::default()
    });
    let item = stats.to_item();
    assert!(matches!(&item, TranscriptItem::Stats { kind, .. } if kind == "llm_call_started"));

    let decoded = TranscriptStats::try_from_item(&item);
    assert!(decoded.is_some());
    if let Some(TranscriptStats::LlmCallStarted(s)) = decoded {
        assert_eq!(s.turn, 1);
        assert_eq!(s.model, "claude-3");
        assert_eq!(s.message_count, 5);
    } else {
        panic!("expected LlmCallStarted");
    }
}

#[test]
fn stats_llm_call_retry_round_trip() {
    let stats = TranscriptStats::LlmCallRetry(LlmCallRetryStats {
        turn: 1,
        attempt: 2,
        max_retries: 3,
        delay_ms: 2100,
        error: "tls handshake eof".into(),
    });
    let item = stats.to_item();
    assert!(matches!(&item, TranscriptItem::Stats { kind, .. } if kind == "llm_call_retry"));

    let decoded = TranscriptStats::try_from_item(&item);
    assert!(decoded.is_some());
    if let Some(TranscriptStats::LlmCallRetry(s)) = decoded {
        assert_eq!(s.turn, 1);
        assert_eq!(s.attempt, 2);
        assert_eq!(s.max_retries, 3);
        assert_eq!(s.delay_ms, 2100);
        assert_eq!(s.error, "tls handshake eof");
    } else {
        panic!("expected LlmCallRetry");
    }
}

#[test]
fn stats_llm_call_completed_round_trip() {
    let stats = TranscriptStats::LlmCallCompleted(LlmCallCompletedStats {
        turn: 2,
        attempt: 1,
        usage: UsageSummary {
            input: 1000,
            output: 200,
            cache_read: 50,
            cache_write: 10,
        },
        metrics: Some(LlmCallMetrics {
            duration_ms: 3000,
            ttfb_ms: 200,
            ttft_ms: 500,
            streaming_ms: 2500,
            chunk_count: 42,
        }),
        error: None,
        context_window: 0,
        stop_reason: "stop".into(),
    });
    let item = stats.to_item();
    let decoded = TranscriptStats::try_from_item(&item);
    assert!(decoded.is_some());
    if let Some(TranscriptStats::LlmCallCompleted(s)) = decoded {
        assert_eq!(s.usage.input, 1000);
        assert_eq!(s.usage.output, 200);
        assert!(s.metrics.is_some());
        assert_eq!(s.metrics.as_ref().map(|m| m.ttft_ms), Some(500));
    } else {
        panic!("expected LlmCallCompleted");
    }
}

#[test]
fn stats_tool_finished_round_trip() {
    let stats = TranscriptStats::ToolFinished(ToolFinishedStats {
        tool_call_id: "tc1".into(),
        tool_name: "read".into(),
        result_tokens: 150,
        duration_ms: 80,
        is_error: false,
    });
    let item = stats.to_item();
    let decoded = TranscriptStats::try_from_item(&item);
    if let Some(TranscriptStats::ToolFinished(s)) = decoded {
        assert_eq!(s.tool_name, "read");
        assert_eq!(s.result_tokens, 150);
        assert!(!s.is_error);
    } else {
        panic!("expected ToolFinished");
    }
}

#[test]
fn stats_context_compaction_started_round_trip() {
    let stats = TranscriptStats::ContextCompactionStarted(ContextCompactionStartedStats {
        message_count: 20,
        estimated_tokens: 50000,
        budget_tokens: 80000,
        system_prompt_tokens: 5000,
        tool_definition_tokens: 7000,
        context_window: 100000,
        reason: evot::types::CompactReason::Threshold,
        reserve_tokens: 0,
        trigger_threshold: 0,
        will_retry: false,
    });
    let item = stats.to_item();
    let decoded = TranscriptStats::try_from_item(&item);
    if let Some(TranscriptStats::ContextCompactionStarted(s)) = decoded {
        assert_eq!(s.message_count, 20);
        assert_eq!(s.estimated_tokens, 50000);
    } else {
        panic!("expected ContextCompactionStarted");
    }
}

#[test]
fn stats_context_compaction_completed_round_trip() {
    let stats = TranscriptStats::ContextCompactionCompleted(ContextCompactionCompletedStats {
        reason: evot::types::CompactReason::Threshold,
        result: evot::observability::CompactionResult::Compacted {
            before_message_count: 20,
            after_message_count: 8,
            before_tokens: 50000,
            after_tokens: 20000,
            messages_evicted: 12,
            current_run_reclaimed: 0,
            method: Some(CompactionMethod::RemoteFailedLocal),
            remote_blob_bytes: None,
            fallback_reason: Some("upstream rejected compaction item".into()),
        },
        context_window: 0,
        will_retry: false,
    });
    let item = stats.to_item();
    let decoded = TranscriptStats::try_from_item(&item);
    if let Some(TranscriptStats::ContextCompactionCompleted(s)) = decoded {
        match s.result {
            evot::observability::CompactionResult::Compacted {
                before_tokens,
                after_tokens,
                messages_evicted,
                method,
                remote_blob_bytes,
                fallback_reason,
                ..
            } => {
                assert_eq!(before_tokens, 50000);
                assert_eq!(after_tokens, 20000);
                assert_eq!(messages_evicted, 12);
                assert_eq!(method, Some(CompactionMethod::RemoteFailedLocal));
                assert_eq!(remote_blob_bytes, None);
                assert_eq!(
                    fallback_reason.as_deref(),
                    Some("upstream rejected compaction item")
                );
            }
            _ => panic!("expected Compacted"),
        }
    } else {
        panic!("expected ContextCompactionCompleted");
    }
}

#[test]
fn stats_run_finished_round_trip() {
    let stats = TranscriptStats::RunFinished(RunFinishedStats {
        usage: UsageSummary {
            input: 5000,
            output: 1000,
            cache_read: 200,
            cache_write: 50,
        },
        turn_count: 3,
        duration_ms: 12000,
        transcript_count: 15,
    });
    let item = stats.to_item();
    let decoded = TranscriptStats::try_from_item(&item);
    if let Some(TranscriptStats::RunFinished(s)) = decoded {
        assert_eq!(s.usage.input, 5000);
        assert_eq!(s.turn_count, 3);
        assert_eq!(s.duration_ms, 12000);
    } else {
        panic!("expected RunFinished");
    }
}

// ---------------------------------------------------------------------------
// try_from_item edge cases
// ---------------------------------------------------------------------------

#[test]
fn try_from_item_returns_none_for_non_stats() {
    let item = TranscriptItem::User {
        provenance: None,
        text: "hello".into(),
        content: vec![],
    };
    assert!(TranscriptStats::try_from_item(&item).is_none());
}

#[test]
fn try_from_item_returns_none_for_unknown_kind() {
    let item = TranscriptItem::Stats {
        kind: "unknown_future_kind".into(),
        data: serde_json::json!({"foo": "bar"}),
    };
    assert!(TranscriptStats::try_from_item(&item).is_none());
}

#[test]
fn try_from_item_returns_none_for_schema_mismatch() {
    let item = TranscriptItem::Stats {
        kind: "llm_call_started".into(),
        data: serde_json::json!({"wrong_field": true}),
    };
    assert!(TranscriptStats::try_from_item(&item).is_none());
}

// ---------------------------------------------------------------------------
// is_context_item
// ---------------------------------------------------------------------------

#[test]
fn stats_item_is_not_context() {
    let item = TranscriptStats::RunFinished(RunFinishedStats {
        usage: UsageSummary::default(),
        turn_count: 1,
        duration_ms: 100,
        transcript_count: 2,
    })
    .to_item();
    assert!(!item.is_context_item());
}

#[test]
fn user_item_is_context() {
    let item = TranscriptItem::User {
        provenance: None,
        text: "hello".into(),
        content: vec![],
    };
    assert!(item.is_context_item());
}

#[test]
fn compact_item_is_not_context() {
    let item = TranscriptItem::Compact {
        id: "compact".into(),
        created_at: 0,
        reason: evot::types::CompactReason::Manual,
        summary: "hi".into(),
        tokens_before: 10,
        tokens_after: 5,
        messages_before: 2,
        messages_after: 1,
        messages: vec![],
        engine_messages: vec![],
        state: Box::default(),
        details: evot::types::CompactDetails::default(),
    };
    assert!(!item.is_context_item());
}

// ---------------------------------------------------------------------------
// JSONL serialization stability
// ---------------------------------------------------------------------------

#[test]
fn stats_item_serializes_to_flat_jsonl() {
    let stats = TranscriptStats::ToolFinished(ToolFinishedStats {
        tool_call_id: "tc1".into(),
        tool_name: "bash".into(),
        result_tokens: 42,
        duration_ms: 100,
        is_error: false,
    });
    let item = stats.to_item();
    let json = serde_json::to_string(&item).expect("serialize");
    // Should contain type=stats and kind at top level
    assert!(json.contains(r#""type":"stats""#));
    assert!(json.contains(r#""kind":"tool_finished""#));
    // data should contain the tool fields
    assert!(json.contains(r#""tool_name":"bash""#));
}

#[test]
fn assistant_item_deserializes_pre_migration_content_blocks() {
    let json = r#"{"type":"assistant","content_blocks":[{"type":"thinking","text":"plan"},{"type":"text","text":"answer"}],"stop_reason":"stop","usage":{"input":0,"output":0,"cache_read":0,"cache_write":0},"model":"model","provider":"provider","timestamp":1}"#;
    let item: TranscriptItem = serde_json::from_str(json).expect("deserialize assistant line");

    assert!(matches!(
        item,
        TranscriptItem::Assistant { content, .. }
            if matches!(
                &content[..],
                [AssistantBlock::Thinking { text: plan, .. }, AssistantBlock::Text { text: answer }]
                    if plan == "plan" && answer == "answer"
            )
    ));
}

#[test]
fn assistant_item_uses_canonical_content_schema() {
    let json = r#"{"type":"assistant","content":[{"type":"text","text":"Let me analyze."},{"type":"tool_call","id":"tooluse_abc","name":"bash","input":{"command":"ls"}}],"stop_reason":"toolUse","usage":{"input":0,"output":0,"cache_read":0,"cache_write":0},"model":"model","provider":"provider","timestamp":1}"#;
    let item: TranscriptItem = serde_json::from_str(json).expect("deserialize assistant line");
    match item {
        TranscriptItem::Assistant {
            content,
            stop_reason,
            ..
        } => {
            assert_eq!(stop_reason, "toolUse");
            assert!(
                matches!(&content[0], AssistantBlock::Text { text } if text == "Let me analyze.")
            );
            assert!(matches!(&content[1], AssistantBlock::ToolCall { name, .. } if name == "bash"));
        }
        other => panic!("expected Assistant, got {other:?}"),
    }
}

#[test]
fn stats_item_deserializes_from_jsonl() {
    let json = r#"{"type":"stats","kind":"run_finished","data":{"usage":{"input":100,"output":50,"cache_read":0,"cache_write":0},"turn_count":2,"duration_ms":1500,"transcript_count":4}}"#;
    let item: TranscriptItem = serde_json::from_str(json).expect("deserialize");
    assert!(matches!(&item, TranscriptItem::Stats { kind, .. } if kind == "run_finished"));
    let decoded = TranscriptStats::try_from_item(&item);
    if let Some(TranscriptStats::RunFinished(s)) = decoded {
        assert_eq!(s.usage.input, 100);
        assert_eq!(s.turn_count, 2);
    } else {
        panic!("expected RunFinished");
    }
}

#[test]
fn user_content_round_trip_preserves_multimodal_order() {
    let item = TranscriptItem::user_from_content(&[
        evot_engine::Content::Text {
            text: "before".into(),
        },
        evot_engine::Content::Image {
            mime_type: "image/png".into(),
            source: evot_engine::ImageSource::Base64 {
                data: "img1".into(),
            },
        },
        evot_engine::Content::Text {
            text: "between".into(),
        },
        evot_engine::Content::Image {
            mime_type: "image/jpeg".into(),
            source: evot_engine::ImageSource::Base64 {
                data: "img2".into(),
            },
        },
    ]);

    let TranscriptItem::User { text, content, .. } = item else {
        panic!("expected user item");
    };
    assert_eq!(text, "before\nbetween");
    assert_eq!(content.len(), 4);
    assert!(matches!(&content[0], TranscriptUserContent::Text { text } if text == "before"));
    assert!(
        matches!(&content[1], TranscriptUserContent::Image { mime_type, source } if mime_type == "image/png" && matches!(source, TranscriptImageSource::Base64 { data, .. } if data == "img1"))
    );
    assert!(matches!(&content[2], TranscriptUserContent::Text { text } if text == "between"));
    assert!(
        matches!(&content[3], TranscriptUserContent::Image { mime_type, source } if mime_type == "image/jpeg" && matches!(source, TranscriptImageSource::Base64 { data, .. } if data == "img2"))
    );
}

#[test]
fn user_content_round_trip_preserves_image_source() {
    let item = TranscriptItem::user_from_content(&[evot_engine::Content::Image {
        mime_type: "image/png".into(),
        source: evot_engine::ImageSource::Path {
            path: "/tmp/image.png".into(),
        },
    }]);

    let TranscriptItem::User { content, .. } = item else {
        panic!("expected user item");
    };

    assert!(
        matches!(&content[0], TranscriptUserContent::Image { mime_type, source } if mime_type == "image/png" && matches!(source, TranscriptImageSource::Path { path } if path == "/tmp/image.png"))
    );
}

#[test]
fn user_item_without_content_deserializes_for_backward_compatibility() {
    let json = r#"{"type":"user","text":"hello"}"#;
    let item: TranscriptItem = serde_json::from_str(json).expect("deserialize");
    match item {
        TranscriptItem::User { text, content, .. } => {
            assert_eq!(text, "hello");
            assert!(content.is_empty());
        }
        _ => panic!("expected user item"),
    }
}

// ---------------------------------------------------------------------------
// ToolResult details persistence (plan artifact resume)
// ---------------------------------------------------------------------------

#[test]
fn tool_result_details_round_trip() {
    let item = TranscriptItem::ToolResult {
        tool_call_id: "call-1".into(),
        tool_name: "plan".into(),
        content: "Plan approved (2 tasks).".into(),
        is_error: false,
        details: serde_json::json!({
            "action": "propose",
            "approved": true,
            "goal": { "tasks": [{ "id": 1, "title": "Load data", "status": "completed" }] }
        }),
    };

    let json = serde_json::to_string(&item).expect("serialize");
    let back: TranscriptItem = serde_json::from_str(&json).expect("deserialize");
    match back {
        TranscriptItem::ToolResult { details, .. } => {
            assert_eq!(details["approved"], true);
            assert_eq!(details["goal"]["tasks"][0]["id"], 1);
        }
        _ => panic!("expected tool result"),
    }
}

#[test]
fn tool_result_without_details_deserializes_for_backward_compatibility() {
    // Transcripts written before the details field existed omit it entirely.
    let json = r#"{"type":"tool_result","tool_call_id":"c1","tool_name":"bash","content":"ok","is_error":false}"#;
    let item: TranscriptItem = serde_json::from_str(json).expect("deserialize");
    match item {
        TranscriptItem::ToolResult { details, .. } => assert!(details.is_null()),
        _ => panic!("expected tool result"),
    }
}

#[test]
fn tool_result_null_details_omitted_from_serialization() {
    let item = TranscriptItem::ToolResult {
        tool_call_id: "c1".into(),
        tool_name: "bash".into(),
        content: "ok".into(),
        is_error: false,
        details: serde_json::Value::Null,
    };
    let json = serde_json::to_string(&item).expect("serialize");
    assert!(
        !json.contains("details"),
        "null details should be skipped: {json}"
    );
}

// ---------------------------------------------------------------------------
// entry_preview
// ---------------------------------------------------------------------------

#[test]
fn entry_preview_short_text() {
    let item = TranscriptItem::User {
        provenance: None,
        text: "hello world".into(),
        content: vec![],
    };
    assert_eq!(entry_preview(&item), "hello world");
}

#[test]
fn entry_preview_truncates_long_text() {
    let long = "a".repeat(100);
    let item = TranscriptItem::User {
        provenance: None,
        text: long,
        content: vec![],
    };
    let preview = entry_preview(&item);
    assert!(preview.ends_with('…'));
    // 60 chars + ellipsis
    assert_eq!(preview.chars().count(), 61);
}

#[test]
fn entry_preview_chinese_does_not_panic() {
    // 80 Chinese characters — would panic on byte slicing
    let chinese = "你好世界".repeat(20);
    let item = TranscriptItem::User {
        provenance: None,
        text: chinese,
        content: vec![],
    };
    let preview = entry_preview(&item);
    assert!(preview.ends_with('…'));
    assert_eq!(preview.chars().count(), 61);
}

#[test]
fn entry_preview_exact_60_chars_no_ellipsis() {
    let exact = "x".repeat(60);
    let item = TranscriptItem::Assistant {
        content: vec![AssistantBlock::Text { text: exact }],
        stop_reason: "stop".into(),
        usage: UsageSummary::default(),
        model: String::new(),
        provider: String::new(),
        timestamp: 0,
        error_message: None,
    };
    let preview = entry_preview(&item);
    assert!(!preview.ends_with('…'));
    assert_eq!(preview.chars().count(), 60);
}

#[test]
fn entry_preview_non_context_item_returns_empty() {
    let item = TranscriptItem::Stats {
        kind: "test".into(),
        data: serde_json::json!({}),
    };
    assert_eq!(entry_preview(&item), "");
}
