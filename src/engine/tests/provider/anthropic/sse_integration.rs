//! Integration tests: Anthropic provider → wiremock SSE server → Message.

use evotengine::provider::AnthropicProvider;
use evotengine::provider::StreamEvent;
use evotengine::types::*;

use super::super::fixtures::mock_server::*;
use super::super::fixtures::sse::anthropic as anthropic_sse;
use super::super::fixtures::stream_config::*;

// ---------------------------------------------------------------------------
// SSE streaming — text response
// ---------------------------------------------------------------------------

#[tokio::test]
async fn bounded_anthropic_preserves_terminal_and_delta_order(
) -> Result<(), Box<dyn std::error::Error>> {
    let body = anthropic_sse::body(vec![
        anthropic_sse::message_start(10, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "one"),
        anthropic_sse::text_delta(0, "two"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("end_turn", 2),
        anthropic_sse::message_stop(),
    ]);
    let (_, events) = run_provider_sse_bounded(
        &AnthropicProvider,
        StreamConfigBuilder::anthropic().build(),
        &body,
    )
    .await?;
    let deltas: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, vec!["one", "two"]);
    assert!(matches!(events.last(), Some(StreamEvent::Done { .. })));
    Ok(())
}

#[tokio::test]
async fn anthropic_sse_text_response() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "Hello, "),
        anthropic_sse::text_delta(0, "world!"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("end_turn", 10),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, events) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant {
            content,
            stop_reason,
            usage,
            ..
        } => {
            assert_eq!(content.len(), 1);
            assert!(matches!(&content[0], Content::Text { text } if text == "Hello, world!"));
            assert_eq!(*stop_reason, StopReason::Stop);
            assert_eq!(usage.input, 100);
            assert_eq!(usage.output, 10);
        }
        _ => panic!("Expected Assistant message"),
    }

    assert!(events.iter().any(|e| matches!(e, StreamEvent::Start)));
    let text_deltas: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text_deltas, vec!["Hello, ", "world!"]);
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Done { .. })));
}

#[tokio::test]
async fn anthropic_request_sends_session_id_header() {
    // llmproxy groups requests into conversations via x-session-id. The
    // Anthropic provider must forward StreamConfig.prompt_cache_key (the
    // session id) as that header — the mock only matches when it is present.
    use evotengine::provider::StreamProvider;
    use wiremock::matchers::header;
    use wiremock::matchers::method;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;

    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(10, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "ok"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("end_turn", 1),
        anthropic_sse::message_stop(),
    ]);
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(header("x-session-id", "session-123"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let model_config = resolved_model_config(
        evotengine::provider::ApiProtocol::AnthropicMessages,
        "anthropic",
        "test-model",
        &server.uri(),
        None,
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::anthropic()
        .model_config(model_config)
        .prompt_cache_key("session-123")
        .cache_disabled()
        .build();

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let cancel = tokio_util::sync::CancellationToken::new();
    let outcome = AnthropicProvider.stream(config, tx, cancel).await;
    assert!(
        outcome.is_ok(),
        "mock requires x-session-id header; missing header fails the request: {outcome:?}"
    );
}

#[tokio::test]
async fn anthropic_sse_preserves_configured_provider_identity() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "Hello"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("end_turn", 1),
        anthropic_sse::message_stop(),
    ]);
    let model_config = resolved_model_config(
        evotengine::provider::ApiProtocol::AnthropicMessages,
        "kimi-coding",
        "kimi-for-coding",
        "https://api.kimi.com/coding",
        None,
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::anthropic()
        .model("kimi-for-coding")
        .model_config(model_config)
        .cache_disabled()
        .build();

    let (msg, _) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    assert!(matches!(
        msg,
        Message::Assistant { provider, .. } if provider == "kimi-coding"
    ));
}

#[tokio::test]
async fn anthropic_sse_stream_without_message_stop_errors() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "partial `"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("end_turn", 3),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse_outcome(&AnthropicProvider, config, &sse, 200).await;
    let Err(err) = result else {
        panic!("Expected interrupted stream error");
    };
    assert!(matches!(
        err,
        evotengine::provider::ProviderError::ProtocolIncomplete(ref message)
            if message.contains("message_stop")
    ));
    assert!(evotengine::retry::should_retry(&err));
}

