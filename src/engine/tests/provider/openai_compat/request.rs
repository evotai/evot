use evotengine::provider::openai_compat::request::*;
use evotengine::provider::openai_compat::types::OpenAiChunk;
use evotengine::provider::ApiProtocol;
use evotengine::provider::ModelConfig;
use evotengine::provider::OpenAiCompat;
use evotengine::types::*;

use super::super::fixtures::stream_config::*;

#[test]
fn internal_system_prompt_boundary_is_not_sent() {
    let config = StreamConfigBuilder::openai()
        .system_prompt("stable\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ndynamic")
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["messages"][0]["content"], "stable\n\ndynamic");

    let static_only = StreamConfigBuilder::openai()
        .system_prompt("stable\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")
        .build();
    let body = build_request_body(&static_only, &OpenAiCompat::openai());
    assert_eq!(body["messages"][0]["content"], "stable");
}

#[test]
fn test_current_profiled_models_send_codex_default_verbosity() {
    for id in [
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6.1-sol",
    ] {
        let model_config = ModelConfig::openai(id, id);
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(model_config)
            .build();

        let body = build_request_body(&config, &OpenAiCompat::openai());
        assert_eq!(body["verbosity"], "low", "{id}");
    }
}

#[test]
fn test_old_or_unprofiled_models_omit_verbosity() {
    for id in ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5-pro", "gpt-5.7-nova"] {
        let model_config = ModelConfig::openai(id, id);
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(model_config)
            .build();

        let body = build_request_body(&config, &OpenAiCompat::openai());
        assert!(body.get("verbosity").is_none(), "{id}");
    }
}

#[test]
fn test_third_party_compatible_endpoint_omits_verbosity() {
    let model_config = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "openrouter",
        "openai/gpt-5.5",
        "https://openrouter.ai/api/v1",
        Some(OpenAiCompat::openrouter()),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("openai/gpt-5.5")
        .model_config(model_config)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openrouter());
    assert!(body.get("verbosity").is_none());
}

#[test]
fn test_uncatalogued_gpt_and_codex_pass_medium_through() {
    for id in ["codex-mini", "gpt-5.7-nova"] {
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(ModelConfig::openai(id, id))
            .thinking(ThinkingLevel::Medium)
            .build();

        let body = build_request_body(&config, &OpenAiCompat::openai());
        assert_eq!(body["reasoning_effort"], "medium", "{id}");
        assert!(body.get("verbosity").is_none(), "{id}");
    }
}

#[test]
fn test_gpt_5_levels_use_declared_or_clamped_reasoning_effort() {
    // Minimal is absent from the model contract and clamps upward to low.
    let cases = [
        (ThinkingLevel::Minimal, "low"),
        (ThinkingLevel::Low, "low"),
        (ThinkingLevel::Medium, "medium"),
        (ThinkingLevel::High, "high"),
        (ThinkingLevel::Xhigh, "xhigh"),
    ];
    for (level, expected) in cases {
        let config = StreamConfigBuilder::openai()
            .model("gpt-5.4")
            .model_config(ModelConfig::openai("gpt-5.4", "GPT-5.4"))
            .thinking(level)
            .build();

        let body = build_request_body(&config, &OpenAiCompat::openai());
        assert_eq!(body["reasoning_effort"], expected, "{level:?}");
    }
}

#[test]
fn test_gpt_5_5_first_party_route_clamps_unsupported_minimal_up_to_low() {
    // gpt-5.5 rejects `minimal` on the first-party route, so the request clamps
    // upward to the next selectable tier instead of sending an invalid value.
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.5")
        .model_config(ModelConfig::openai("gpt-5.5", "GPT-5.5"))
        .thinking(ThinkingLevel::Minimal)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "low");
}

#[test]
fn test_gpt_5_xhigh_thinking_maps_to_xhigh_reasoning_effort() {
    let model_config = ModelConfig::openai("gpt-5.5", "GPT-5.5");
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.5")
        .model_config(model_config.clone())
        .thinking(ThinkingLevel::Xhigh)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "xhigh");
}

#[test]
fn test_gpt_5_6_max_thinking_maps_to_max_reasoning_effort() {
    for id in [
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6.1-sol",
    ] {
        let model_config = ModelConfig::openai(id, id);
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(model_config)
            .thinking(ThinkingLevel::Max)
            .build();

        let body = build_request_body(&config, &OpenAiCompat::openai());
        assert_eq!(body["reasoning_effort"], "max", "{id}");
    }
}

