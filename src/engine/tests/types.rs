//! Serde round-trip tests for core types.

use evotengine::*;

fn roundtrip<T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug>(
    value: &T,
) {
    let json = serde_json::to_string(value).expect("serialize");
    let back: T = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(*value, back);
}

// ---------------------------------------------------------------------------
// Message variants
// ---------------------------------------------------------------------------

#[test]
fn test_message_user_roundtrip() {
    let msg = Message::User {
        content: vec![Content::Text {
            text: "Hello".into(),
        }],
        timestamp: 123456,
    };
    roundtrip(&msg);
}

#[test]
fn test_message_assistant_roundtrip() {
    let msg = Message::Assistant {
        content: vec![
            Content::Text {
                text: "Hi there".into(),
            },
            Content::ToolCall {
                id: "tc-1".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "foo.rs"}),
                metadata: None,
            },
        ],
        stop_reason: StopReason::ToolUse,
        model: "claude-sonnet".into(),
        provider: "anthropic".into(),
        usage: Usage {
            input: 100,
            output: 50,
            cache_read: 10,
            cache_write: 5,
            total_tokens: 165,
            reasoning_output: 0,
        },
        timestamp: 789,
        error_message: None,
        response_id: None,
    };
    roundtrip(&msg);
}

#[test]
fn test_message_tool_result_roundtrip() {
    let msg = Message::ToolResult {
        tool_call_id: "tc-1".into(),
        tool_name: "bash".into(),
        content: vec![Content::Text {
            text: "exit code 0".into(),
        }],
        is_error: false,
        timestamp: 999,
        retention: Retention::Normal,
    };
    roundtrip(&msg);
}

// ---------------------------------------------------------------------------
// AgentMessage
// ---------------------------------------------------------------------------

#[test]
fn test_agent_message_roundtrip() {
    let am = AgentMessage::Llm(Message::user("test prompt"));
    roundtrip(&am);
}

#[test]
fn test_extension_message_roundtrip() {
    let ext = ExtensionMessage::new("status_update", serde_json::json!({"status": "running"}));
    roundtrip(&ext);

    let am = AgentMessage::Extension(ext);
    roundtrip(&am);
}

// ---------------------------------------------------------------------------
// Content variants
// ---------------------------------------------------------------------------

#[test]
fn test_content_variants_roundtrip() {
    roundtrip(&Content::Text {
        text: "hello".into(),
    });
    roundtrip(&Content::Image {
        mime_type: "image/png".into(),
        source: ImageSource::Base64 {
            data: "base64data".into(),
        },
    });
    roundtrip(&Content::Thinking {
        thinking: "let me think...".into(),
        metadata: Some(ThinkingMetadata::Anthropic {
            signature: "sig123".into(),
        }),
    });
    roundtrip(&Content::ToolCall {
        id: "tc-1".into(),
        name: "bash".into(),
        arguments: serde_json::json!({"command": "ls"}),
        metadata: None,
    });
}

// ---------------------------------------------------------------------------
// Full conversation
// ---------------------------------------------------------------------------

#[test]
fn test_full_conversation_roundtrip() {
    let conversation: Vec<AgentMessage> = vec![
        AgentMessage::Llm(Message::user("Read the file")),
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "tc-1".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "main.rs"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "mock".into(),
            provider: "mock".into(),
            usage: Usage::default(),
            timestamp: 100,
            error_message: None,
            response_id: None,
        }),
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "tc-1".into(),
            tool_name: "read".into(),
            content: vec![Content::Text {
                text: "fn main() {}".into(),
            }],
            is_error: false,
            timestamp: 200,
            retention: Retention::Normal,
        }),
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::Text {
                text: "The file contains a main function.".into(),
            }],
            stop_reason: StopReason::Stop,
            model: "mock".into(),
            provider: "mock".into(),
            usage: Usage::default(),
            timestamp: 300,
            error_message: None,
            response_id: None,
        }),
        AgentMessage::Extension(ExtensionMessage::new(
            "ui_event",
            serde_json::json!({"action": "scroll"}),
        )),
    ];

    let json = serde_json::to_string(&conversation).expect("serialize");
    let back: Vec<AgentMessage> = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(conversation, back);
}