#[tokio::test]
async fn anthropic_sse_heartbeat_only_is_protocol_incomplete() {
    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse(&AnthropicProvider, config, ": heartbeat\n\n", 200).await;
    let Err(error) = result else {
        panic!("Expected incomplete protocol error");
    };

    assert!(matches!(
        error,
        evotengine::provider::ProviderError::ProtocolIncomplete(ref message)
            if message.contains("message_start/message_stop")
    ));
    assert!(evotengine::retry::should_retry(&error));
}

#[tokio::test]
async fn anthropic_sse_ignores_unknown_fallback_block() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        // A server-side `fallback` block (unknown type) arrives before the
        // real text block. It must be ignored, not abort the stream.
        anthropic_sse::fallback_block_start(0),
        anthropic_sse::block_stop(0),
        anthropic_sse::text_block_start(1),
        anthropic_sse::text_delta(1, "Hello"),
        anthropic_sse::block_stop(1),
        anthropic_sse::message_delta("end_turn", 5),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (outcome, _events) = run_provider_sse_outcome(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();
    let msg = outcome.message();

    match msg {
        Message::Assistant {
            content,
            stop_reason,
            model,
            ..
        } => {
            assert!(
                content
                    .iter()
                    .any(|c| matches!(c, Content::Text { text } if text == "Hello")),
                "expected the real text block to survive the ignored fallback block"
            );
            assert_eq!(*stop_reason, StopReason::Stop);
            assert_eq!(model, "claude-sonnet-4-20250514");
            assert_eq!(outcome.served_model(), Some("claude-opus-4-8"));
        }
        _ => panic!("Expected Assistant message"),
    }
}

#[tokio::test]
async fn anthropic_sse_fallback_block_before_tool_use_keeps_single_tool_call() {
    // A fallback block at index 0 followed by a tool_use at index 1 must not
    // duplicate the tool call while gap-filling.
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::fallback_block_start(0),
        anthropic_sse::block_stop(0),
        anthropic_sse::tool_block_start(1, "toolu_1", "read"),
        anthropic_sse::tool_input_delta(1, r#"{"path":"foo.rs"}"#),
        anthropic_sse::block_stop(1),
        anthropic_sse::message_delta("tool_use", 5),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, _events) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant { content, .. } => {
            let tool_calls: Vec<_> = content
                .iter()
                .filter(|c| matches!(c, Content::ToolCall { .. }))
                .collect();
            assert_eq!(
                tool_calls.len(),
                1,
                "gap-filling must not clone the tool_use block: {content:?}"
            );
        }
        _ => panic!("Expected Assistant message"),
    }
}

#[tokio::test]
async fn anthropic_sse_max_tokens_maps_to_length() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "partial"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("max_tokens", 3),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse(&AnthropicProvider, config, &sse, 200).await;
    let Ok((msg, _events)) = result else {
        panic!("Expected successful length response");
    };

    match &msg {
        Message::Assistant { stop_reason, .. } => {
            assert_eq!(*stop_reason, StopReason::Length);
        }
        _ => panic!("Expected Assistant message"),
    }
}

#[tokio::test]
async fn anthropic_sse_malformed_known_event_errors() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "Hello"),
        anthropic_sse::block_stop(0),
        "event: message_delta\ndata: {bad json".to_string(),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse_outcome(&AnthropicProvider, config, &sse, 200).await;
    let Err(err) = result else {
        panic!("Expected malformed SSE event error");
    };
    assert!(err
        .to_string()
        .contains("Could not parse Anthropic SSE event"));
}

#[tokio::test]
async fn anthropic_sse_unknown_stop_reason_errors() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "Hello"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("new_reason", 3),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse_outcome(&AnthropicProvider, config, &sse, 200).await;
    let Err(err) = result else {
        panic!("Expected unknown stop reason error");
    };
    assert!(err.to_string().contains("Unhandled Anthropic stop reason"));
}

