use evot::surface::delivery::MessageSink;
use evot::surface::gateway::channels::feishu::delivery::FeishuMessageSink;
use evot::surface::gateway::channels::feishu::token::TokenCache;

fn make_sink() -> FeishuMessageSink {
    FeishuMessageSink::new(
        reqwest::Client::new(),
        TokenCache::new(),
        "fake_app_id".into(),
        "fake_app_secret".into(),
    )
}

#[test]
fn test_with_reply_to_sets_state() {
    let sink = make_sink();
    assert!(!sink.has_reply_to());

    let sink = sink.with_reply_to("om_msg_123".into());
    assert!(sink.has_reply_to());
}

#[test]
fn test_no_reply_to_by_default() {
    let sink = make_sink();
    assert!(!sink.has_reply_to());
}

#[tokio::test]
async fn test_reply_to_retained_on_failure() {
    // reply_text will fail because app_id/app_secret are fake — token fetch fails.
    // After failure, reply_to should still be set.
    let sink = make_sink().with_reply_to("om_msg_456".into());
    assert!(sink.has_reply_to());

    let result = sink.send_text("oc_chat_001", "hello").await;
    assert!(result.is_err());
    assert!(
        sink.has_reply_to(),
        "reply_to should be retained after failure"
    );
}

#[tokio::test]
async fn test_no_reply_to_falls_through_to_send() {
    // Without reply_to, send_text tries the normal send path (which also fails
    // with fake credentials, but we verify it doesn't panic).
    let sink = make_sink();
    let result = sink.send_text("oc_chat_001", "hello").await;
    assert!(result.is_err());
    assert!(!sink.has_reply_to());
}