#[test]
fn test_medium_thinking_maps_to_medium_reasoning_effort() {
    let config = StreamConfigBuilder::openai()
        .model("gpt-5")
        .thinking(ThinkingLevel::Medium)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "medium");
}

#[test]
fn test_low_thinking_maps_to_low_reasoning_effort() {
    let config = StreamConfigBuilder::openai()
        .model("gpt-5")
        .thinking(ThinkingLevel::Low)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "low");
}

#[test]
fn test_off_thinking_sends_declared_none_effort() {
    let config = StreamConfigBuilder::openai()
        .model("gpt-5")
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "none");
}

#[test]
fn test_gpt_5_6_chat_completions_off_sends_none_effort() {
    let model_config = ModelConfig::openai("gpt-5.6-sol", "GPT-5.6 Sol");
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.6-sol")
        .model_config(model_config)
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "none");
}

#[test]
fn test_gpt_6_1_sol_chat_completions_off_clamps_to_low_effort() {
    // GPT-6.1 Sol rejects `none`; `off` clamps to `low`.
    let model_config = ModelConfig::openai("gpt-6.1-sol", "GPT-6.1 Sol");
    let config = StreamConfigBuilder::openai()
        .model("gpt-6.1-sol")
        .model_config(model_config)
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "low");
}

#[test]
fn test_unsupported_off_is_clamped_before_request() {
    let model_config = ModelConfig::openai("gpt-5.5-pro", "GPT-5.5 Pro");
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.5-pro")
        .model_config(model_config)
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["reasoning_effort"], "medium");
}

#[test]
fn test_compat_without_reasoning_support_omits_reasoning_effort() {
    let config = StreamConfigBuilder::openai()
        .model("gpt-5")
        .thinking(ThinkingLevel::Medium)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::default());
    assert!(body.get("reasoning_effort").is_none());
}

#[test]
fn test_non_reasoning_model_omits_reasoning_effort_even_when_endpoint_supports_it() {
    let model_config = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "grok",
        "grok-composer-2.5-fast",
        "",
        Some(OpenAiCompat::grok_cli()),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("grok-composer-2.5-fast")
        .model_config(model_config)
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::grok_cli());
    assert!(body.get("reasoning_effort").is_none());
}

#[test]
fn test_xai_transport_omits_chat_completions_reasoning_effort() {
    let model_config = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "xai",
        "grok-4.5",
        "",
        Some(OpenAiCompat::xai()),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("grok-4.5")
        .model_config(model_config)
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::xai());
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("reasoning").is_none());
}

#[test]
fn test_openrouter_uses_nested_reasoning_effort() {
    let model_config = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "openrouter",
        "openai/gpt-5.6-sol",
        "https://openrouter.ai/api/v1",
        Some(OpenAiCompat::openrouter()),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("openai/gpt-5.6-sol")
        .model_config(model_config)
        .thinking(ThinkingLevel::Max)
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openrouter());
    assert_eq!(body["reasoning"]["effort"], "max");
    assert!(body.get("reasoning_effort").is_none());
}

#[test]
fn test_deepseek_v4_uses_thinking_toggle_and_reasoning_effort() {
    let model = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "deepseek",
        "deepseek-v4-pro",
        "https://api.deepseek.com",
        Some(OpenAiCompat::deepseek()),
        Default::default(),
        Default::default(),
    );
    let enabled = StreamConfigBuilder::openai()
        .model("deepseek-v4-pro")
        .model_config(model.clone())
        .thinking(ThinkingLevel::Max)
        .build();
    let enabled_body = build_request_body(&enabled, &OpenAiCompat::deepseek());
    assert_eq!(enabled_body["thinking"]["type"], "enabled");
    assert_eq!(enabled_body["reasoning_effort"], "max");

    let disabled = StreamConfigBuilder::openai()
        .model("deepseek-v4-pro")
        .model_config(model)
        .thinking(ThinkingLevel::Off)
        .build();
    let disabled_body = build_request_body(&disabled, &OpenAiCompat::deepseek());
    assert_eq!(disabled_body["thinking"]["type"], "disabled");
    assert!(disabled_body.get("reasoning_effort").is_none());
}

