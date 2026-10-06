//! Tests for the summarizer subsystem.

#[test]
fn summary_preserves_background_context_without_attributing_events_to_the_user() {
    let system = evotengine::context::compaction::summarizer::prompt::SYSTEM_PROMPT;
    assert!(system.contains("Distinguish user requests from automated <task-notification> events"));
    assert!(system.contains("both use the user role"));
    assert!(system.contains("background-task IDs, descriptions, status"));
    assert!(system.contains("output locations alongside pending work"));
    assert!(system.contains("Preserve the user's language preferences"));
}

use std::sync::Arc;

use evotengine::context::compaction::emergency;
use evotengine::context::compaction::summarizer::llm;
use evotengine::context::compaction::summarizer::mode::SummarizerContext;
use evotengine::context::compaction::summarizer::mode::SummarizerMode;
use evotengine::context::compaction::summarizer::prompt;
use evotengine::context::compaction::summarizer::serialize;
use evotengine::context::compaction::summarizer::types::SummarizerError;
use evotengine::context::compaction::summarizer::types::SummarizerInput;
use evotengine::context::compaction::summarizer::types::SummarizerOutput;
use evotengine::context::compaction::types::CompactionState;
use evotengine::context::compaction::types::FileOps;
use evotengine::context::CompactionConfig;
use evotengine::context::DEFAULT_SUMMARY_MAX_BYTES;
use evotengine::context::SUMMARIZER_INPUT_MAX_BYTES;
use evotengine::types::*;
use tokio_util::sync::CancellationToken;

use super::fixtures::recording_provider::Captured;
use super::fixtures::recording_provider::RecordingProvider;
use super::fixtures::recording_provider::Reply;

fn user_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::User {
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        timestamp: 0,
    })
}

fn assistant_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        stop_reason: StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn tool_call_msg(id: &str, name: &str, path: &str) -> AgentMessage {
    let mut args = serde_json::Map::new();
    args.insert(
        "path".to_string(),
        serde_json::Value::String(path.to_string()),
    );
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: serde_json::Value::Object(args),
            metadata: None,
        }],
        stop_reason: StopReason::ToolUse,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    })
}

fn tool_result_msg(id: &str, content: &str) -> AgentMessage {
    AgentMessage::Llm(Message::ToolResult {
        tool_call_id: id.to_string(),
        tool_name: "read".to_string(),
        content: vec![Content::Text {
            text: content.to_string(),
        }],
        is_error: false,
        timestamp: 0,
        retention: Retention::Normal,
    })
}

// ---------------------------------------------------------------------------
// serialize tests
// ---------------------------------------------------------------------------

#[test]
fn serialize_messages_formats_user_and_assistant() {
    let messages = vec![user_msg("Fix the bug"), assistant_msg("I'll look into it")];
    let text = serialize::serialize_messages(&messages);
    assert!(text.contains("[User]: Fix the bug"));
    assert!(text.contains("[Assistant]: I'll look into it"));
}

#[test]
fn serialize_messages_formats_tool_calls() {
    let messages = vec![tool_call_msg("c1", "read", "/src/main.rs")];
    let text = serialize::serialize_messages(&messages);
    assert!(text.contains("[Assistant tool calls]:"));
    assert!(text.contains("read("));
    assert!(text.contains("/src/main.rs"));
}

#[test]
fn serialize_messages_truncates_long_tool_results() {
    let long_content = "x".repeat(5000);
    let messages = vec![tool_result_msg("c1", &long_content)];
    let text = serialize::serialize_messages(&messages);
    assert!(text.contains("[Tool result]:"));
    assert!(text.contains("more characters truncated"));
    // Should be much shorter than the original
    assert!(text.len() < 3000);
}

#[test]
fn serialize_messages_truncates_multibyte_tool_results_at_char_boundary() {
    // Regression: the 2000-byte truncation budget must snap to a char boundary.
    // Devanagari characters are 3 bytes, so a fixed `&text[..2000]` slice lands
    // mid-codepoint and panics. Pad so byte 2000 falls inside a multi-byte char.
    let content = format!("{}ग्राहक वॉलेट", "a".repeat(1999));
    assert!(
        !content.is_char_boundary(2000),
        "test setup: byte 2000 must split a char"
    );
    let messages = vec![tool_result_msg("c1", &content)];

    // Must not panic on the non-boundary byte index.
    let text = serialize::serialize_messages(&messages);
    assert!(text.contains("more characters truncated"));
}