// A `refusal`/`sensitive` stop reason must surface as StopReason::Error with
// a descriptive error_message — not a bare error the TUI renders as
// "Unknown error".
#[tokio::test]
async fn anthropic_sse_refusal_stop_reason_carries_error_message() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "I"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("refusal", 9),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, _events) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant {
            stop_reason,
            error_message,
            ..
        } => {
            assert_eq!(*stop_reason, StopReason::Error);
            let err = error_message.as_deref().expect("error_message must be set");
            assert!(err.contains("refusal"), "got: {err}");
        }
        _ => panic!("Expected Assistant message"),
    }
}

#[tokio::test]
async fn anthropic_refusal_category_survives_sse_and_json_decoding(
) -> Result<(), Box<dyn std::error::Error>> {
    let details = serde_json::json!({
        "type": "refusal", "category": "reasoning_extraction",
        "explanation": "free-form provider explanation",
    });
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        format!(
            "event: message_delta\ndata: {}",
            serde_json::json!({
                "type": "message_delta",
                "delta": {"stop_reason": "refusal", "stop_details": details},
                "usage": {"output_tokens": 0},
            })
        ),
        anthropic_sse::message_stop(),
    ]);
    let (message, _) = run_provider_sse(
        &AnthropicProvider,
        StreamConfigBuilder::anthropic().build(),
        &sse,
        200,
    )
    .await?;
    let Message::Assistant {
        stop_reason,
        error_message: Some(error),
        ..
    } = message
    else {
        panic!("expected refusal with an error message");
    };
    assert_eq!(stop_reason, StopReason::Error);
    assert!(error.contains("category=reasoning_extraction"));
    assert!(evotengine::provider::error::is_refusal_message(&error));
    assert!(!error.contains("free-form provider explanation"));

    let json = serde_json::json!({
        "type": "message", "role": "assistant", "content": [],
        "stop_reason": "refusal", "stop_details": details,
        "usage": {"input_tokens": 100, "output_tokens": 0},
    });
    let Err(error) = run_provider_json(
        &AnthropicProvider,
        StreamConfigBuilder::anthropic().build(),
        &json.to_string(),
        200,
    )
    .await
    else {
        panic!("expected JSON refusal");
    };
    assert!(error.to_string().contains("category=reasoning_extraction"));
    assert!(evotengine::provider::error::is_refusal_message(
        &error.to_string()
    ));
    assert!(!error.to_string().contains("free-form provider explanation"));
    Ok(())
}

#[tokio::test]
async fn anthropic_sse_tool_call() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(50, 0),
        anthropic_sse::tool_block_start(0, "toolu_123", "bash"),
        anthropic_sse::tool_input_delta(0, r#"{"command": "ls -la"}"#),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("tool_use", 5),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, events) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant {
            content,
            stop_reason,
            ..
        } => {
            assert_eq!(content.len(), 1);
            assert!(
                matches!(&content[0], Content::ToolCall { id, name, arguments, .. }
                    if id == "toolu_123" && name == "bash" && arguments["command"] == "ls -la")
            );
            assert_eq!(*stop_reason, StopReason::ToolUse);
        }
        _ => panic!("Expected Assistant message"),
    }

    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::ToolCallStart { name, .. } if name == "bash")));
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::ToolCallEnd { .. })));
}

#[tokio::test]
async fn anthropic_sse_tool_call_accumulates_split_input_json() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(50, 0),
        anthropic_sse::tool_block_start(0, "toolu_123", "write"),
        anthropic_sse::tool_input_delta(0, r#"{"path":"demo.html","content":""#),
        anthropic_sse::tool_input_delta(0, "<html>"),
        anthropic_sse::tool_input_delta(0, "long content"),
        anthropic_sse::tool_input_delta(0, r#"</html>"}"#),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("tool_use", 5),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, events) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    let streamed_input = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ToolCallDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(
        streamed_input,
        r#"{"path":"demo.html","content":"<html>long content</html>"}"#
    );

    match &msg {
        Message::Assistant { content, .. } => {
            assert_eq!(content.len(), 1);
            assert!(
                matches!(&content[0], Content::ToolCall { id, name, arguments, .. }
                    if id == "toolu_123"
                        && name == "write"
                        && arguments["path"] == "demo.html"
                        && arguments["content"] == "<html>long content</html>")
            );
        }
        _ => panic!("Expected Assistant message"),
    }
}