#[test]
fn legacy_responses_tool_identity_migration_updates_call_and_result() {
    let mut messages = vec![
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "call-1|fc-1".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "a"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "gpt-5.5".into(),
            provider: "openai".into(),
            usage: Usage::default(),
            timestamp: 1,
            error_message: None,
            response_id: None,
        }),
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "call-1|fc-1".into(),
            tool_name: "read".into(),
            content: vec![Content::Text { text: "ok".into() }],
            is_error: false,
            timestamp: 2,
            retention: Retention::Normal,
        }),
    ];

    migrate_legacy_responses_tool_ids(&mut messages);

    assert!(matches!(
        &messages[..],
        [
            AgentMessage::Llm(Message::Assistant { content, .. }),
            AgentMessage::Llm(Message::ToolResult { tool_call_id, .. }),
        ] if matches!(&content[..], [Content::ToolCall {
            id,
            metadata: Some(ToolCallMetadata::OpenAiResponses { item_id }),
            ..
        }] if id == "call-1" && item_id == "fc-1") && tool_call_id == "call-1"
    ));
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

#[test]
fn legacy_responses_tool_identity_migration_preserves_unrelated_pipe_ids() {
    let mut messages = vec![
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "vendor|token".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "a"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "custom".into(),
            provider: "custom".into(),
            usage: Usage::default(),
            timestamp: 1,
            error_message: None,
            response_id: None,
        }),
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "vendor|token".into(),
            tool_name: "read".into(),
            content: vec![Content::Text { text: "ok".into() }],
            is_error: false,
            timestamp: 2,
            retention: Retention::Normal,
        }),
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "orphan|fc_1".into(),
            tool_name: "read".into(),
            content: vec![Content::Text {
                text: "orphan".into(),
            }],
            is_error: false,
            timestamp: 3,
            retention: Retention::Normal,
        }),
    ];

    migrate_legacy_responses_tool_ids(&mut messages);

    assert!(matches!(
        &messages[..],
        [
            AgentMessage::Llm(Message::Assistant { content, .. }),
            AgentMessage::Llm(Message::ToolResult { tool_call_id, .. }),
            AgentMessage::Llm(Message::ToolResult {
                tool_call_id: orphan_id,
                ..
            }),
        ] if matches!(&content[..], [Content::ToolCall {
            id,
            metadata: None,
            ..
        }] if id == "vendor|token")
            && tool_call_id == "vendor|token"
            && orphan_id == "orphan|fc_1"
    ));
}

#[test]
fn test_execution_limits_roundtrip() {
    use evotengine::context::ExecutionLimits;
    let limits = ExecutionLimits {
        max_turns: 25,
        max_total_tokens: 500_000,
        max_duration: std::time::Duration::from_secs(300),
    };
    let json = serde_json::to_string(&limits).expect("serialize");
    let back: ExecutionLimits = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(limits.max_turns, back.max_turns);
    assert_eq!(limits.max_total_tokens, back.max_total_tokens);
    assert_eq!(limits.max_duration, back.max_duration);
}

#[test]
fn test_tool_execution_strategy_roundtrip() {
    roundtrip(&ToolExecutionStrategy::Sequential);
    roundtrip(&ToolExecutionStrategy::Parallel);
    roundtrip(&ToolExecutionStrategy::Batched { size: 4 });
}

/// Whatever an image block declares, the provider is sent the type its bytes
/// are. Blocks come from the read tool, chat channels and attachments, each
/// naming a type from a file name or a sender's header, and Anthropic rejects
/// a request whose declared type disagrees with the data.
#[test]
fn resolve_image_data_sends_the_type_the_bytes_are() {
    use base64::Engine;
    let jpeg = [
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ];
    let b64 = base64::engine::general_purpose::STANDARD.encode(jpeg);

    let declared_png = Content::Image {
        mime_type: "image/png".into(),
        source: ImageSource::Base64 { data: b64.clone() },
    };
    assert_eq!(declared_png.resolve_image_data().unwrap().1, "image/jpeg");

    let tmp = std::env::temp_dir().join("evot-resolve-really-jpeg.png");
    std::fs::write(&tmp, jpeg).unwrap();
    let from_path = Content::Image {
        mime_type: "image/png".into(),
        source: ImageSource::Path {
            path: tmp.to_string_lossy().into(),
        },
    };
    let (data, mime) = from_path.resolve_image_data().unwrap();
    let _ = std::fs::remove_file(tmp);
    assert_eq!(mime, "image/jpeg");
    assert_eq!(data, b64);

    // Bytes nobody recognises keep the declared type: not our call to make.
    let unknown = Content::Image {
        mime_type: "image/heic".into(),
        source: ImageSource::Base64 {
            data: base64::engine::general_purpose::STANDARD.encode(b"????"),
        },
    };
    assert_eq!(unknown.resolve_image_data().unwrap().1, "image/heic");
}