#[test]
fn test_legacy_deepseek_reasoner_still_emits_thinking_and_effort() {
    // Pins the legacy-model wire contract after REASONING_EFFORT was added to
    // the DeepSeek transport: selectable levels are unchanged (Off/High) and
    // only an enabled model sends reasoning_effort. Guards against a regression
    // where adding the cap changes what legacy deepseek-reasoner requests emit.
    let model = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "deepseek",
        "deepseek-reasoner",
        "https://api.deepseek.com",
        Some(OpenAiCompat::deepseek()),
        Default::default(),
        Default::default(),
    );
    assert_eq!(model.supported_thinking_levels(), vec![
        ThinkingLevel::Off,
        ThinkingLevel::High
    ]);

    let enabled = StreamConfigBuilder::openai()
        .model("deepseek-reasoner")
        .model_config(model)
        .thinking(ThinkingLevel::High)
        .build();
    let body = build_request_body(&enabled, &OpenAiCompat::deepseek());
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["reasoning_effort"], "high");
}

#[test]
fn test_kimi_k3_uses_transport_specific_reasoning_format() {
    let moonshot_model = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "moonshotai",
        "kimi-k3",
        "https://api.moonshot.ai/v1",
        Some(OpenAiCompat::moonshot()),
        Default::default(),
        Default::default(),
    );
    let moonshot_config = StreamConfigBuilder::openai()
        .model("kimi-k3")
        .model_config(moonshot_model)
        .thinking(ThinkingLevel::High)
        .build();
    let moonshot_body = build_request_body(&moonshot_config, &OpenAiCompat::moonshot());
    assert_eq!(moonshot_body["thinking"]["type"], "enabled");
    assert!(moonshot_body.get("reasoning_effort").is_none());
    assert!(moonshot_body.get("reasoning").is_none());

    let openrouter_model = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "openrouter",
        "moonshotai/kimi-k3",
        "https://openrouter.ai/api/v1",
        Some(OpenAiCompat::openrouter()),
        Default::default(),
        Default::default(),
    );
    let openrouter_config = StreamConfigBuilder::openai()
        .model("moonshotai/kimi-k3")
        .model_config(openrouter_model)
        .thinking(ThinkingLevel::High)
        .build();
    let openrouter_body = build_request_body(&openrouter_config, &OpenAiCompat::openrouter());
    assert_eq!(openrouter_body["reasoning"]["effort"], "high");
    assert!(openrouter_body.get("thinking").is_none());
    assert!(openrouter_body.get("reasoning_effort").is_none());
}

#[test]
fn test_build_request_body_basic() {
    let config = StreamConfigBuilder::openai()
        .system_prompt("You are helpful.")
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["model"], "gpt-4o");
    assert!(body["stream"].as_bool().unwrap());
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    assert!(body["max_completion_tokens"].is_number());
}

#[test]
fn test_prompt_cache_key_is_included_for_openai() {
    let config = StreamConfigBuilder::openai()
        .prompt_cache_key("session-123")
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    assert_eq!(body["prompt_cache_key"], "session-123");
}

#[test]
fn test_prompt_cache_key_omitted_without_capability() {
    let config = StreamConfigBuilder::openai()
        .prompt_cache_key("session-123")
        .build();

    let body = build_request_body(&config, &OpenAiCompat::default());
    assert!(body.get("prompt_cache_key").is_none());
}

#[test]
fn test_build_request_body_with_tools() {
    let compat = OpenAiCompat::openai();
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::user("List files")])
        .tools(vec![tool_def("bash", "Run a command")])
        .max_tokens(1024)
        .build();

    let body = build_request_body(&config, &compat);
    assert!(body["tools"].is_array());
    assert_eq!(body["tools"][0]["function"]["name"], "bash");
    assert!(body.get("temperature").is_none());
}

#[test]
fn test_content_to_openai_simple_text() {
    let content = vec![Content::Text {
        text: "hello".into(),
    }];
    let result = content_to_openai(&content, true);
    assert_eq!(result, "hello");
}

#[test]
fn test_content_to_openai_filters_empty_text() {
    let content = vec![
        Content::Text { text: "".into() },
        Content::Text {
            text: "hello".into(),
        },
        Content::Text { text: "".into() },
    ];
    let result = content_to_openai(&content, true);
    let parts = result.as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["text"], "hello");
}