#[tokio::test]
async fn anthropic_sse_tool_use_error_returns_provider_error() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(50, 0),
        anthropic_sse::tool_block_start(0, "toolu_123", "write"),
        anthropic_sse::tool_input_delta(0, r#"{"path":"/tmp/a.txt""#),
        anthropic_sse::block_stop(0),
        anthropic_sse::error("overloaded_error", "Overloaded"),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse_outcome(&AnthropicProvider, config, &sse, 200).await;
    let Err(err) = result else {
        panic!("Expected provider error");
    };
    assert!(err.to_string().contains("Overloaded"));
}

#[tokio::test]
async fn anthropic_sse_error_before_tool_input_still_errors() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(50, 0),
        anthropic_sse::tool_block_start(0, "toolu_123", "write"),
        anthropic_sse::error("overloaded_error", "Overloaded"),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let result = run_provider_sse_outcome(&AnthropicProvider, config, &sse, 200).await;
    let Err(err) = result else {
        panic!("Expected provider error");
    };
    assert!(err.to_string().contains("Overloaded"));
}
// ---------------------------------------------------------------------------
// SSE streaming — thinking + text
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_sse_signature_only_thinking_replays_on_turn_two(
) -> Result<(), Box<dyn std::error::Error>> {
    use evotengine::context::transform_messages_for_model;
    use evotengine::provider::anthropic::request::build_request_body;
    use evotengine::provider::ApiProtocol;

    let signatures = ["droid-google:opaque-read", "droid-google:opaque-bash"];
    let calls = [("call_read", "read"), ("call_bash", "bash")];
    let mut frames = vec![anthropic_sse::message_start(50, 0)];
    for (index, (id, name)) in calls.iter().enumerate() {
        let index = index as u64 * 2;
        frames.extend([
            anthropic_sse::thinking_block_start(index),
            // No thinking_delta: Google tool signatures arrive with empty visible thinking.
            format!("event: content_block_delta\ndata: {}", serde_json::json!({
                "type": "content_block_delta", "index": index,
                "delta": {"type": "signature_delta", "signature": signatures[index as usize / 2]},
            })),
            anthropic_sse::block_stop(index),
            anthropic_sse::tool_block_start(index + 1, id, name),
            anthropic_sse::tool_input_delta(index + 1, r#"{"path":"README.md"}"#),
            anthropic_sse::block_stop(index + 1),
        ]);
    }
    frames.extend([
        anthropic_sse::message_delta("tool_use", 5),
        anthropic_sse::message_stop(),
    ]);
    let config = StreamConfigBuilder::anthropic()
        .model("gemini-4-carbon")
        .cache_disabled()
        .build();
    let (message, _) = run_provider_sse(
        &AnthropicProvider,
        config,
        &anthropic_sse::body(frames),
        200,
    )
    .await?;
    // Include persisted-session reload, then the real provider/model history normalization.
    let saved = serde_json::to_vec(&message)?;
    let restored: Message = serde_json::from_slice(&saved)?;
    let Message::Assistant {
        model,
        provider,
        stop_reason,
        ..
    } = &restored
    else {
        panic!("expected assistant tool turn");
    };
    assert_eq!(*stop_reason, StopReason::ToolUse);
    let model = model.clone();
    let provider = provider.clone();
    let mut history = vec![Message::user("read and inspect"), restored];
    for (id, name) in calls {
        history.push(Message::ToolResult {
            tool_call_id: id.into(),
            tool_name: name.into(),
            content: vec![Content::Text {
                text: "done".into(),
            }],
            is_error: false,
            timestamp: 0,
            retention: Retention::Normal,
        });
    }
    let messages =
        transform_messages_for_model(history, &provider, &model, ApiProtocol::AnthropicMessages);
    let body = build_request_body(
        &StreamConfigBuilder::anthropic()
            .model(&model)
            .messages(messages)
            .cache_disabled()
            .build(),
        false,
    );
    assert_eq!(
        body["messages"][1]["content"],
        serde_json::json!([
            {"type": "thinking", "thinking": "", "signature": signatures[0]},
            {"type": "thinking", "thinking": "", "signature": signatures[1]},
            {"type": "tool_use", "id": "call_read", "name": "read", "input": {"path": "README.md"}},
            {"type": "tool_use", "id": "call_bash", "name": "bash", "input": {"path": "README.md"}},
        ])
    );
    assert_eq!(
        body["messages"][2]["content"][0]["tool_use_id"],
        "call_read"
    );
    assert_eq!(
        body["messages"][2]["content"][1]["tool_use_id"],
        "call_bash"
    );
    Ok(())
}

// Carbon emits visible thoughts separately from an empty signed replay block.
// Exercise decode -> session reload -> same-model continuation -> model switch.
#[tokio::test]
async fn same_model_continuation_never_promotes_unsigned_thinking_to_text(
) -> Result<(), Box<dyn std::error::Error>> {
    use evotengine::context::transform_messages_for_model;
    use evotengine::provider::anthropic::request::build_request_body;
    use evotengine::provider::ApiProtocol;

    let private = "Thinking Process: private summary generation";
    // This is intentionally reasoning-like *visible* text: no regex stripping.
    let visible = "The log contains the literal heading Thinking Process:";
    let signature = "droid-google:opaque-tool-replay";
    let frames = vec![
        anthropic_sse::message_start(50, 0),
        anthropic_sse::thinking_block_start(0),
        anthropic_sse::thinking_delta(0, private),
        anthropic_sse::block_stop(0),
        anthropic_sse::text_block_start(1),
        anthropic_sse::text_delta(1, visible),
        anthropic_sse::block_stop(1),
        anthropic_sse::thinking_block_start(2),
        format!(
            "event: content_block_delta\ndata: {}",
            serde_json::json!({
                "type": "content_block_delta", "index": 2,
                "delta": {"type": "signature_delta", "signature": signature},
            })
        ),
        anthropic_sse::block_stop(2),
        anthropic_sse::tool_block_start(3, "call_read", "read"),
        anthropic_sse::tool_input_delta(3, r#"{"path":"README.md"}"#),
        anthropic_sse::block_stop(3),
        anthropic_sse::message_delta("tool_use", 20),
        anthropic_sse::message_stop(),
    ];
    let (message, _) = run_provider_sse(
        &AnthropicProvider,
        StreamConfigBuilder::anthropic()
            .model("gemini-4-carbon")
            .build(),
        &anthropic_sse::body(frames),
        200,
    )
    .await?;
    let restored: Message = serde_json::from_slice(&serde_json::to_vec(&message)?)?;
    assert!(matches!(&restored, Message::Assistant { content, .. }
        if matches!(&content[0], Content::Thinking { thinking, metadata: None } if thinking == private)));
    let mut history = vec![
        Message::user("read the file"),
        restored,
        Message::ToolResult {
            tool_call_id: "call_read".into(),
            tool_name: "read".into(),
            content: vec![Content::Text {
                text: "file contents".into(),
            }],
            is_error: false,
            timestamp: 0,
            retention: Retention::Normal,
        },
    ];
    for model in ["gemini-4-carbon", "gemini-4-carbon", "claude-fable-5.2"] {
        history = transform_messages_for_model(
            history,
            "anthropic",
            model,
            ApiProtocol::AnthropicMessages,
        );
        let body = build_request_body(
            &StreamConfigBuilder::anthropic()
                .model(model)
                .messages(history.clone())
                .cache_disabled()
                .build(),
            false,
        );
        let encoded = body.to_string();
        assert!(!encoded.contains(private));
        assert!(encoded.contains(visible));
        assert_eq!(
            body["messages"][2]["content"][0]["tool_use_id"],
            "call_read"
        );
        let mut expected = vec![serde_json::json!({"type": "text", "text": visible})];
        if model == "gemini-4-carbon" {
            expected.push(
                serde_json::json!({"type": "thinking", "thinking": "", "signature": signature}),
            );
        }
        expected.push(serde_json::json!({"type": "tool_use", "id": "call_read", "name": "read", "input": {"path": "README.md"}}));
        assert_eq!(body["messages"][1]["content"], serde_json::json!(expected));
    }
    Ok(())
}

#[tokio::test]
async fn anthropic_sse_thinking_then_text() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(80, 0),
        anthropic_sse::thinking_block_start(0),
        anthropic_sse::thinking_delta(0, "Let me think..."),
        anthropic_sse::block_stop(0),
        anthropic_sse::text_block_start(1),
        anthropic_sse::text_delta(1, "The answer is 42."),
        anthropic_sse::block_stop(1),
        anthropic_sse::message_delta("end_turn", 20),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, events) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant { content, .. } => {
            assert_eq!(content.len(), 2);
            assert!(
                matches!(&content[0], Content::Thinking { thinking, .. } if thinking == "Let me think...")
            );
            assert!(matches!(&content[1], Content::Text { text } if text == "The answer is 42."));
        }
        _ => panic!("Expected Assistant message"),
    }

    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::ThinkingDelta { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::TextDelta { .. })));
}

