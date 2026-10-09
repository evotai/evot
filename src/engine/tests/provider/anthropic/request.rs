use evotengine::provider::anthropic::request::*;
use evotengine::provider::traits::*;
use evotengine::provider::ModelConfig;
use evotengine::types::*;

use super::super::fixtures::stream_config::*;

/// Helper: assistant message with text content.
fn assistant(text: &str) -> Message {
    Message::Assistant {
        content: vec![Content::Text { text: text.into() }],
        stop_reason: StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    }
}

/// Helper: multi-turn config used by cache tests.
fn cache_config(cache: CacheConfig) -> StreamConfig {
    StreamConfigBuilder::anthropic()
        .system_prompt("You are helpful.")
        .messages(vec![
            Message::user("Hello"),
            assistant("Hi there!"),
            Message::user("What is 2+2?"),
        ])
        .tools(vec![tool_def("bash", "Run commands")])
        .cache_config(cache)
        .build()
}

#[test]
fn normalized_history_serializes_all_parallel_results_in_the_next_message() {
    use evotengine::context::transform_messages_for_model;
    use evotengine::provider::ApiProtocol;

    let mut calls = assistant("reading files");
    if let Message::Assistant {
        content,
        stop_reason,
        ..
    } = &mut calls
    {
        *stop_reason = StopReason::ToolUse;
        for id in ["a", "b", "c", "d"] {
            content.push(Content::ToolCall {
                id: id.into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "README.md"}),
                metadata: None,
            });
        }
        content.push(Content::Thinking {
            thinking: "plan".into(),
            metadata: Some(ThinkingMetadata::Anthropic {
                signature: "old-sig".into(),
            }),
        });
    }
    let mut failed = assistant("incomplete response");
    if let Message::Assistant { stop_reason, .. } = &mut failed {
        *stop_reason = StopReason::Error;
    }
    let messages = transform_messages_for_model(
        vec![
            Message::user("summary"),
            calls,
            Message::ToolResult {
                tool_call_id: "b".into(),
                tool_name: "read".into(),
                content: vec![Content::Text {
                    text: "file contents".into(),
                }],
                is_error: false,
                timestamp: 1,
                retention: Retention::Normal,
            },
            failed,
            Message::user("continue"),
        ],
        "another-provider",
        "another-model",
        ApiProtocol::AnthropicMessages,
    );
    let config = StreamConfigBuilder::anthropic().messages(messages).build();
    let body = build_request_body(&config, false);
    assert_eq!(body["messages"][1]["role"], "assistant");
    let assistant_blocks = body["messages"][1]["content"].as_array().unwrap();
    // Cross-model thinking stays visible, but a tool_use turn must end on
    // tool_use: DeepSeek's Anthropic-compatible API treats a later text block
    // as interrupting the pair with the next message's tool_result.
    assert_eq!(assistant_blocks[0]["type"], "text");
    assert_eq!(assistant_blocks[0]["text"], "reading files");
    assert_eq!(assistant_blocks[1]["type"], "text");
    assert_eq!(assistant_blocks[1]["text"], "plan");
    assert_eq!(assistant_blocks[2]["type"], "tool_use");
    assert_eq!(assistant_blocks.last().unwrap()["type"], "tool_use");
    assert_eq!(body["messages"][2]["role"], "user");
    for (index, id) in ["b", "a", "c", "d"].iter().enumerate() {
        let block = &body["messages"][2]["content"][index];
        assert_eq!(block["type"], "tool_result");
        assert_eq!(block["tool_use_id"], *id);
        assert_eq!(block["is_error"], index != 0);
        assert_eq!(
            block["content"],
            if index == 0 {
                "file contents"
            } else {
                "No result provided"
            }
        );
    }
    assert!(!body.to_string().contains("incomplete response"));
    assert!(!body.to_string().contains("old-sig"));
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