#[test]
fn test_content_to_openai_single_empty_text_filtered() {
    let content = vec![Content::Text { text: "".into() }];
    let result = content_to_openai(&content, true);
    let parts = result.as_array().unwrap();
    assert!(parts.is_empty());
}

#[test]
fn test_content_to_openai_multipart() {
    let content = vec![
        Content::Text {
            text: "look at this".into(),
        },
        Content::Image {
            mime_type: "image/png".into(),
            source: ImageSource::Base64 { data: "abc".into() },
        },
    ];
    let result = content_to_openai(&content, true);
    assert!(result.is_array());
    assert_eq!(result[0]["type"], "text");
    assert_eq!(result[1]["type"], "image_url");
}

#[test]
fn test_content_to_openai_text_only_model_drops_image() {
    let content = vec![
        Content::Text {
            text: "look at this".into(),
        },
        Content::Image {
            mime_type: "image/png".into(),
            source: ImageSource::Base64 { data: "abc".into() },
        },
    ];
    let result = content_to_openai(&content, false);
    assert!(result.is_array());
    assert_eq!(result[0]["type"], "text");
    // Image becomes a text placeholder, never an image_url block.
    assert_eq!(result[1]["type"], "text");
    assert!(result
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["type"] != "image_url"));
}

#[test]
fn test_tool_result_with_image() {
    let compat = OpenAiCompat::openai();
    let config = StreamConfigBuilder::openai()
        .messages(vec![
            Message::Assistant {
                content: vec![Content::ToolCall {
                    id: "call-1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": "img.png"}),
                    metadata: None,
                }],
                stop_reason: StopReason::ToolUse,
                model: "test".into(),
                provider: "test".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            },
            Message::ToolResult {
                tool_call_id: "call-1".into(),
                tool_name: "read".into(),
                content: vec![Content::Image {
                    mime_type: "image/png".into(),
                    source: ImageSource::Base64 {
                        data: "aW1hZ2VkYXRh".into(),
                    },
                }],
                is_error: false,
                timestamp: 0,
                retention: Retention::Normal,
            },
        ])
        .build();

    let body = build_request_body(&config, &compat);
    let msgs = body["messages"].as_array().unwrap();
    let tool_msg = &msgs[1];
    assert_eq!(tool_msg["role"], "tool");
    assert_eq!(
        tool_msg["content"],
        "Image output is attached in the next user message."
    );

    let image_msg = &msgs[2];
    assert_eq!(image_msg["role"], "user");
    let content = image_msg["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "Image output from tool `read`:");
    assert_eq!(content[1]["type"], "image_url");
    assert_eq!(
        content[1]["image_url"]["url"],
        "data:image/png;base64,aW1hZ2VkYXRh"
    );
}

#[test]
fn test_tool_result_text_only_uses_string() {
    let compat = OpenAiCompat::openai();
    let config = StreamConfigBuilder::openai()
        .messages(vec![
            Message::Assistant {
                content: vec![Content::ToolCall {
                    id: "call-1".into(),
                    name: "bash".into(),
                    arguments: serde_json::json!({"command": "echo hi"}),
                    metadata: None,
                }],
                stop_reason: StopReason::ToolUse,
                model: "test".into(),
                provider: "test".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            },
            Message::ToolResult {
                tool_call_id: "call-1".into(),
                tool_name: "bash".into(),
                content: vec![Content::Text {
                    text: "hello".into(),
                }],
                is_error: false,
                timestamp: 0,
                retention: Retention::Normal,
            },
        ])
        .build();

    let body = build_request_body(&config, &compat);
    let msgs = body["messages"].as_array().unwrap();
    let tool_msg = &msgs[1];
    assert_eq!(tool_msg["content"], "hello");
}

#[test]
fn test_empty_assistant_message_is_skipped() {
    let compat = OpenAiCompat::openai();
    let config = StreamConfigBuilder::openai()
        .messages(vec![
            Message::user("hello"),
            Message::Assistant {
                content: vec![Content::Text { text: "".into() }],
                stop_reason: StopReason::Stop,
                model: "test".into(),
                provider: "test".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            },
            Message::user("world"),
        ])
        .build();

    let body = build_request_body(&config, &compat);
    let msgs = body["messages"].as_array().unwrap();
    // user("hello") + user("world") = 2, empty assistant skipped (no system prompt)
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[1]["role"], "user");
    // No message should have role "assistant" with missing content
    for msg in msgs {
        if msg["role"] == "assistant" {
            assert!(
                msg.get("content").is_some()
                    || msg.get("tool_calls").is_some()
                    || msg.get("reasoning_content").is_some(),
                "assistant message must have content or tool_calls"
            );
        }
    }
}