// ---------------------------------------------------------------------------
// SSE streaming — error event (overloaded)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_sse_error_event() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(50, 0),
        anthropic_sse::error("overloaded_error", "Overloaded"),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let err = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap_err();

    assert!(evotengine::retry::should_retry(&err));
}

#[tokio::test]
async fn anthropic_sse_kiro_api_error_is_structurally_retryable() {
    let payload = serde_json::json!({
        "type": "error",
        "error": {
            "type": "api_error",
            "message": "Kiro returned invalid JSON for tool edit: Unterminated string starting at: line 1 column 378 (char 377)"
        }
    })
    .to_string();
    let error_event = format!("event: error\ndata: {payload}");
    let sse = anthropic_sse::body(vec![anthropic_sse::message_start(50, 0), error_event]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let err = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap_err();

    assert!(matches!(
        &err,
        evotengine::provider::ProviderError::Transient { message, .. } if message == &payload
    ));
    assert!(evotengine::retry::should_retry(&err));
}

// ---------------------------------------------------------------------------
// SSE streaming — usage with cache
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_sse_usage_only_response_is_empty() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(41_187, 0),
        anthropic_sse::message_delta("end_turn", 1),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let err = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap_err();

    assert!(err.to_string().contains("Empty response from provider"));
    assert!(evotengine::retry::should_retry(&err));
}

