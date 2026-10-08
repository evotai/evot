use evotengine::provider::openai_responses::request::build_request_body;
use evotengine::provider::ModelConfig;
use evotengine::types::*;

use super::super::fixtures::stream_config::*;

#[test]
fn internal_system_prompt_boundary_is_not_sent() {
    let config = StreamConfigBuilder::openai()
        .system_prompt("stable\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ndynamic")
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["input"][0]["content"], "stable\n\ndynamic");
}

#[test]
fn native_openai_request_uses_responses_schema_with_reasoning_and_tools() {
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.5")
        .model_config(ModelConfig::openai_responses("gpt-5.5", "GPT-5.5"))
        .system_prompt("Be helpful")
        .messages(vec![Message::user("List files")])
        .tools(vec![tool_def("bash", "Run a command")])
        .thinking(ThinkingLevel::Medium)
        .prompt_cache_key("session-123")
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["model"], "gpt-5.5");
    assert_eq!(body["input"][0]["role"], "developer");
    assert_eq!(body["input"][1]["content"][0]["type"], "input_text");
    assert_eq!(body["tools"][0]["name"], "bash");
    assert!(body["tools"][0].get("function").is_none());
    assert_eq!(body["reasoning"]["effort"], "medium");
    assert_eq!(body["reasoning"]["summary"], "auto");
    assert!(body.get("messages").is_none());
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("max_output_tokens").is_none());
    assert!(body.get("temperature").is_none());
    assert_eq!(body["text"]["verbosity"], "low");
    assert_eq!(body["store"], false);
    assert_eq!(body["prompt_cache_key"], "session-123");
}

#[test]
fn same_named_openai_proxy_keeps_openai_transport_but_omits_route_extensions() {
    let model = resolved_model_config(
        evotengine::provider::ApiProtocol::OpenAiResponses,
        "openai",
        "gpt-5.6-sol",
        "https://proxy.example.com/v1",
        Some(evotengine::provider::OpenAiCompat::for_provider("openai")),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.6-sol")
        .model_config(model)
        .system_prompt("Be helpful")
        .prompt_cache_key("session-123")
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["input"][0]["role"], "developer");
    assert_eq!(body["store"], false);
    assert_eq!(body["prompt_cache_key"], "session-123");
    assert_eq!(body["reasoning"]["effort"], "none");
    assert!(body["reasoning"].get("summary").is_none());
    assert!(body.get("text").is_none());
}

#[test]
fn responses_proxy_can_explicitly_enable_route_extensions() {
    let compat = evotengine::provider::OpenAiCompat::for_provider("openai");
    let model = resolved_model_config(
        evotengine::provider::ApiProtocol::OpenAiResponses,
        "openai",
        "gpt-5.6-sol",
        "https://proxy.example.com/v1",
        Some(compat),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.6-sol")
        .model_config(model)
        .system_prompt("Be helpful")
        .prompt_cache_key("session-123")
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["input"][0]["role"], "developer");
    assert_eq!(body["store"], false);
    assert_eq!(body["prompt_cache_key"], "session-123");
}

#[test]
fn non_gpt_responses_keeps_output_budget_without_temperature() {
    let model = resolved_model_config(
        evotengine::provider::ApiProtocol::OpenAiResponses,
        "openai",
        "grok-4.5",
        "https://api.openai.com/v1",
        Some(evotengine::provider::OpenAiCompat::openai()),
        Default::default(),
        evotengine::provider::ModelOverrides {
            reasoning: Some(false),
            ..Default::default()
        },
    );
    let config = StreamConfigBuilder::openai()
        .model("grok-4.5")
        .model_config(model)
        .build();

    let body = build_request_body(&config);
    assert!(body["max_output_tokens"].is_number());
    assert!(body.get("temperature").is_none());
}

#[test]
fn non_gpt_responses_does_not_raise_output_cap_to_transport_minimum() {
    let model = resolved_model_config(
        evotengine::provider::ApiProtocol::OpenAiResponses,
        "custom",
        "small-output-model",
        "https://example.com/v1",
        Some(evotengine::provider::OpenAiCompat::default()),
        Default::default(),
        evotengine::provider::ModelOverrides {
            max_output_tokens: Some(8),
            reasoning: Some(false),
            ..Default::default()
        },
    );
    let config = StreamConfigBuilder::openai()
        .model("small-output-model")
        .model_config(model)
        .max_tokens(32)
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["max_output_tokens"], 8);
}

#[test]
fn first_party_gpt_5_6_responses_off_sends_none_effort() {
    for id in [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-6-sol",
        "gpt-6-luna",
    ] {
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(ModelConfig::openai_responses(id, id))
            .thinking(ThinkingLevel::Off)
            .build();

        let body = build_request_body(&config);
        assert_eq!(body["reasoning"]["effort"], "none", "{id}");
        assert!(body["reasoning"].get("summary").is_none(), "{id}");
    }
}