#[test]
fn test_kimi_coding_request_uses_pi_catalog_limits() {
    let config = StreamConfigBuilder::anthropic()
        .model("kimi-for-coding")
        .model_config(ModelConfig::anthropic("kimi-for-coding", "Kimi For Coding"))
        .no_max_tokens()
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 65_536);
    // Kimi's anthropic-compatible endpoint only understands `enabled`; the
    // proprietary `adaptive` type is silently ignored and disables thinking.
    assert_eq!(body["thinking"]["type"], "enabled");
    assert!(body["thinking"].get("display").is_none());
    // Enabled wire carries budget_tokens alongside output_config.effort.
    assert!(body["thinking"]["budget_tokens"]
        .as_u64()
        .is_some_and(|budget| budget >= 1024));
    assert_eq!(body["output_config"]["effort"], "high");
}

#[test]
fn test_kimi_k3_thinking_uses_enabled_wire_with_effort() {
    let config = StreamConfigBuilder::anthropic()
        .model("kimi-k3")
        .model_config(ModelConfig::anthropic("kimi-k3", "Kimi K3"))
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert!(body["thinking"]["budget_tokens"]
        .as_u64()
        .is_some_and(|budget| budget >= 1024));
    // K3's catalog maps High to an explicit "high" wire value.
    assert_eq!(body["output_config"]["effort"], "high");
}

#[test]
fn test_glm_5_3_thinking_uses_enabled_wire_with_effort_and_budget() {
    let config = StreamConfigBuilder::anthropic()
        .model("glm-5.3")
        .model_config(ModelConfig::anthropic("glm-5.3", "GLM 5.3"))
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert!(body["thinking"]["budget_tokens"]
        .as_u64()
        .is_some_and(|budget| budget >= 1024));
    assert_eq!(body["output_config"]["effort"], "high");
}

#[test]
fn test_glm_5_3_max_maps_to_max_effort() {
    let config = StreamConfigBuilder::anthropic()
        .model("glm-5.3")
        .model_config(ModelConfig::anthropic("glm-5.3", "GLM 5.3"))
        .thinking(ThinkingLevel::Max)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["output_config"]["effort"], "max");
}

#[test]
fn test_gpt_5_6_anthropic_route_uses_enabled_wire_with_effort() {
    let config = StreamConfigBuilder::anthropic()
        .model("gpt-5.6-sol")
        .model_config(ModelConfig::anthropic("gpt-5.6-sol", "GPT-5.6 Sol"))
        .thinking(ThinkingLevel::Max)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["thinking"]["budget_tokens"], 16_384);
    assert_eq!(body["output_config"]["effort"], "max");
}

#[test]
fn test_anthropic_request_omits_temperature() {
    let config = StreamConfigBuilder::anthropic()
        .model("claude-sonnet-4-5")
        .model_config(ModelConfig::anthropic("claude-sonnet-4-5", "Sonnet 4.5"))
        .thinking(ThinkingLevel::Off)
        .build();
    let body = build_request_body(&config, false);
    assert!(body.get("temperature").is_none());
}

#[test]
fn test_budget_thinking_for_non_adaptive_anthropic_model() {
    let config = StreamConfigBuilder::anthropic()
        .model("claude-sonnet-4-5")
        .model_config(ModelConfig::anthropic("claude-sonnet-4-5", "Sonnet 4.5"))
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "enabled");
    assert!(body["thinking"]["budget_tokens"].as_u64().unwrap() >= 1024);
    assert!(body.get("output_config").is_none());
}

#[test]
fn test_non_off_thinking_sent_as_adaptive_for_anthropic() {
    let config = StreamConfigBuilder::anthropic()
        .model("claude-opus-4-8")
        .model_config(ModelConfig::anthropic("claude-opus-4-8", "Opus 4.8"))
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["thinking"]["display"], "summarized");
    assert!(body["thinking"].get("budget_tokens").is_none());
    assert_eq!(body["output_config"]["effort"], "high");
}