#[test]
fn test_chunk_with_inline_error_parses_error_field() {
    let data = r#"{"choices":[],"error":{"message":"upstream failed"}}"#;
    let chunk: OpenAiChunk = serde_json::from_str(data).unwrap();
    assert!(chunk.error.is_some());
    assert_eq!(chunk.error.unwrap().message, "upstream failed");
}

#[test]
fn test_chunk_without_error_has_none() {
    let data = r#"{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}"#;
    let chunk: OpenAiChunk = serde_json::from_str(data).unwrap();
    assert!(chunk.error.is_none());
}

#[test]
fn test_reasoning_content_in_request() {
    let config = StreamConfigBuilder::openai()
        .model("deepseek-v4-pro")
        .messages(vec![
            Message::user("hello"),
            Message::Assistant {
                content: vec![
                    Content::Thinking {
                        thinking: "Let me think about this...".into(),
                        metadata: None,
                    },
                    Content::Text {
                        text: "Here is the answer.".into(),
                    },
                ],
                stop_reason: StopReason::Stop,
                model: "deepseek-v4-pro".into(),
                provider: "deepseek".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            },
            Message::user("thanks"),
        ])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3);
    let asst = &msgs[1];
    assert_eq!(asst["role"], "assistant");
    assert_eq!(asst["reasoning_content"], "Let me think about this...");
    assert!(asst["content"].is_array());
}

