use std::time::Duration;

use evot::conf::FeishuChannelConfig;
use evot::surface::gateway::channels::feishu::message::parse_event;
use evot::surface::gateway::channels::feishu::message::MessageDedup;
use evot::surface::gateway::channels::feishu::message::MessagePart;

fn default_config() -> FeishuChannelConfig {
    FeishuChannelConfig {
        app_id: "app_id".into(),
        app_secret: "app_secret".into(),
        mention_only: false,
        allow_from: vec![],
        default_chat_id: String::new(),
    }
}

fn make_event(extra_message_fields: serde_json::Value) -> serde_json::Value {
    let mut message = serde_json::json!({
        "message_id": "om_test_001",
        "chat_id": "oc_chat_001",
        "chat_type": "p2p",
        "message_type": "text",
        "content": r#"{"text":"hello"}"#,
    });
    if let (Some(base), Some(extra)) = (message.as_object_mut(), extra_message_fields.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    serde_json::json!({
        "header": { "event_type": "im.message.receive_v1" },
        "event": {
            "sender": { "sender_id": { "open_id": "ou_sender_001" } },
            "message": message,
        }
    })
}

// ── parent_id extraction ──

#[test]
fn test_parse_event_extracts_parent_id() {
    let event = make_event(serde_json::json!({ "parent_id": "om_parent_123" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let parsed = parse_event(&event, &config, "bot_id", &mut dedup);
    assert!(parsed.is_some());
    let msg = parsed.unwrap();
    assert_eq!(msg.parent_id, Some("om_parent_123".to_string()));
}

#[test]
fn test_parse_event_no_parent_id() {
    let event = make_event(serde_json::json!({}));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let parsed = parse_event(&event, &config, "bot_id", &mut dedup);
    assert!(parsed.is_some());
    assert_eq!(parsed.unwrap().parent_id, None);
}

#[test]
fn test_parse_event_empty_parent_id() {
    let event = make_event(serde_json::json!({ "parent_id": "" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let parsed = parse_event(&event, &config, "bot_id", &mut dedup);
    assert!(parsed.is_some());
    assert_eq!(parsed.unwrap().parent_id, None);
}

// ── image message type ──

#[test]
fn test_parse_event_image_message() {
    let event = make_event(serde_json::json!({
        "message_type": "image",
        "content": r#"{"image_key":"img_v2_abc123"}"#,
    }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let parsed = parse_event(&event, &config, "bot_id", &mut dedup);
    assert!(parsed.is_some());
    let msg = parsed.unwrap();
    assert!(matches!(
        msg.parts.as_slice(),
        [MessagePart::ImageKey(key)] if key == "img_v2_abc123"
    ));
    assert!(msg.text.is_empty());
}

#[test]
fn test_parse_event_image_message_empty_key() {
    let event = make_event(serde_json::json!({
        "message_type": "image",
        "content": r#"{"image_key":""}"#,
    }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let parsed = parse_event(&event, &config, "bot_id", &mut dedup);
    assert!(parsed.is_none());
}

// ── post with images ──

#[test]
fn test_parse_post_extracts_image_keys() {
    let content = serde_json::json!({
        "content": [
            [
                { "tag": "text", "text": "Check this image" },
                { "tag": "img", "image_key": "img_v2_key1" }
            ],
            [
                { "tag": "img", "image_key": "img_v2_key2" }
            ]
        ]
    });
    let result = evot::surface::gateway::channels::feishu::message::parse_post(&content);
    assert!(result.is_some());
    let post = result.unwrap();
    assert!(post.text.contains("Check this image"));
    assert!(matches!(
        post.parts.as_slice(),
        [MessagePart::Text(_), MessagePart::ImageKey(k1), MessagePart::ImageKey(k2)]
        if k1 == "img_v2_key1" && k2 == "img_v2_key2"
    ));
}

#[test]
fn test_parse_post_image_only() {
    let content = serde_json::json!({
        "content": [
            [
                { "tag": "img", "image_key": "img_v2_only" }
            ]
        ]
    });
    let result = evot::surface::gateway::channels::feishu::message::parse_post(&content);
    assert!(result.is_some());
    let post = result.unwrap();
    assert!(post.text.is_empty());
    assert!(matches!(
        post.parts.as_slice(),
        [MessagePart::ImageKey(key)] if key == "img_v2_only"
    ));
}

#[test]
fn test_parse_event_post_with_image() {
    let post_content = serde_json::json!({
        "content": [
            [
                { "tag": "text", "text": "Look at this" },
                { "tag": "img", "image_key": "img_v2_post" }
            ]
        ]
    });
    let event = make_event(serde_json::json!({
        "message_type": "post",
        "content": post_content.to_string(),
    }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let parsed = parse_event(&event, &config, "bot_id", &mut dedup);
    assert!(parsed.is_some());
    let msg = parsed.unwrap();
    assert!(msg.text.contains("Look at this"));
    assert!(matches!(
        msg.parts.as_slice(),
        [MessagePart::Text(text), MessagePart::ImageKey(key)]
        if text == "Look at this" && key == "img_v2_post"
    ));
}

#[test]
fn test_parse_post_preserves_text_image_order() {
    let content = serde_json::json!({
        "content": [
            [
                { "tag": "text", "text": "before" },
                { "tag": "img", "image_key": "img_v2_a" },
                { "tag": "text", "text": "after" }
            ]
        ]
    });
    let result = evot::surface::gateway::channels::feishu::message::parse_post(&content);
    let post = result.expect("post");
    assert!(matches!(
        post.parts.as_slice(),
        [MessagePart::Text(a), MessagePart::ImageKey(k), MessagePart::Text(b)]
        if a == "before" && k == "img_v2_a" && b == "after"
    ));
}

#[test]
fn test_parse_post_extracts_text() {
    let content = serde_json::json!({
        "title": "Title",
        "content": [
            [
                { "tag": "text", "text": "Hello " },
                { "tag": "text", "text": "world" }
            ]
        ]
    });
    let result = evot::surface::gateway::channels::feishu::message::parse_post(&content);
    assert!(result.is_some());
    let post = result.unwrap();
    assert!(post.text.contains("Hello"));
    assert!(post.text.contains("world"));
    assert!(post.text.contains("Title"));
}

#[test]
fn test_parse_post_empty_content() {
    let content = serde_json::json!({ "content": [] });
    let result = evot::surface::gateway::channels::feishu::message::parse_post(&content);
    assert!(result.is_none());
}

// ── chat_type extraction ──

#[test]
fn test_parse_event_chat_type_p2p() {
    let event = make_event(serde_json::json!({}));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.chat_type, "p2p");
}

#[test]
fn test_parse_event_chat_type_group() {
    let event = make_event(serde_json::json!({ "chat_type": "group" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.chat_type, "group");
}

// ── create_time extraction ──

#[test]
fn test_parse_event_extracts_create_time() {
    let event = make_event(serde_json::json!({ "create_time": "1700000000000" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.create_time, 1700000000000);
}

#[test]
fn test_parse_event_missing_create_time_defaults_to_zero() {
    let event = make_event(serde_json::json!({}));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.create_time, 0);
}

// ── thread_id extraction ──

#[test]
fn test_parse_event_extracts_thread_id() {
    let event = make_event(serde_json::json!({ "thread_id": "omt_16f3c7e1268f1749" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.thread_id, Some("omt_16f3c7e1268f1749".to_string()));
}

#[test]
fn test_parse_event_no_thread_id() {
    let event = make_event(serde_json::json!({}));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.thread_id, None);
}

#[test]
fn test_parse_event_empty_thread_id() {
    let event = make_event(serde_json::json!({ "thread_id": "" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.thread_id, None);
}

// ── extract_thread_message ──

use evot::surface::gateway::channels::feishu::delivery::extract_thread_message;

fn make_thread_item(
    msg_id: &str,
    msg_type: &str,
    content: &str,
    create_time: &str,
) -> serde_json::Value {
    serde_json::json!({
        "message_id": msg_id,
        "msg_type": msg_type,
        "create_time": create_time,
        "sender": { "id": "ou_sender_001" },
        "body": { "content": content },
    })
}

#[test]
fn test_extract_thread_message_text() {
    let item = make_thread_item("om_1", "text", r#"{"text":"hello world"}"#, "1700000000000");
    let msg = extract_thread_message(&item).expect("should parse");
    assert_eq!(msg.message_id, "om_1");
    assert_eq!(msg.text, Some("hello world".to_string()));
    assert_eq!(msg.create_time, 1700000000000);
    assert_eq!(msg.sender_id, Some("ou_sender_001".to_string()));
}

#[test]
fn test_extract_thread_message_post() {
    let post = serde_json::json!({
        "title": "My Title",
        "content": [[{ "tag": "text", "text": "body text" }]]
    });
    let item = make_thread_item("om_2", "post", &post.to_string(), "1700000001000");
    let msg = extract_thread_message(&item).expect("should parse");
    assert!(msg
        .text
        .as_ref()
        .is_some_and(|t| t.contains("My Title") && t.contains("body text")));
}

#[test]
fn test_extract_thread_message_image() {
    let item = make_thread_item(
        "om_3",
        "image",
        r#"{"image_key":"img_v2_abc"}"#,
        "1700000002000",
    );
    let msg = extract_thread_message(&item).expect("should parse");
    assert!(msg.text.is_none());
    assert!(matches!(
        msg.parts.as_slice(),
        [MessagePart::ImageKey(key)] if key == "img_v2_abc"
    ));
}

#[test]
fn test_extract_thread_message_empty_text_returns_none() {
    let item = make_thread_item("om_4", "text", r#"{"text":""}"#, "1700000003000");
    assert!(extract_thread_message(&item).is_none());
}

#[test]
fn test_extract_thread_message_unsupported_type_returns_none() {
    let item = make_thread_item("om_5", "sticker", r#"{}"#, "1700000004000");
    assert!(extract_thread_message(&item).is_none());
}

#[test]
fn test_extract_thread_message_missing_create_time_defaults_to_zero() {
    let item = serde_json::json!({
        "message_id": "om_6",
        "msg_type": "text",
        "sender": { "id": "ou_sender_001" },
        "body": { "content": r#"{"text":"no time"}"# },
    });
    let msg = extract_thread_message(&item).expect("should parse");
    assert_eq!(msg.create_time, 0);
}

// ── root_id extraction ──

#[test]
fn test_parse_event_extracts_root_id() {
    let event = make_event(serde_json::json!({ "root_id": "om_root_123" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.root_id, Some("om_root_123".to_string()));
}

#[test]
fn test_parse_event_no_root_id() {
    let event = make_event(serde_json::json!({}));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.root_id, None);
}

#[test]
fn test_parse_event_empty_root_id() {
    let event = make_event(serde_json::json!({ "root_id": "" }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.root_id, None);
}

// ── extract_thread_message root_id ──

#[test]
fn test_extract_thread_message_extracts_root_id() {
    let item = serde_json::json!({
        "message_id": "om_7",
        "msg_type": "text",
        "create_time": "1700000005000",
        "root_id": "om_root_456",
        "sender": { "id": "ou_sender_001" },
        "body": { "content": r#"{"text":"reply in topic"}"# },
    });
    let msg = extract_thread_message(&item).expect("should parse");
    assert_eq!(msg.root_id, Some("om_root_456".to_string()));
}

#[test]
fn test_extract_thread_message_no_root_id() {
    let item = make_thread_item("om_8", "text", r#"{"text":"no root"}"#, "1700000006000");
    let msg = extract_thread_message(&item).expect("should parse");
    assert_eq!(msg.root_id, None);
}

// ── topic message detection: thread_id, parent_id, root_id combinations ──

#[test]
fn test_parse_event_topic_reply_with_all_ids() {
    let event = make_event(serde_json::json!({
        "parent_id": "om_parent_1",
        "root_id": "om_root_1",
        "thread_id": "omt_thread_1",
        "create_time": "1700000007000"
    }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.parent_id, Some("om_parent_1".to_string()));
    assert_eq!(msg.root_id, Some("om_root_1".to_string()));
    assert_eq!(msg.thread_id, Some("omt_thread_1".to_string()));
}

#[test]
fn test_parse_event_topic_reply_without_thread_id() {
    // This is the fallback scenario: topic reply has parent_id and root_id but no thread_id
    let event = make_event(serde_json::json!({
        "parent_id": "om_parent_2",
        "root_id": "om_root_2",
        "create_time": "1700000008000"
    }));
    let config = default_config();
    let mut dedup = MessageDedup::new(Duration::from_secs(60));

    let msg = parse_event(&event, &config, "bot_id", &mut dedup).expect("should parse");
    assert_eq!(msg.parent_id, Some("om_parent_2".to_string()));
    assert_eq!(msg.root_id, Some("om_root_2".to_string()));
    assert_eq!(msg.thread_id, None);
    // This message should still enter the topic branch (parent_id is Some)
    assert!(msg.parent_id.is_some() || msg.thread_id.is_some());
}