#[test]
fn test_thinking_effort_levels_map_for_anthropic() {
    let cases = [
        (ThinkingLevel::Minimal, "low"),
        (ThinkingLevel::Low, "low"),
        (ThinkingLevel::Medium, "medium"),
        (ThinkingLevel::High, "high"),
    ];
    for (level, expected) in cases {
        let config = StreamConfigBuilder::anthropic()
            .model("claude-opus-4-8")
            .model_config(ModelConfig::anthropic("claude-opus-4-8", "Opus 4.8"))
            .thinking(level)
            .build();
        let body = build_request_body(&config, false);
        assert_eq!(
            body["output_config"]["effort"], expected,
            "level {level:?} should map to effort {expected}"
        );
        assert_eq!(body["thinking"]["type"], "adaptive");
    }
}

#[test]
fn test_budget_thinking_is_omitted_when_output_cap_cannot_fit_minimum() {
    // No model metadata and the fixture's 1024-token output cap cannot fit both
    // Anthropic's minimum thinking budget and visible output.
    let config = StreamConfigBuilder::anthropic()
        .thinking(ThinkingLevel::Xhigh)
        .build();
    let body = build_request_body(&config, false);
    assert!(body.get("thinking").is_none());
    assert!(body.get("output_config").is_none());
    assert_eq!(body["max_tokens"], 1024);
}

#[test]
fn test_budget_thinking_uses_independent_output_limit() {
    let model_config = resolved_model_config(
        evotengine::provider::ApiProtocol::AnthropicMessages,
        "anthropic",
        "claude-sonnet-4-5",
        "https://api.anthropic.com",
        None,
        Default::default(),
        evotengine::provider::ModelOverrides {
            context_window: Some(10_000),
            ..Default::default()
        },
    );
    let config = StreamConfigBuilder::anthropic()
        .model("claude-sonnet-4-5")
        .model_config(model_config)
        .max_tokens(4096)
        .messages(vec![Message::user("x".repeat(32_000))])
        .thinking(ThinkingLevel::High)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 20_480);
    assert_eq!(body["thinking"]["budget_tokens"], 16_384);
}

#[test]
fn test_xhigh_maps_to_max_on_opus_4_6() {
    // Opus 4.6 only accepts "max" for the strongest effort.
    let config = StreamConfigBuilder::anthropic()
        .model("claude-opus-4-6")
        .model_config(ModelConfig::anthropic("claude-opus-4-6", "Claude Opus 4.6"))
        .thinking(ThinkingLevel::Xhigh)
        .build();
    let body = build_request_body(&config, false);
    assert_eq!(
        body["output_config"]["effort"], "max",
        "Opus 4.6 xhigh should emit max"
    );
}

#[test]
fn test_max_maps_to_max_on_supported_anthropic_model() {
    let config = StreamConfigBuilder::anthropic()
        .model("claude-opus-4-8")
        .model_config(ModelConfig::anthropic("claude-opus-4-8", "Claude Opus 4.8"))
        .thinking(ThinkingLevel::Max)
        .build();
    let body = build_request_body(&config, false);
    assert_eq!(body["output_config"]["effort"], "max");
}

#[test]
fn test_xhigh_maps_to_xhigh_on_opus_4_8() {
    // Opus 4.7+/4.8 use "xhigh" (max is invalid there).
    let config = StreamConfigBuilder::anthropic()
        .model("claude-opus-4-8")
        .model_config(ModelConfig::anthropic("claude-opus-4-8", "Claude Opus 4.8"))
        .thinking(ThinkingLevel::Xhigh)
        .build();
    let body = build_request_body(&config, false);
    assert_eq!(
        body["output_config"]["effort"], "xhigh",
        "Opus 4.8 xhigh should emit xhigh"
    );
}

#[test]
fn test_xhigh_maps_to_max_on_date_suffixed_opus_4_6() {
    // Real ids carry a date suffix; version parsing must still resolve 4.6.
    let id = "claude-opus-4-6-20251101";
    let config = StreamConfigBuilder::anthropic()
        .model(id)
        .model_config(ModelConfig::anthropic(id, "Claude Opus 4.6"))
        .thinking(ThinkingLevel::Xhigh)
        .build();
    let body = build_request_body(&config, false);
    assert_eq!(
        body["output_config"]["effort"], "max",
        "date-suffixed Opus 4.6 xhigh should still emit max"
    );
}

