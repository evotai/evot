//! Tests for the local token approximation used by compaction.
//! The expected values mirror pi's `Math.ceil(string.length / 4)`, where
//! JavaScript `string.length` counts UTF-16 code units.

use evotengine::context::content_tokens;
use evotengine::context::estimate_tokens;
use evotengine::context::message_tokens;
use evotengine::types::AgentMessage;
use evotengine::types::Content;
use evotengine::types::ImageSource;
use evotengine::types::Message;
use evotengine::types::Retention;

#[test]
fn text_uses_utf16_code_units_like_javascript() {
    assert_eq!(estimate_tokens("abcd"), 1);
    assert_eq!(estimate_tokens("abcde"), 2);

    // Four BMP characters are four JavaScript string units, not 12 UTF-8 bytes.
    assert_eq!(estimate_tokens("中文测试"), 1);

    // Each supplementary-plane emoji occupies a UTF-16 surrogate pair.
    assert_eq!(estimate_tokens("😀😀"), 1);
    assert_eq!(estimate_tokens("😀😀😀"), 2);
}

#[test]
fn message_content_is_summed_before_rounding() {
    let message = AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![
            Content::Text { text: "a".into() },
            Content::Text { text: "b".into() },
            Content::Text { text: "c".into() },
            Content::Text { text: "d".into() },
        ],
        timestamp: 0,
    });

    assert_eq!(message_tokens(&message), 1);
}

#[test]
fn message_roles_add_no_synthetic_overhead() {
    let user = AgentMessage::Llm(Message::user("a"));
    let tool_result = AgentMessage::Llm(Message::ToolResult {
        tool_call_id: "call".into(),
        tool_name: "a-very-long-tool-name-that-pi-does-not-count".into(),
        content: vec![Content::Text { text: "a".into() }],
        is_error: false,
        timestamp: 0,
        retention: Retention::Normal,
    });

    assert_eq!(message_tokens(&user), 1);
    assert_eq!(message_tokens(&tool_result), 1);
}

#[test]
fn image_matches_pis_4800_character_estimate() {
    let content = vec![Content::Image {
        mime_type: "image/png".into(),
        source: ImageSource::Base64 {
            data: "ignored".into(),
        },
    }];

    assert_eq!(content_tokens(&content), 1_200);
}

#[test]
fn tool_call_has_no_fixed_token_surcharge() {
    let content = vec![Content::ToolCall {
        id: "call".into(),
        name: "x".into(),
        arguments: serde_json::json!({}),
        metadata: None,
    }];

    // "x" + "{}" = 3 UTF-16 units, rounded once.
    assert_eq!(content_tokens(&content), 1);
}