#[tokio::test]
async fn anthropic_sse_cache_usage() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 500),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "cached"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta("end_turn", 5),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, _) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant { usage, .. } => {
            assert_eq!(usage.input, 100);
            assert_eq!(usage.output, 5);
            assert_eq!(usage.cache_read, 500);
            assert_eq!(usage.total_tokens, 605);
        }
        _ => panic!("Expected Assistant message"),
    }
}

// Some Anthropic-compatible proxies report cache tokens only in the final
// `message_delta`, leaving `message_start.usage` as zero. The decoder must
// pick up cache_read/cache_write from `message_delta.usage` as well.
#[tokio::test]
async fn anthropic_sse_cache_usage_in_message_delta() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 0),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "cached"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta_with_usage("end_turn", 100, 5, 500, 100),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, _) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant { usage, .. } => {
            assert_eq!(usage.input, 100);
            assert_eq!(usage.output, 5);
            assert_eq!(usage.cache_read, 500);
            assert_eq!(usage.cache_write, 100);
            assert_eq!(usage.total_tokens, 705);
        }
        _ => panic!("Expected Assistant message"),
    }
}

#[tokio::test]
async fn anthropic_sse_final_usage_updates_present_fields() {
    let sse = anthropic_sse::body(vec![
        anthropic_sse::message_start(100, 500),
        anthropic_sse::text_block_start(0),
        anthropic_sse::text_delta(0, "final usage"),
        anthropic_sse::block_stop(0),
        anthropic_sse::message_delta_with_usage_and_reasoning("end_turn", 120, 15, 0, 20, 7),
        anthropic_sse::message_stop(),
    ]);

    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let (msg, _) = run_provider_sse(&AnthropicProvider, config, &sse, 200)
        .await
        .unwrap();

    match msg {
        Message::Assistant { usage, .. } => {
            assert_eq!(usage.input, 120);
            assert_eq!(usage.output, 15);
            assert_eq!(usage.cache_read, 0);
            assert_eq!(usage.cache_write, 20);
            assert_eq!(usage.reasoning_output, 7);
            assert_eq!(usage.total_tokens, 155);
        }
        _ => panic!("Expected Assistant message"),
    }
}