#[test]
fn test_xhigh_defaults_on_future_opus_via_version_gate() {
    // A hypothetical newer Opus needs no table entry: it falls through to xhigh.
    let id = "claude-opus-5-0";
    let config = StreamConfigBuilder::anthropic()
        .model(id)
        .model_config(ModelConfig::anthropic(id, "Claude Opus 5"))
        .thinking(ThinkingLevel::Xhigh)
        .build();
    let body = build_request_body(&config, false);
    assert_eq!(
        body["output_config"]["effort"], "xhigh",
        "future Opus xhigh should default to xhigh"
    );
}

#[test]
fn test_off_thinking_disables_anthropic_thinking() {
    let config = StreamConfigBuilder::anthropic()
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, false);
    // Off explicitly disables thinking (mirrors pi's `{ type: "disabled" }`)
    // rather than omitting the field and falling back to the model default.
    assert_eq!(body["thinking"]["type"], "disabled");
    // Disabled thinking carries no effort bound.
    assert!(body.get("output_config").is_none());
}

#[test]
fn test_off_thinking_is_omitted_for_known_non_reasoning_model() {
    let config = StreamConfigBuilder::anthropic()
        .model("deepseek-chat")
        .model_config(ModelConfig::anthropic("deepseek-chat", "DeepSeek Chat"))
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, false);
    assert!(body.get("thinking").is_none());
    assert!(body.get("output_config").is_none());
}

#[test]
fn test_off_thinking_clamps_to_low_for_fable() {
    // Fable 5's adaptive thinking is always on: an Off request clamps to the
    // lowest supported tier instead of disabling thinking.
    let model_config = ModelConfig::anthropic("claude-fable-5", "Fable 5");
    let config = StreamConfigBuilder::anthropic()
        .model_config(model_config)
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["output_config"]["effort"], "low");
}

#[test]
fn test_anthropic_max_tokens_falls_back_to_model_config() {
    // No explicit max_tokens: use the profile's output budget.
    let config = StreamConfigBuilder::anthropic()
        .no_max_tokens()
        .model_config(ModelConfig::anthropic(
            "claude-sonnet-4-20250514",
            "Claude Sonnet 4",
        ))
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 64_000);
}

#[test]
fn test_anthropic_input_limit_does_not_reduce_output_limit() {
    let model_config = resolved_model_config(
        evotengine::provider::ApiProtocol::AnthropicMessages,
        "anthropic",
        "claude-sonnet-4-20250514",
        "https://api.anthropic.com",
        None,
        Default::default(),
        evotengine::provider::ModelOverrides {
            context_window: Some(10_000),
            ..Default::default()
        },
    );
    let config = StreamConfigBuilder::anthropic()
        .no_max_tokens()
        .messages(vec![Message::user("x".repeat(32_000))])
        .model_config(model_config)
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 64_000);
}

#[test]
fn test_anthropic_max_tokens_uses_large_budget_for_supported_model() {
    // Opus 4.6+ genuinely supports a 128000 output budget, so the fallback
    // should honor it when the model config advertises it.
    let config = StreamConfigBuilder::anthropic()
        .no_max_tokens()
        .model_config(ModelConfig::anthropic("claude-opus-4-6", "Claude Opus 4.6"))
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 128000);
}

#[test]
fn test_anthropic_explicit_max_tokens_wins() {
    let config = StreamConfigBuilder::anthropic()
        .max_tokens(4096)
        .model_config(ModelConfig::anthropic("claude-opus-4-6", "Claude Opus 4.6"))
        .build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 4096);
}

#[test]
fn test_anthropic_max_tokens_default_without_model_config() {
    // No max_tokens and no model config: fall back to a conservative default
    // (8192) instead of the previous oversized 128000 constant.
    let config = StreamConfigBuilder::anthropic().no_max_tokens().build();

    let body = build_request_body(&config, false);
    assert_eq!(body["max_tokens"], 8192);
}

