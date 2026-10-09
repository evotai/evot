use evotengine::context::transform_messages_for_model;
use evotengine::provider::ApiProtocol;
use evotengine::types::ReasoningField;
use evotengine::Content;
use evotengine::Message;
use evotengine::StopReason;
use evotengine::ThinkingMetadata;
use evotengine::ToolCallMetadata;
use evotengine::Usage;

fn assistant(provider: &str, model: &str, content: Vec<Content>) -> Message {
    Message::Assistant {
        content,
        stop_reason: StopReason::Stop,
        model: model.into(),
        provider: provider.into(),
        usage: Usage::default(),
        timestamp: 1,
        error_message: None,
        response_id: None,
    }
}

#[test]
fn same_model_and_api_preserve_replayable_thinking_metadata() {
    let message = assistant("anthropic", "claude", vec![Content::Thinking {
        thinking: "plan".into(),
        metadata: Some(ThinkingMetadata::Anthropic {
            signature: "sig".into(),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "anthropic",
        "claude",
        ApiProtocol::AnthropicMessages,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Thinking {
                metadata: Some(ThinkingMetadata::Anthropic { signature }), ..
            }] if signature == "sig")
    ));
}

#[test]
fn same_openai_responses_model_preserves_reasoning_item() {
    let message = assistant("openai", "gpt-5.5", vec![Content::Thinking {
        thinking: "plan".into(),
        metadata: Some(ThinkingMetadata::OpenAiResponses {
            item: serde_json::json!({
                "type": "reasoning",
                "id": "rs_1",
                "encrypted_content": "enc",
                "summary": [],
            }),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "openai",
        "gpt-5.5",
        ApiProtocol::OpenAiResponses,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Thinking {
                metadata: Some(ThinkingMetadata::OpenAiResponses { item }), ..
            }] if item["id"] == "rs_1")
    ));
}

#[test]
fn cross_openai_responses_model_drops_function_item_metadata() {
    let message = assistant("openai", "old-model", vec![Content::ToolCall {
        id: "call_1".into(),
        name: "bash".into(),
        arguments: serde_json::json!({"command": "pwd"}),
        metadata: Some(ToolCallMetadata::OpenAiResponses {
            item_id: "fc_1".into(),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "openai",
        "new-model",
        ApiProtocol::OpenAiResponses,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::ToolCall { id, metadata: None, .. }] if id == "call_1")
    ));
}

#[test]
fn cross_protocol_model_keeps_canonical_tool_id_only() {
    let message = assistant("openai", "gpt-5.5", vec![Content::ToolCall {
        id: "call_1".into(),
        name: "bash".into(),
        arguments: serde_json::json!({"command": "pwd"}),
        metadata: Some(ToolCallMetadata::OpenAiResponses {
            item_id: "fc_1".into(),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "kiro",
        "gpt-5.5",
        ApiProtocol::AnthropicMessages,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::ToolCall { id, metadata: None, .. }] if id == "call_1")
    ));
}

#[test]
fn same_openai_responses_model_preserves_function_item_metadata() {
    let message = assistant("openai", "gpt-5.5", vec![Content::ToolCall {
        id: "call_1".into(),
        name: "bash".into(),
        arguments: serde_json::json!({"command": "pwd"}),
        metadata: Some(ToolCallMetadata::OpenAiResponses {
            item_id: "fc_1".into(),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "openai",
        "gpt-5.5",
        ApiProtocol::OpenAiResponses,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::ToolCall {
                id,
                metadata: Some(ToolCallMetadata::OpenAiResponses { item_id }),
                ..
            }] if id == "call_1" && item_id == "fc_1")
    ));
}

#[test]
fn same_model_keeps_empty_thinking_that_carries_replay_payload() {
    let details = vec![serde_json::json!({"type": "reasoning.encrypted", "data": "ENC"})];
    let message = assistant("proxy", "gpt", vec![Content::Thinking {
        thinking: String::new(),
        metadata: Some(ThinkingMetadata::OpenAiCompletions {
            field: ReasoningField::ReasoningContent,
            details: Some(details.clone()),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "proxy",
        "gpt",
        ApiProtocol::OpenAiCompletions,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Thinking {
                thinking,
                metadata: Some(ThinkingMetadata::OpenAiCompletions { details: Some(kept), .. }),
            }] if thinking.is_empty() && *kept == details)
    ));
}

#[test]
fn same_model_drops_empty_thinking_without_replay_payload() {
    let message = assistant("proxy", "gpt", vec![Content::Thinking {
        thinking: "   ".into(),
        metadata: Some(ThinkingMetadata::completions_text_only(
            ReasoningField::ReasoningContent,
        )),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "proxy",
        "gpt",
        ApiProtocol::OpenAiCompletions,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. } if content.is_empty()
    ));
}

#[test]
fn cross_model_encrypted_only_thinking_is_dropped_not_replayed() {
    let message = assistant("proxy", "old", vec![Content::Thinking {
        thinking: String::new(),
        metadata: Some(ThinkingMetadata::OpenAiCompletions {
            field: ReasoningField::ReasoningContent,
            details: Some(vec![
                serde_json::json!({"type": "reasoning.encrypted", "data": "ENC"}),
            ]),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "proxy",
        "new",
        ApiProtocol::OpenAiCompletions,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. } if content.is_empty()
    ));
}

#[test]
fn cross_model_thinking_is_downgraded_to_text() {
    let message = assistant("openai", "old-model", vec![Content::Thinking {
        thinking: "useful plan".into(),
        metadata: Some(ThinkingMetadata::OpenAiCompletions {
            field: ReasoningField::ReasoningContent,
            details: None,
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "openai",
        "new-model",
        ApiProtocol::OpenAiCompletions,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Text { text }] if text == "useful plan")
    ));
}

#[test]
fn foreign_protocol_metadata_is_downgraded_even_when_names_match() {
    let message = assistant("proxy", "model", vec![Content::Thinking {
        thinking: "plan".into(),
        metadata: Some(ThinkingMetadata::Anthropic {
            signature: "sig".into(),
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "proxy",
        "model",
        ApiProtocol::OpenAiCompletions,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Text { text }] if text == "plan")
    ));
}

#[test]
fn placeholder_thinking_after_tools_stays_in_history_as_text() {
    let message = assistant("openai", "gpt-5.6-sol", vec![
        Content::Text {
            text: "compare the two renderers".into(),
        },
        Content::ToolCall {
            id: "call_1".into(),
            name: "bash".into(),
            arguments: serde_json::json!({"command": "rg thinking"}),
            metadata: None,
        },
        Content::Thinking {
            thinking: "...".into(),
            metadata: Some(ThinkingMetadata::Anthropic {
                signature: "sig".into(),
            }),
        },
    ]);

    let transformed = transform_messages_for_model(
        vec![message],
        "evot-pro-anthropic",
        "deepseek-v4.1-flash",
        ApiProtocol::AnthropicMessages,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(
                &content[..],
                [
                    Content::Text { text: opening },
                    Content::ToolCall { id, .. },
                    Content::Text { text: placeholder },
                ] if opening == "compare the two renderers"
                    && id == "call_1"
                    && placeholder == "..."
            )
    ));
}

#[test]
fn unsigned_same_model_thinking_is_downgraded_to_text() {
    let message = assistant("anthropic", "claude", vec![Content::Thinking {
        thinking: "plan".into(),
        metadata: None,
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "anthropic",
        "claude",
        ApiProtocol::AnthropicMessages,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Text { text }] if text == "plan")
    ));
}

#[test]
fn served_alias_does_not_downgrade_same_requested_model_thinking() {
    let message = assistant("openai", "grok-4.6", vec![Content::Thinking {
        thinking: "plan".into(),
        metadata: Some(ThinkingMetadata::OpenAiCompletions {
            field: ReasoningField::ReasoningContent,
            details: None,
        }),
    }]);

    let transformed = transform_messages_for_model(
        vec![message],
        "openai",
        "grok-4.6",
        ApiProtocol::OpenAiCompletions,
    );

    assert!(matches!(
        &transformed[0],
        Message::Assistant { content, .. }
            if matches!(&content[..], [Content::Thinking {
                thinking,
                metadata: Some(ThinkingMetadata::OpenAiCompletions {
                    field: ReasoningField::ReasoningContent,
                    details: None,
                }),
            }] if thinking == "plan")
    ));
}