#[test]
fn test_reasoning_signature_selects_replay_field() {
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::Assistant {
            content: vec![
                Content::Thinking {
                    thinking: "content".into(),
                    metadata: Some(ThinkingMetadata::OpenAiCompletions {
                        field: ReasoningField::ReasoningContent,
                        details: None,
                    }),
                },
                Content::Thinking {
                    thinking: "reasoning".into(),
                    metadata: Some(ThinkingMetadata::OpenAiCompletions {
                        field: ReasoningField::Reasoning,
                        details: None,
                    }),
                },
                Content::Thinking {
                    thinking: "text".into(),
                    metadata: Some(ThinkingMetadata::OpenAiCompletions {
                        field: ReasoningField::ReasoningText,
                        details: None,
                    }),
                },
            ],
            stop_reason: StopReason::Stop,
            model: "model".into(),
            provider: "provider".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    let assistant = &body["messages"][0];
    assert_eq!(assistant["reasoning_content"], "content");
    assert_eq!(assistant["reasoning"], "reasoning");
    assert_eq!(assistant["reasoning_text"], "text");
}

#[test]
fn test_thinking_only_assistant_not_skipped() {
    let config = StreamConfigBuilder::openai()
        .model("deepseek-v4-pro")
        .messages(vec![Message::user("test"), Message::Assistant {
            content: vec![Content::Thinking {
                thinking: "internal reasoning only".into(),
                metadata: None,
            }],
            stop_reason: StopReason::Stop,
            model: "deepseek-v4-pro".into(),
            provider: "deepseek".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    let msgs = body["messages"].as_array().unwrap();
    // user + assistant (thinking only, NOT skipped) = 2
    assert_eq!(
        msgs.len(),
        2,
        "assistant with only thinking should not be skipped"
    );
    let asst = &msgs[1];
    assert_eq!(asst["role"], "assistant");
    assert_eq!(asst["reasoning_content"], "internal reasoning only");
    assert!(asst.get("content").is_none());
}

#[test]
fn test_reasoning_details_replayed_verbatim_without_duplicating_text() {
    let details = vec![
        serde_json::json!({"type": "reasoning.summary", "summary": "plan it", "id": "rs_1", "format": "openai-responses-v1", "index": 0, "extra": "kept"}),
        serde_json::json!({"type": "reasoning.encrypted", "data": "ENC", "id": "rs_1", "format": "openai-responses-v1", "index": 0}),
    ];
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::user("test"), Message::Assistant {
            content: vec![
                Content::Thinking {
                    thinking: "plan it".into(),
                    metadata: Some(ThinkingMetadata::OpenAiCompletions {
                        field: ReasoningField::ReasoningContent,
                        details: Some(details.clone()),
                    }),
                },
                Content::ToolCall {
                    id: "call_1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                    metadata: None,
                },
            ],
            stop_reason: StopReason::ToolUse,
            model: "gpt-6.1-sol".into(),
            provider: "evot-pro-openai".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    let asst = &body["messages"][1];
    assert_eq!(asst["role"], "assistant");
    assert_eq!(asst["reasoning_details"], serde_json::Value::Array(details));
    // The summary already travels inside reasoning_details.
    assert!(asst.get("reasoning_content").is_none());
    assert!(asst["tool_calls"].is_array());
}

#[test]
fn test_encrypted_only_reasoning_details_keep_summary_in_reasoning_content() {
    let details =
        vec![serde_json::json!({"type": "reasoning.encrypted", "data": "ENC", "id": "rs_1"})];
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::user("test"), Message::Assistant {
            content: vec![Content::Thinking {
                thinking: "visible summary".into(),
                metadata: Some(ThinkingMetadata::OpenAiCompletions {
                    field: ReasoningField::ReasoningContent,
                    details: Some(details.clone()),
                }),
            }],
            stop_reason: StopReason::Stop,
            model: "m".into(),
            provider: "p".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    let asst = &body["messages"][1];
    assert_eq!(asst["reasoning_details"], serde_json::Value::Array(details));
    assert_eq!(asst["reasoning_content"], "visible summary");
}

#[test]
fn test_encrypted_only_thinking_without_text_is_not_skipped() {
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::user("test"), Message::Assistant {
            content: vec![
                Content::Thinking {
                    thinking: String::new(),
                    metadata: Some(ThinkingMetadata::OpenAiCompletions {
                        field: ReasoningField::ReasoningContent,
                        details: Some(vec![
                            serde_json::json!({"type": "reasoning.encrypted", "data": "ENC"}),
                        ]),
                    }),
                },
                Content::ToolCall {
                    id: "call_1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                    metadata: None,
                },
            ],
            stop_reason: StopReason::ToolUse,
            model: "m".into(),
            provider: "p".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::openai());
    let asst = &body["messages"][1];
    assert_eq!(asst["reasoning_details"][0]["data"], "ENC");
    assert!(asst.get("reasoning_content").is_none());
}

#[test]
fn test_tool_call_assistant_includes_empty_reasoning_content() {
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::user("test"), Message::Assistant {
            content: vec![Content::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "/tmp/a"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "claude-opus-4-6".into(),
            provider: "anthropic".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let body = build_request_body(&config, &OpenAiCompat::deepseek());
    let msgs = body["messages"].as_array().unwrap();
    let asst = &msgs[1];
    assert_eq!(asst["role"], "assistant");
    assert_eq!(asst["reasoning_content"], "");
    assert!(asst["tool_calls"].is_array());
}

#[test]
fn test_tool_call_assistant_omits_empty_reasoning_content_without_cap() {
    let config = StreamConfigBuilder::openai()
        .messages(vec![Message::user("test"), Message::Assistant {
            content: vec![Content::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "/tmp/a"}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "claude-opus-4-6".into(),
            provider: "anthropic".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }])
        .build();

    let compat = OpenAiCompat::openai();
    // OpenAI doesn't have this cap by default, so no need to remove it.
    let body = build_request_body(&config, &compat);
    let msgs = body["messages"].as_array().unwrap();
    let asst = &msgs[1];
    assert_eq!(asst["role"], "assistant");
    assert!(asst.get("reasoning_content").is_none());
    assert!(asst["tool_calls"].is_array());
}

#[test]
fn cloud_openai_grok_sends_reasoning_effort() {
    let mut compat = OpenAiCompat::default();
    compat.caps |= evotengine::provider::CompatCaps::REASONING_EFFORT;
    let model = resolved_model_config(
        ApiProtocol::OpenAiCompletions,
        "evot-pro-openai",
        "grok-4.6",
        "https://auto.evot.ai/v1/llm",
        Some(compat.clone()),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("grok-4.6")
        .model_config(model)
        .thinking(ThinkingLevel::Xhigh)
        .build();
    let body = build_request_body(&config, &compat);
    assert_eq!(body["reasoning_effort"], "xhigh");
}