// ---------------------------------------------------------------------------
// Cache breakpoint tests
// ---------------------------------------------------------------------------

#[test]
fn test_cache_auto_places_all_breakpoints() {
    let body = build_request_body(&cache_config(CacheConfig::default()), false);

    let system = &body["system"][0];
    assert_eq!(system["cache_control"]["type"], "ephemeral");

    let tools = body["tools"].as_array().unwrap();
    let last_tool = tools.last().unwrap();
    assert_eq!(last_tool["cache_control"]["type"], "ephemeral");

    let msgs = body["messages"].as_array().unwrap();
    let second_to_last = &msgs[msgs.len() - 2];
    let content = second_to_last["content"].as_array().unwrap();
    let last_block = content.last().unwrap();
    assert_eq!(last_block["cache_control"]["type"], "ephemeral");
}

#[test]
fn test_system_prompt_boundary_splits_dynamic_part_without_cache_control() {
    let config = StreamConfigBuilder::anthropic()
        .system_prompt("stable\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ndynamic")
        .build();

    let body = build_request_body(&config, false);
    let system = body["system"].as_array().unwrap();
    assert_eq!(system.len(), 2);
    assert_eq!(system[0]["text"], "stable");
    assert_eq!(system[0]["cache_control"]["type"], "ephemeral");
    assert_eq!(system[1]["text"], "dynamic");
    assert!(system[1].get("cache_control").is_none());
}

#[test]
fn test_system_prompt_boundary_uses_last_marker() {
    let config = StreamConfigBuilder::anthropic()
        .system_prompt(
            "project mentions __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ literally\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ndynamic",
        )
        .build();

    let body = build_request_body(&config, false);
    let system = body["system"].as_array().unwrap();
    assert_eq!(system.len(), 2);
    assert_eq!(
        system[0]["text"],
        "project mentions __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ literally"
    );
    assert_eq!(system[1]["text"], "dynamic");
}

#[test]
fn test_oauth_system_prompt_boundary_preserves_prelude() {
    let config = StreamConfigBuilder::anthropic()
        .system_prompt("stable\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ndynamic")
        .build();

    let body = build_request_body(&config, true);
    let system = body["system"].as_array().unwrap();
    assert_eq!(system.len(), 3);
    assert_eq!(
        system[0]["text"],
        "You are Claude Code, Anthropic's official CLI for Claude."
    );
    assert!(system[0].get("cache_control").is_none());
    assert_eq!(system[1]["text"], "stable");
    assert_eq!(system[1]["cache_control"]["type"], "ephemeral");
    assert_eq!(system[2]["text"], "dynamic");
    assert!(system[2].get("cache_control").is_none());
}

#[test]
fn test_cache_disabled_no_breakpoints() {
    let config = CacheConfig {
        enabled: false,
        strategy: CacheStrategy::Auto,
    };
    let body = build_request_body(&cache_config(config), false);

    let system = &body["system"][0];
    assert!(system.get("cache_control").is_none());

    let tools = body["tools"].as_array().unwrap();
    assert!(tools.last().unwrap().get("cache_control").is_none());

    let msgs = body["messages"].as_array().unwrap();
    for msg in msgs {
        if let Some(content) = msg["content"].as_array() {
            for block in content {
                assert!(block.get("cache_control").is_none());
            }
        }
    }
}