#[test]
fn mandatory_reasoning_gpt_6_responses_off_clamps_to_low_effort() {
    // GPT-6 Astra and GPT-6.1 Sol reject `effort: none`; `off` clamps to `low`.
    for id in ["gpt-6-astra", "gpt-6.1-sol"] {
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(ModelConfig::openai_responses(id, id))
            .thinking(ThinkingLevel::Off)
            .build();

        let body = build_request_body(&config);
        assert_eq!(body["reasoning"]["effort"], "low", "{id}");
        assert_eq!(body["reasoning"]["summary"], "auto", "{id}");
    }
}

#[test]
fn github_copilot_responses_off_uses_model_none_effort() {
    // Reasoning support belongs to the model profile, not the provider identity.
    let model = resolved_model_config(
        evotengine::provider::ApiProtocol::OpenAiResponses,
        "github-copilot",
        "gpt-5.6-sol",
        "https://api.githubcopilot.com",
        Some(evotengine::provider::OpenAiCompat::openai()),
        Default::default(),
        Default::default(),
    );
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.6-sol")
        .model_config(model)
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["reasoning"]["effort"], "none");
    assert!(body["reasoning"].get("summary").is_none());
    assert!(body.get("include").is_none());
    assert!(body.get("text").is_none());
}

#[test]
fn uncatalogued_gpt_and_codex_pass_medium_through() {
    for id in ["codex-mini", "gpt-5.7-nova"] {
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(ModelConfig::openai_responses(id, id))
            .thinking(ThinkingLevel::Medium)
            .build();

        let body = build_request_body(&config);
        assert_eq!(body["reasoning"]["effort"], "medium", "{id}");
        assert!(body.get("text").is_none(), "{id}");
    }
}

#[test]
fn responses_off_uses_fallback_model_none_effort() {
    // The pre-5.6 uncatalogued GPT fallback explicitly declares `off -> "none"`.
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.3-mini")
        .model_config(ModelConfig::openai_responses(
            "gpt-5.3-mini",
            "GPT-5.3 Mini",
        ))
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["reasoning"]["effort"], "none");
    assert!(body["reasoning"].get("summary").is_none());
}

#[test]
fn responses_off_on_newer_uncatalogued_gpt_clamps_to_low() {
    // Uncatalogued GPT-5.6+ successors stay conservative and omit `none`.
    let config = StreamConfigBuilder::openai()
        .model("gpt-5.7-nova")
        .model_config(ModelConfig::openai_responses(
            "gpt-5.7-nova",
            "GPT-5.7 Nova",
        ))
        .thinking(ThinkingLevel::Off)
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["reasoning"]["effort"], "low");
}

#[test]
fn verbosity_is_only_sent_for_profiled_current_models() {
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
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(ModelConfig::openai_responses(id, id))
            .build();
        let body = build_request_body(&config);
        assert_eq!(body["text"]["verbosity"], "low", "{id}");
    }

    for id in ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5-pro", "gpt-5.7-nova"] {
        let config = StreamConfigBuilder::openai()
            .model(id)
            .model_config(ModelConfig::openai_responses(id, id))
            .build();
        let body = build_request_body(&config);
        assert!(body.get("text").is_none(), "{id}");
    }
}

#[test]
fn responses_replays_function_call_and_tool_output() {
    let assistant = Message::Assistant {
        content: vec![
            Content::Thinking {
                thinking: "summary".into(),
                metadata: Some(ThinkingMetadata::OpenAiResponses {
                    item: serde_json::json!({
                        "type": "reasoning",
                        "id": "rs_1",
                        "summary": [{"type": "summary_text", "text": "summary"}],
                        "encrypted_content": "enc",
                    }),
                }),
            },
            Content::ToolCall {
                id: "call_1".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "pwd"}),
                metadata: Some(ToolCallMetadata::OpenAiResponses {
                    item_id: "fc_1".into(),
                }),
            },
        ],
        stop_reason: StopReason::ToolUse,
        model: "gpt-5.5".into(),
        provider: "openai".into(),
        usage: Usage::default(),
        timestamp: 1,
        error_message: None,
        response_id: None,
    };
    let result = Message::ToolResult {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        content: vec![Content::Text {
            text: "/tmp".into(),
        }],
        is_error: false,
        timestamp: 2,
        retention: Retention::Normal,
    };
    let config = StreamConfigBuilder::openai()
        .messages(vec![assistant, result])
        .build();

    let body = build_request_body(&config);
    assert_eq!(body["input"][0]["type"], "reasoning");
    assert_eq!(body["input"][0]["id"], "rs_1");
    assert_eq!(body["input"][1]["type"], "function_call");
    assert_eq!(body["input"][1]["id"], "fc_1");
    assert_eq!(body["input"][1]["call_id"], "call_1");
    assert_eq!(body["input"][2]["type"], "function_call_output");
    assert_eq!(body["input"][2]["call_id"], "call_1");
    assert_eq!(body["input"][2]["output"], "/tmp");
}