#[test]
fn serialize_messages_includes_thinking() {
    let msg = AgentMessage::Llm(Message::Assistant {
        content: vec![
            Content::Thinking {
                thinking: "Let me analyze this".to_string(),
                metadata: None,
            },
            Content::Text {
                text: "Here's my answer".to_string(),
            },
        ],
        stop_reason: StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    });
    let text = serialize::serialize_messages(&[msg]);
    assert!(text.contains("[Assistant thinking]: Let me analyze this"));
    assert!(text.contains("[Assistant]: Here's my answer"));
}

#[test]
fn abbreviated_serialization_omits_thinking_arguments_and_tool_output() {
    let messages = vec![
        AgentMessage::Llm(Message::Assistant {
            content: vec![
                Content::Thinking {
                    thinking: "private detailed reasoning".into(),
                    metadata: None,
                },
                Content::ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": "/secret/large.rs"}),
                    metadata: None,
                },
            ],
            stop_reason: StopReason::ToolUse,
            model: "test".into(),
            provider: "test".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }),
        tool_result_msg("c1", &"x".repeat(5_000)),
    ];

    let text = serialize::serialize_messages_bounded_with_options(
        &messages,
        usize::MAX,
        serialize::SerializationOptions {
            abbreviate_tools: true,
        },
    );
    assert!(text.contains("[Assistant tool calls]: read"));
    assert!(text.contains("[Tool result: read, status=ok, details omitted]"));
    assert!(!text.contains("private detailed reasoning"));
    assert!(!text.contains("/secret/large.rs"));
    assert!(!text.contains(&"x".repeat(100)));
}

#[test]
fn prepare_input_extracts_all_fields() {
    let messages = vec![
        user_msg("Fix the config"),
        tool_call_msg("c1", "edit", "/src/config.rs"),
        tool_result_msg("c1", "ok"),
        assistant_msg("Config has been fixed with the new approach"),
    ];
    let config = CompactionConfig::default();
    let input = serialize::prepare_input(&messages, None, None, &config);

    assert_eq!(input.evicted_count, 4);
    assert!(!input.completed_requests.is_empty());
    assert!(input.completed_requests[0].contains("Fix the config"));
    assert!(input.file_ops.edited.contains("/src/config.rs"));
    assert!(input.last_conclusion.is_some());
    assert!(input.conversation.contains("[User]: Fix the config"));
    assert!(input.turn_prefix.is_none());
    assert!(input.previous_summary.is_none());
}

#[test]
fn prepare_input_with_split_prefix() {
    let messages = vec![user_msg("task 1"), assistant_msg("done")];
    let prefix = vec![user_msg("big task"), tool_call_msg("c1", "read", "/a.rs")];
    let config = CompactionConfig::default();
    let input = serialize::prepare_input(&messages, Some(&prefix), None, &config);

    match input.turn_prefix.as_ref() {
        Some(prefix) => assert!(prefix.contains("big task")),
        None => panic!("expected split turn prefix"),
    }
}

#[test]
fn prepare_input_bounds_multi_megabyte_history_and_legacy_state() {
    let first = format!("FIRST_GOAL\n{}", "a".repeat(2_300_000));
    let latest = format!("LATEST_PROGRESS\n{}", "z".repeat(2_300_000));
    let messages = vec![user_msg(&first), assistant_msg(&latest)];
    let state = CompactionState {
        last_summary: Some(format!("PREVIOUS_CONTEXT\n{}", "p".repeat(200_000))),
        ..CompactionState::default()
    };

    let config = CompactionConfig::from_context_window(1_000_000);
    let input = serialize::prepare_input(&messages, Some(&messages), Some(&state), &config);
    let previous = match input.previous_summary.as_deref() {
        Some(previous) => previous,
        None => panic!("expected previous summary"),
    };
    let prefix = match input.turn_prefix.as_deref() {
        Some(prefix) => prefix,
        None => panic!("expected turn prefix"),
    };

    assert!(previous.len() <= DEFAULT_SUMMARY_MAX_BYTES);
    assert!(input.conversation.len() + previous.len() <= SUMMARIZER_INPUT_MAX_BYTES);
    assert!(prefix.len() <= SUMMARIZER_INPUT_MAX_BYTES);
    assert!(input.conversation.contains("FIRST_GOAL"));
    assert!(input.conversation.contains("LATEST_PROGRESS"));
    assert!(input.conversation.contains("middle messages omitted"));
    assert!(prefix.contains("FIRST_GOAL"));
    assert!(prefix.contains("LATEST_PROGRESS"));
}

// ---------------------------------------------------------------------------
// emergency summary tests
// ---------------------------------------------------------------------------