// ---------------------------------------------------------------------------
// HTTP error — 429 rate limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_http_429_rate_limited() {
    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let err = run_provider_json(
        &AnthropicProvider,
        config,
        r#"{"error":{"type":"rate_limit_error","message":"Rate limited"}}"#,
        429,
    )
    .await
    .unwrap_err();

    assert!(matches!(
        err,
        evotengine::provider::ProviderError::RateLimited { .. }
    ));
}

// ---------------------------------------------------------------------------
// HTTP error — 400 context overflow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_http_400_context_overflow() {
    let config = StreamConfigBuilder::anthropic().cache_disabled().build();
    let err = run_provider_json(
        &AnthropicProvider,
        config,
        r#"{"error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}"#,
        400,
    )
    .await
    .unwrap_err();

    assert!(err.is_context_overflow());
}

// ---------------------------------------------------------------------------
// JSON fallback — success response
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_json_fallback_empty_refusal_is_not_retried() {
    let json = serde_json::json!({
        "id": "msg_refusal",
        "type": "message",
        "role": "assistant",
        "content": [],
        "stop_reason": "refusal",
        "usage": {"input_tokens": 100, "output_tokens": 1}
    });
    let config = StreamConfigBuilder::anthropic().cache_disabled().build();

    let err = run_provider_json(&AnthropicProvider, config, &json.to_string(), 200)
        .await
        .unwrap_err();

    assert!(err.to_string().contains("refusal"));
    assert!(!evotengine::retry::should_retry(&err));
}

#[tokio::test]
async fn anthropic_json_fallback_usage_only_is_empty() {
    let json = serde_json::json!({
        "id": "msg_empty",
        "type": "message",
        "role": "assistant",
        "content": [],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 41187, "output_tokens": 1}
    });
    let config = StreamConfigBuilder::anthropic().cache_disabled().build();

    let err = run_provider_json(&AnthropicProvider, config, &json.to_string(), 200)
        .await
        .unwrap_err();

    assert!(err.to_string().contains("Empty response from provider"));
    assert!(evotengine::retry::should_retry(&err));
}

#[tokio::test]
async fn anthropic_json_fallback_success() {
    let json = serde_json::json!({
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "Hello from JSON!"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 50,
            "output_tokens": 10,
            "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": 5,
            "output_tokens_details": {"thinking_tokens": 3}
        }
    });

    let config = StreamConfigBuilder::anthropic()
        .model_config(resolved_model_config(
            evotengine::provider::ApiProtocol::AnthropicMessages,
            "kimi-coding",
            "kimi-for-coding",
            "https://api.kimi.com/coding",
            None,
            Default::default(),
            Default::default(),
        ))
        .cache_disabled()
        .build();
    let (msg, events) = run_provider_json(&AnthropicProvider, config, &json.to_string(), 200)
        .await
        .unwrap();

    match &msg {
        Message::Assistant {
            content,
            provider,
            usage,
            ..
        } => {
            assert_eq!(provider, "kimi-coding");
            assert_eq!(content.len(), 1);
            assert!(matches!(&content[0], Content::Text { text } if text == "Hello from JSON!"));
            assert_eq!(usage.input, 50);
            assert_eq!(usage.output, 10);
            assert_eq!(usage.cache_read, 20);
            assert_eq!(usage.cache_write, 5);
            assert_eq!(usage.reasoning_output, 3);
            assert_eq!(usage.total_tokens, 85);
        }
        _ => panic!("Expected Assistant message"),
    }

    assert!(events.iter().any(|e| matches!(e, StreamEvent::Start)));
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Done { .. })));
}