#[test]
fn test_cache_manual_system_only() {
    let config = CacheConfig {
        enabled: true,
        strategy: CacheStrategy::Manual {
            cache_system: true,
            cache_tools: false,
            cache_messages: false,
        },
    };
    let body = build_request_body(&cache_config(config), false);

    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    assert!(body["tools"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .get("cache_control")
        .is_none());
    let msgs = body["messages"].as_array().unwrap();
    let second = &msgs[msgs.len() - 2];
    let content = second["content"].as_array().unwrap();
    assert!(content.last().unwrap().get("cache_control").is_none());
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

#[test]
fn test_usage_cache_hit_rate() {
    let usage = Usage {
        input: 100,
        output: 50,
        cache_read: 900,
        cache_write: 0,
        total_tokens: 1050,
        reasoning_output: 0,
    };
    let rate = usage.cache_hit_rate();
    assert!((rate - 0.9).abs() < 0.001);

    let empty = Usage::default();
    assert_eq!(empty.cache_hit_rate(), 0.0);
}

// ---------------------------------------------------------------------------
// Tool result serialization
// ---------------------------------------------------------------------------

#[test]
fn test_tool_result_with_image() {
    let config = StreamConfigBuilder::anthropic()
        .cache_disabled()
        .messages(vec![
            Message::Assistant {
                content: vec![Content::ToolCall {
                    id: "tc-1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": "test.png"}),
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
                tool_call_id: "tc-1".into(),
                tool_name: "read".into(),
                content: vec![
                    Content::Text {
                        text: "screenshot".into(),
                    },
                    Content::Image {
                        mime_type: "image/png".into(),
                        source: ImageSource::Base64 {
                            data: "aW1hZ2VkYXRh".into(),
                        },
                    },
                ],
                is_error: false,
                timestamp: 0,
                retention: Retention::Normal,
            },
        ])
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();
    let tool_msg = &msgs[1];
    let tool_result = &tool_msg["content"][0];
    assert_eq!(tool_result["type"], "tool_result");
    let content = tool_result["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["source"]["media_type"], "image/png");
}

#[test]
fn responses_tool_metadata_does_not_leak_into_anthropic_tool_ids() {
    let config = StreamConfigBuilder::anthropic()
        .cache_disabled()
        .messages(vec![
            Message::Assistant {
                content: vec![Content::ToolCall {
                    id: "call_1".into(),
                    name: "bash".into(),
                    arguments: serde_json::json!({"command": "echo hi"}),
                    metadata: Some(ToolCallMetadata::OpenAiResponses {
                        item_id: "fc_1".into(),
                    }),
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
                tool_call_id: "call_1".into(),
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

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs[0]["content"][0]["id"], "call_1");
    let tool_result = &msgs[1]["content"][0];
    assert_eq!(tool_result["tool_use_id"], "call_1");
    assert_eq!(tool_result["content"], "hello");
}

// ---------------------------------------------------------------------------
// Content filtering
// ---------------------------------------------------------------------------

#[test]
fn test_content_to_anthropic_keeps_native_signature_but_downgrades_openai_field_marker() {
    let content = vec![
        Content::Thinking {
            thinking: "native".into(),
            metadata: Some(ThinkingMetadata::Anthropic {
                signature: "cryptographic-signature".into(),
            }),
        },
        Content::Thinking {
            thinking: "cross-provider".into(),
            metadata: Some(ThinkingMetadata::OpenAiCompletions {
                field: ReasoningField::ReasoningContent,
                details: None,
            }),
        },
        Content::Thinking {
            thinking: "unsigned".into(),
            metadata: None,
        },
    ];

    let result = content_to_anthropic(&content);

    assert_eq!(result[0]["type"], "thinking");
    assert_eq!(result[0]["signature"], "cryptographic-signature");
    assert_eq!(result[1]["type"], "text");
    assert_eq!(result[1]["text"], "cross-provider");
    assert_eq!(result[2]["type"], "text");
    assert_eq!(result[2]["text"], "unsigned");
}

#[test]
fn test_content_to_anthropic_filters_empty_text() {
    let content = vec![
        Content::Text { text: "".into() },
        Content::Text {
            text: "hello".into(),
        },
        Content::Text { text: "".into() },
    ];
    let result = content_to_anthropic(&content);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["text"], "hello");
}

#[test]
fn assistant_placeholder_thinking_after_tools_is_dropped() {
    let content = vec![
        Content::Text {
            text: "compare the two renderers".into(),
        },
        Content::ToolCall {
            id: "call_c9cfe266-abac-46ba-be90-bff3dce7313f".into(),
            name: "bash".into(),
            arguments: serde_json::json!({"command": "rg thinking"}),
            metadata: None,
        },
        Content::ToolCall {
            id: "call_06c624bb-8631-4362-bf34-ab956d7c3512".into(),
            name: "bash".into(),
            arguments: serde_json::json!({"command": "rg reasoning"}),
            metadata: None,
        },
        Content::Thinking {
            thinking: "...".into(),
            metadata: Some(ThinkingMetadata::Anthropic {
                signature: "foreign-sig".into(),
            }),
        },
    ];

    let result = assistant_content_to_anthropic(&content);
    assert_eq!(result.len(), 3);
    assert_eq!(result[0]["type"], "text");
    assert_eq!(result[1]["type"], "tool_use");
    assert_eq!(result[1]["id"], "call_c9cfe266-abac-46ba-be90-bff3dce7313f");
    assert_eq!(result[2]["type"], "tool_use");
    assert_eq!(result[2]["id"], "call_06c624bb-8631-4362-bf34-ab956d7c3512");
}

#[test]
fn assistant_meaningful_text_after_tools_moves_before_tool_use() {
    let content = vec![
        Content::Text {
            text: "opening".into(),
        },
        Content::ToolCall {
            id: "call_1".into(),
            name: "read".into(),
            arguments: serde_json::json!({"path": "README.md"}),
            metadata: None,
        },
        Content::Text {
            text: "why I called it".into(),
        },
    ];

    let result = assistant_content_to_anthropic(&content);
    assert_eq!(result.len(), 3);
    assert_eq!(result[0]["type"], "text");
    assert_eq!(result[0]["text"], "opening");
    assert_eq!(result[1]["type"], "text");
    assert_eq!(result[1]["text"], "why I called it");
    assert_eq!(result[2]["type"], "tool_use");
    assert_eq!(result[2]["id"], "call_1");
}

#[test]
fn assistant_placeholder_thinking_without_tools_is_dropped() {
    let content = vec![
        Content::Thinking {
            thinking: "…".into(),
            metadata: None,
        },
        Content::Text {
            text: "answer".into(),
        },
    ];
    let result = assistant_content_to_anthropic(&content);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["type"], "text");
    assert_eq!(result[0]["text"], "answer");
}

// ---------------------------------------------------------------------------
// Cache breakpoint edge cases (empty content blocks)
// ---------------------------------------------------------------------------

/// Messages with alternating roles including an empty-text user message.
fn empty_text_messages() -> Vec<Message> {
    vec![
        Message::user("first message"),
        assistant("ok"),
        Message::User {
            content: vec![Content::Text { text: "".into() }],
            timestamp: 0,
        },
        assistant("sure"),
        Message::user("last"),
    ]
}

#[test]
fn test_empty_text_message_is_removed_before_cache_breakpoint() {
    let config = StreamConfigBuilder::anthropic()
        .system_prompt("You are helpful.")
        .messages(empty_text_messages())
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();

    assert_eq!(msgs.len(), 3);
    assert!(msgs.iter().all(|message| {
        message["content"]
            .as_array()
            .is_some_and(|content| !content.is_empty())
    }));
    let cached_content = msgs[1]["content"].as_array().unwrap();
    assert_eq!(
        cached_content.last().unwrap()["cache_control"]["type"],
        "ephemeral",
        "cache_control should land on the second-to-last remaining message"
    );
}

#[test]
fn test_cache_breakpoint_uses_second_to_last_after_empty_message_removal() {
    let config = StreamConfigBuilder::anthropic()
        .system_prompt("You are helpful.")
        .messages(vec![
            Message::user("first message"),
            assistant("ok"),
            Message::User {
                content: vec![Content::Text { text: "".into() }],
                timestamp: 0,
            },
            assistant("sure"),
            Message::user("last message"),
        ])
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();

    assert_eq!(msgs.len(), 3);
    let cached_content = msgs[1]["content"].as_array().unwrap();
    assert_eq!(
        cached_content.last().unwrap()["cache_control"]["type"],
        "ephemeral"
    );
}

#[test]
fn test_empty_assistant_is_skipped_and_adjacent_users_are_merged() {
    let config = StreamConfigBuilder::anthropic()
        .cache_disabled()
        .messages(vec![
            Message::user("first"),
            Message::Assistant {
                content: vec![Content::Text { text: "".into() }],
                stop_reason: StopReason::Error,
                model: "test".into(),
                provider: "test".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: Some("Empty response".into()),
                response_id: None,
            },
            Message::user("second"),
        ])
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();

    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["role"], "user");
    let user_content = msgs[0]["content"].as_array().unwrap();
    assert_eq!(user_content.len(), 2);
    assert_eq!(user_content[0]["text"], "first");
    assert_eq!(user_content[1]["text"], "second");
    assert!(!body.to_string().contains("[empty response]"));
}

#[test]
fn test_legacy_empty_response_sentinel_is_removed_from_history() {
    let config = StreamConfigBuilder::anthropic()
        .cache_disabled()
        .messages(vec![
            Message::user("first"),
            assistant("[empty response]"),
            Message::user("continue"),
        ])
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();

    assert_eq!(msgs.len(), 1);
    let content = msgs[0]["content"].as_array().unwrap();
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["text"], "first");
    assert_eq!(content[1]["text"], "continue");
    assert!(!body.to_string().contains("[empty response]"));
}

#[test]
fn test_legacy_sentinel_is_only_removed_as_sole_assistant_content() {
    let config = StreamConfigBuilder::anthropic()
        .cache_disabled()
        .messages(vec![
            Message::user("[empty response]"),
            assistant("prefix [empty response] suffix"),
            Message::user("middle"),
            Message::Assistant {
                content: vec![Content::Thinking {
                    thinking: "[empty response]".into(),
                    metadata: None,
                }],
                stop_reason: StopReason::Stop,
                model: "test".into(),
                provider: "other".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: None,
                response_id: None,
            },
            Message::user("continue"),
        ])
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();

    assert_eq!(msgs.len(), 5);
    assert_eq!(msgs[0]["content"][0]["text"], "[empty response]");
    assert_eq!(
        msgs[1]["content"][0]["text"],
        "prefix [empty response] suffix"
    );
    assert_eq!(msgs[3]["content"][0]["text"], "[empty response]");
}

#[test]
fn test_empty_user_and_assistant_messages_are_skipped() {
    let config = StreamConfigBuilder::anthropic()
        .cache_disabled()
        .messages(vec![
            Message::User {
                content: vec![Content::Text { text: "  ".into() }],
                timestamp: 0,
            },
            Message::Assistant {
                content: vec![],
                stop_reason: StopReason::Error,
                model: "test".into(),
                provider: "test".into(),
                usage: Usage::default(),
                timestamp: 0,
                error_message: Some("aborted".into()),
                response_id: None,
            },
            Message::user("continue"),
        ])
        .build();

    let body = build_request_body(&config, false);
    let msgs = body["messages"].as_array().unwrap();

    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["content"][0]["text"], "continue");
}

// ---------------------------------------------------------------------------
// build_messages_url
// ---------------------------------------------------------------------------

#[test]
fn messages_url_appends_v1_for_bare_base() {
    assert_eq!(
        build_messages_url("https://api.anthropic.com"),
        "https://api.anthropic.com/v1/messages"
    );
}

#[test]
fn messages_url_trims_trailing_slash() {
    assert_eq!(
        build_messages_url("https://api.anthropic.com/"),
        "https://api.anthropic.com/v1/messages"
    );
}

#[test]
fn messages_url_does_not_double_v1_suffix() {
    assert_eq!(
        build_messages_url("https://gateway.example.com/anthropic/v1"),
        "https://gateway.example.com/anthropic/v1/messages"
    );
    assert_eq!(
        build_messages_url("https://gateway.example.com/anthropic/v1/"),
        "https://gateway.example.com/anthropic/v1/messages"
    );
}

#[test]
fn messages_url_keeps_v1_only_at_path_end() {
    assert_eq!(
        build_messages_url("https://example.com/v1/proxy"),
        "https://example.com/v1/proxy/v1/messages"
    );
}