#[test]
fn emergency_includes_message_count() {
    let input = SummarizerInput {
        conversation: String::new(),
        turn_prefix: None,
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops: FileOps::default(),
        evicted_count: 15,
        completed_requests: vec![],
        env_discoveries: vec![],
        last_conclusion: None,
    };
    let output = emergency::summarize(&input);
    assert!(output.summary.contains("15 messages removed"));
}

#[test]
fn emergency_includes_completed_requests() {
    let input = SummarizerInput {
        conversation: String::new(),
        turn_prefix: None,
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops: FileOps::default(),
        evicted_count: 5,
        completed_requests: vec!["Fix bug #123".into(), "Add tests".into()],
        env_discoveries: vec![],
        last_conclusion: None,
    };
    let output = emergency::summarize(&input);
    assert!(output.summary.contains("Completed requests"));
    assert!(output.summary.contains("Fix bug #123"));
    assert!(output.summary.contains("Add tests"));
}

#[test]
fn emergency_includes_file_ops() {
    let mut file_ops = FileOps::default();
    file_ops.edited.insert("/src/main.rs".into());
    file_ops.read.insert("/src/lib.rs".into());

    let input = SummarizerInput {
        conversation: String::new(),
        turn_prefix: None,
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops,
        evicted_count: 5,
        completed_requests: vec![],
        env_discoveries: vec![],
        last_conclusion: None,
    };
    let output = emergency::summarize(&input);
    assert!(output.summary.contains("Files modified"));
    assert!(output.summary.contains("/src/main.rs"));
    assert!(output.summary.contains("Files read"));
    assert!(output.summary.contains("/src/lib.rs"));
}

#[test]
fn emergency_includes_conclusion() {
    let input = SummarizerInput {
        conversation: String::new(),
        turn_prefix: None,
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops: FileOps::default(),
        evicted_count: 3,
        completed_requests: vec![],
        env_discoveries: vec![],
        last_conclusion: Some("All tests pass now".into()),
    };
    let output = emergency::summarize(&input);
    assert!(output.summary.contains("Last assistant conclusion"));
    assert!(output.summary.contains("All tests pass now"));
}

#[test]
fn emergency_includes_turn_prefix() {
    let input = SummarizerInput {
        conversation: String::new(),
        turn_prefix: Some(
            "User asked: refactor auth module\nTools used: read(/src/auth.rs)".into(),
        ),
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops: FileOps::default(),
        evicted_count: 10,
        completed_requests: vec![],
        env_discoveries: vec![],
        last_conclusion: None,
    };
    let output = emergency::summarize(&input);
    assert!(output.summary.contains("Current turn context"));
    assert!(output.summary.contains("refactor auth module"));
}

// ---------------------------------------------------------------------------
// mode dispatch tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mode_llm_without_context_returns_error() {
    let input = SummarizerInput {
        conversation: "[User]: hello".into(),
        turn_prefix: None,
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops: FileOps::default(),
        evicted_count: 2,
        completed_requests: vec![],
        env_discoveries: vec![],
        last_conclusion: None,
    };
    let cancel = CancellationToken::new();
    let mode = SummarizerMode::Llm {
        reserve_tokens: 4096,
    };
    let result = mode.summarize(input, None, cancel).await;
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// LLM summarize — request-boundary tests (captures prompts via RecordingProvider)
// ---------------------------------------------------------------------------

fn base_input(conversation: &str) -> SummarizerInput {
    SummarizerInput {
        conversation: conversation.into(),
        turn_prefix: None,
        previous_summary: None,
        custom_instructions: None,
        request_max_bytes: SUMMARIZER_INPUT_MAX_BYTES,
        file_ops: FileOps::default(),
        evicted_count: 1,
        completed_requests: vec![],
        env_discoveries: vec![],
        last_conclusion: None,
    }
}

async fn summarize_capturing_with_model_config(
    input: SummarizerInput,
    max_tokens: u32,
    replies: Vec<Reply>,
    model_config: Option<evotengine::provider::ModelConfig>,
) -> (Result<SummarizerOutput, SummarizerError>, Captured) {
    let provider = Arc::new(RecordingProvider::new(replies));
    let captured = provider.captured();
    let ctx = SummarizerContext {
        provider,
        model: "test-model".into(),
        api_key: "test-key".into(),
        thinking_level: ThinkingLevel::Off,
        system_prompt: String::new(),
        tools: vec![],
        max_tokens: None,
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config,
    };
    let result = llm::summarize(input, &ctx, max_tokens, CancellationToken::new()).await;
    (result, captured)
}

async fn summarize_capturing(
    input: SummarizerInput,
    max_tokens: u32,
    replies: Vec<Reply>,
) -> (Result<SummarizerOutput, SummarizerError>, Captured) {
    summarize_capturing_with_model_config(input, max_tokens, replies, None).await
}

fn first_user_prompt(captured: &Captured) -> String {
    let requests = captured.lock();
    let config = match requests.first() {
        Some(config) => config,
        None => panic!("expected at least one captured request"),
    };
    match config.messages.first() {
        Some(Message::User { content, .. }) => content
            .iter()
            .filter_map(|c| match c {
                Content::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>(),
        _ => String::new(),
    }
}

#[tokio::test]
async fn llm_summarize_preserves_custom_transport_model_config() {
    let model_config =
        evotengine::provider::ModelConfig::resolve(evotengine::provider::ResolveModelRequest {
            protocol: evotengine::provider::ApiProtocol::AnthropicMessages,
            provider: "kimi-coding".into(),
            model_id: "kimi-for-coding".into(),
            base_url: "https://api.kimi.com/coding".into(),
            headers: Default::default(),
            compat: None,
            route_capabilities: Default::default(),
            overrides: Default::default(),
        });
    let (result, captured) = summarize_capturing_with_model_config(
        base_input("[User]: compact this"),
        4096,
        vec![Reply::text("summary")],
        Some(model_config),
    )
    .await;

    assert!(result.is_ok());
    let requests = captured.lock();
    let request = requests
        .first()
        .unwrap_or_else(|| panic!("expected request"));
    let config = request
        .model_config
        .as_ref()
        .unwrap_or_else(|| panic!("expected model config"));
    assert_eq!(config.provider(), "kimi-coding");
    assert_eq!(config.base_url(), "https://api.kimi.com/coding");
}

#[test]
fn extract_summary_parses_tags_and_falls_back_to_raw() {
    assert_eq!(
        prompt::extract_summary("<summary>\n## Goal\nFix bug\n</summary>"),
        "## Goal\nFix bug"
    );
    assert_eq!(
        prompt::extract_summary("<summary>## Goal\nNo closing tag"),
        "## Goal\nNo closing tag"
    );
    assert_eq!(
        prompt::extract_summary("## Goal\nNo tags at all"),
        "## Goal\nNo tags at all"
    );
    assert_eq!(
        prompt::extract_summary("Preamble\n<SUMMARY>\nInner\n</SUMMARY>\nTrailing"),
        "Inner"
    );
}

#[tokio::test]
async fn llm_summarize_initial_uses_initial_prompt() {
    let (result, captured) =
        summarize_capturing(base_input("[User]: fix the bug"), 4096, vec![Reply::text(
            "## Goal\nFix the bug",
        )])
        .await;
    assert!(result.is_ok());
    let prompt = first_user_prompt(&captured);
    assert!(prompt.contains("<conversation>"));
    assert!(prompt.contains("fix the bug"));
    // Initial prompt asks for the structured checkpoint, not an update.
    assert!(prompt.contains("structured context"));
    assert!(!prompt.contains("<previous-summary>"));
}

#[tokio::test]
async fn llm_summarize_injects_previous_summary() {
    let mut input = base_input("[User]: continue the work");
    input.previous_summary = Some("EARLIER SUMMARY TEXT".into());
    let (result, captured) =
        summarize_capturing(input, 4096, vec![Reply::text("## Goal\nContinue")]).await;
    assert!(result.is_ok());
    let prompt = first_user_prompt(&captured);
    assert!(prompt.contains("<previous-summary>\nEARLIER SUMMARY TEXT\n</previous-summary>"));
}

#[tokio::test]
async fn llm_summarize_adds_convergence_guidance_above_soft_cap() {
    let mut input = base_input("[User]: continue");
    // Four ASCII chars per estimated token in the engine estimator.
    input.previous_summary = Some("x".repeat((llm::DEFAULT_SUMMARY_SOFT_CAP_TOKENS + 1) * 4));
    let (result, captured) = summarize_capturing(input, 4096, vec![Reply::text("condensed")]).await;
    assert!(result.is_ok());
    let prompt = first_user_prompt(&captured);
    assert!(prompt.contains("Keep the updated summary near the current summary's length"));
    assert!(prompt.contains("Condense or remove the least important details"));
}

#[tokio::test]
async fn llm_summarize_bounds_complete_prompts() {
    let limit = 4_096;
    let mut input = base_input(&format!("CONVERSATION_HEAD\n{}", "会".repeat(20_000)));
    input.previous_summary = Some(format!("PREVIOUS_HEAD\n{}", "旧".repeat(20_000)));
    input.custom_instructions = Some(format!("FOCUS_HEAD\n{}", "重".repeat(20_000)));
    input.turn_prefix = Some(format!("PREFIX_HEAD\n{}", "前".repeat(20_000)));
    input.request_max_bytes = limit;

    let (result, captured) = summarize_capturing(input, 4_096, vec![
        Reply::text("main"),
        Reply::text("prefix"),
    ])
    .await;

    assert!(result.is_ok());
    let requests = captured.lock();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
        let prompt = match request.messages.first() {
            Some(Message::User { content, .. }) => content
                .iter()
                .filter_map(|block| match block {
                    Content::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
            _ => panic!("expected summarizer user prompt"),
        };
        assert!(prompt.len() <= limit, "prompt was {} bytes", prompt.len());
        assert!(std::str::from_utf8(prompt.as_bytes()).is_ok());
    }
}

#[tokio::test]
async fn llm_summarize_merges_turn_prefix_with_halved_budget() {
    let mut input = base_input("[User]: big request");
    input.turn_prefix = Some("[User]: prefix of the split turn".into());
    let (result, captured) = summarize_capturing(input, 4096, vec![
        Reply::text("## Goal\nMain summary"),
        Reply::text("## Original Request\nPrefix summary"),
    ])
    .await;
    let output = match result {
        Ok(output) => output,
        Err(e) => panic!("expected summary, got {e:?}"),
    };
    assert!(output.summary.contains("Main summary"));
    assert!(output.summary.contains("**Turn Context (split turn):**"));
    assert!(output.summary.contains("Prefix summary"));

    let requests = captured.lock();
    assert_eq!(requests.len(), 2, "split turn issues two LLM calls");
    assert_eq!(
        requests[0].max_tokens,
        Some(4096),
        "main budget uses the configured summary reserve"
    );
    assert_eq!(
        requests[1].max_tokens,
        Some(2048),
        "prefix budget is 50% of reserve"
    );
}

#[tokio::test]
async fn llm_summarize_split_turn_without_history_skips_main_request() {
    let mut input = base_input("");
    input.turn_prefix = Some("[User]: prefix of the split turn".into());
    let (result, captured) = summarize_capturing(input, 16_384, vec![Reply::text(
        "## Original Request\nPrefix",
    )])
    .await;

    let output = match result {
        Ok(output) => output,
        Err(error) => panic!("expected summary, got {error:?}"),
    };
    assert!(output.summary.starts_with("No prior history."));
    assert!(output.summary.contains("Prefix"));
    let requests = captured.lock();
    assert_eq!(
        requests.len(),
        1,
        "empty history must not issue a main call"
    );
    assert_eq!(requests[0].max_tokens, Some(8192));
}

#[tokio::test]
async fn llm_summarize_appends_file_ops_xml() {
    let mut input = base_input("[User]: touch files");
    input.file_ops.read.insert("src/lib.rs".into());
    input.file_ops.edited.insert("src/main.rs".into());
    let (result, _captured) =
        summarize_capturing(input, 4096, vec![Reply::text("## Goal\nWork")]).await;
    let output = match result {
        Ok(output) => output,
        Err(e) => panic!("expected summary, got {e:?}"),
    };
    assert!(output.summary.contains("<read-files>"));
    assert!(output.summary.contains("src/lib.rs"));
    assert!(output.summary.contains("<modified-files>"));
    assert!(output.summary.contains("src/main.rs"));
}

#[tokio::test]
async fn llm_summarize_uses_system_prompt() {
    let (_result, captured) =
        summarize_capturing(base_input("[User]: hi"), 4096, vec![Reply::text(
            "## Goal\nx",
        )])
        .await;
    let requests = captured.lock();
    assert!(requests[0]
        .system_prompt
        .contains("context summarization assistant"));
}

#[tokio::test]
async fn llm_summarize_propagates_provider_error() {
    let (result, _captured) =
        summarize_capturing(base_input("[User]: hi"), 4096, vec![Reply::error(
            "provider exploded",
        )])
        .await;
    match result {
        Err(SummarizerError::Failed(msg)) => assert!(msg.contains("provider exploded")),
        other => panic!("expected Failed error, got {other:?}"),
    }
}

#[tokio::test]
async fn llm_summarize_propagates_cancellation() {
    let (result, _captured) =
        summarize_capturing(base_input("[User]: hi"), 4096, vec![Reply::Cancel]).await;
    assert!(matches!(result, Err(SummarizerError::Cancelled)));
}
