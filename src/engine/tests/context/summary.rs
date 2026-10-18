//! Tests for the shared summary strategy chain.

use std::sync::Arc;

use evotengine::context::compaction::summary;
use evotengine::context::compaction::summary::LlmPolicy;
use evotengine::context::compaction::summary::SummaryContexts;
use evotengine::context::compaction::summary::SummaryOutcome;
use evotengine::context::compaction::summary::SummaryRequest;
use evotengine::context::CompactionConfig;
use evotengine::context::SummarizerContext;
use evotengine::types::*;
use tokio_util::sync::CancellationToken;

use super::fixtures::recording_provider::RecordingProvider;
use super::fixtures::recording_provider::Reply;

fn context(model: &str, provider: Arc<RecordingProvider>) -> SummarizerContext {
    SummarizerContext {
        provider,
        model: model.into(),
        api_key: "key".into(),
        thinking_level: ThinkingLevel::Off,
        system_prompt: String::new(),
        tools: vec![],
        max_tokens: Some(4096),
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        model_config: None,
    }
}

fn user(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![Content::Text { text: text.into() }],
        timestamp: 0,
    })
}

fn tool_turn() -> Vec<AgentMessage> {
    vec![
        AgentMessage::Llm(Message::Assistant {
            content: vec![
                Content::Thinking {
                    thinking: "large private reasoning".into(),
                    metadata: None,
                },
                Content::ToolCall {
                    id: "call-1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({"path": "/large/private/file.rs"}),
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
        AgentMessage::Llm(Message::ToolResult {
            tool_call_id: "call-1".into(),
            tool_name: "read".into(),
            content: vec![Content::Text {
                text: "TOOL_PAYLOAD".repeat(500),
            }],
            is_error: false,
            timestamp: 0,
            retention: Retention::Normal,
        }),
    ]
}

async fn run(messages: &[AgentMessage], contexts: SummaryContexts<'_>) -> summary::SummaryResult {
    let outcome = summary::summarize(
        SummaryRequest {
            evicted: messages,
            turn_prefix: None,
            prev_state: None,
            custom_instructions: None,
            file_ops: Default::default(),
            override_text: None,
        },
        contexts,
        &CompactionConfig::default(),
        summary::SummaryOptions {
            llm_policy: LlmPolicy::Required,
            timeout: None,
            observer: None,
            cancel: CancellationToken::new(),
        },
    )
    .await;
    match outcome {
        SummaryOutcome::Ready(result) => result,
        SummaryOutcome::Aborted => panic!("summary chain aborted"),
        SummaryOutcome::Cancelled => panic!("summary chain cancelled"),
    }
}

#[test]
fn request_overhead_uses_active_model_shape() {
    let provider = Arc::new(RecordingProvider::new(vec![]));
    let mut active = context("active", provider.clone());
    active.system_prompt = "active system prompt".into();
    active.tools = vec![evotengine::provider::ToolDefinition {
        name: "read".into(),
        description: "Read a file".into(),
        parameters: serde_json::json!({"type": "object"}),
    }];
    let mut summary_model = context("summary", provider);
    summary_model.system_prompt = "ignored dedicated summary prompt".repeat(100);

    let contexts = SummaryContexts::separate(Some(&active), Some(&summary_model), None);
    let tools = match serde_json::to_string(&active.tools) {
        Ok(tools) => tools,
        Err(error) => panic!("tool definitions must serialize: {error}"),
    };
    assert_eq!(
        contexts.request_overhead_tokens(),
        evotengine::context::estimate_tokens(&active.system_prompt)
            + evotengine::context::estimate_tokens(&tools)
    );
}

#[tokio::test]
async fn missing_llm_context_uses_deterministic_summary() {
    let outcome = summary::summarize(
        SummaryRequest {
            evicted: &[user("history")],
            turn_prefix: None,
            prev_state: None,
            custom_instructions: None,
            file_ops: Default::default(),
            override_text: None,
        },
        SummaryContexts::default(),
        &CompactionConfig::default(),
        summary::SummaryOptions {
            llm_policy: LlmPolicy::Required,
            timeout: None,
            observer: None,
            cancel: CancellationToken::new(),
        },
    )
    .await;
    let SummaryOutcome::Ready(result) = outcome else {
        panic!("missing LLM context should use deterministic summary");
    };
    assert!(result.used_fallback);
    assert!(!result.text.is_empty());
}

#[tokio::test]
async fn unsupported_remote_is_not_reported_as_a_failure() {
    let provider = Arc::new(RecordingProvider::new(vec![Reply::text("LOCAL SUMMARY")]));
    let ctx = context("local", provider);
    let result = run(&[user("history")], SummaryContexts::same(Some(&ctx))).await;
    assert_eq!(result.method, evotengine::context::CompactionMethod::Local);
    assert_eq!(result.fallback_reason, None);
    assert!(!result.used_fallback);
}

#[tokio::test]
async fn tiny_window_caps_summary_generation_and_storage() {
    let provider = Arc::new(RecordingProvider::new(vec![Reply::text(format!(
        "<summary>{}</summary>",
        "x".repeat(5_000)
    ))]));
    let captured = provider.captured();
    let ctx = context("tiny", provider);
    let config = CompactionConfig::from_context_window(1_000);
    let outcome = summary::summarize(
        SummaryRequest {
            evicted: &[user("history")],
            turn_prefix: None,
            prev_state: None,
            custom_instructions: None,
            file_ops: Default::default(),
            override_text: None,
        },
        SummaryContexts::separate(None, Some(&ctx), None),
        &config,
        summary::SummaryOptions {
            llm_policy: LlmPolicy::Required,
            timeout: None,
            observer: None,
            cancel: CancellationToken::new(),
        },
    )
    .await;
    let SummaryOutcome::Ready(result) = outcome else {
        panic!("tiny-window summary should complete");
    };
    let requests = captured.lock();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests.first().and_then(|request| request.max_tokens),
        Some(500)
    );
    assert_eq!(result.text.len(), config.summary_max_bytes());
}

#[tokio::test]
async fn context_overflow_uses_fallback_summary_model() {
    let primary = Arc::new(RecordingProvider::new(vec![Reply::error(
        "prompt is too long: context_length_exceeded",
    )]));
    let primary_calls = primary.captured();
    let fallback = Arc::new(RecordingProvider::new(vec![Reply::text(
        "FALLBACK MODEL SUMMARY",
    )]));
    let fallback_calls = fallback.captured();
    let primary_ctx = context("primary", primary);
    let fallback_ctx = context("fallback", fallback);

    let result = run(
        &[user("remember the architecture")],
        SummaryContexts::separate(None, Some(&primary_ctx), Some(&fallback_ctx)),
    )
    .await;

    assert_eq!(result.text, "FALLBACK MODEL SUMMARY");
    assert_eq!(primary_calls.lock().len(), 1);
    assert_eq!(fallback_calls.lock().len(), 1);
}

#[tokio::test]
async fn repeated_context_overflow_retries_with_abbreviated_tools() {
    let provider = Arc::new(RecordingProvider::new(vec![
        Reply::error("context length exceeded"),
        Reply::text("ABBREVIATED SUMMARY"),
    ]));
    let captured = provider.captured();
    let ctx = context("primary", provider);

    let result = run(
        &tool_turn(),
        SummaryContexts::separate(None, Some(&ctx), None),
    )
    .await;
    assert!(result.text.starts_with("ABBREVIATED SUMMARY"));

    let requests = captured.lock();
    assert_eq!(requests.len(), 2);
    let prompt = |index: usize| match requests[index].messages.first() {
        Some(Message::User { content, .. }) => content
            .iter()
            .filter_map(|block| match block {
                Content::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>(),
        _ => String::new(),
    };
    let detailed = prompt(0);
    let abbreviated = prompt(1);
    assert!(detailed.contains("/large/private/file.rs"));
    assert!(detailed.contains("TOOL_PAYLOAD"));
    assert!(detailed.contains("large private reasoning"));
    assert!(!abbreviated.contains("/large/private/file.rs"));
    assert!(!abbreviated.contains("TOOL_PAYLOAD"));
    assert!(!abbreviated.contains("large private reasoning"));
    assert!(abbreviated.contains("details omitted"));
}

#[tokio::test]
async fn unavailable_primary_model_hands_summary_to_fallback_model() {
    // A previous model that is gone (revoked key, removed deployment) must not
    // block compaction: the active model takes over with the same input.
    let primary = Arc::new(RecordingProvider::new(vec![Reply::error(
        "401 Unauthorized: invalid api key",
    )]));
    let primary_calls = primary.captured();
    let fallback = Arc::new(RecordingProvider::new(vec![Reply::text(
        "ACTIVE MODEL SUMMARY",
    )]));
    let fallback_calls = fallback.captured();
    let primary_ctx = context("previous", primary);
    let fallback_ctx = context("active", fallback);

    let result = run(
        &[user("remember the architecture")],
        SummaryContexts::separate(None, Some(&primary_ctx), Some(&fallback_ctx)),
    )
    .await;

    assert_eq!(result.text, "ACTIVE MODEL SUMMARY");
    assert!(
        !result.used_fallback,
        "an LLM summary is not the emergency fallback"
    );
    assert_eq!(primary_calls.lock().len(), 1);
    assert_eq!(fallback_calls.lock().len(), 1);
}

#[tokio::test]
async fn fallback_overflow_still_retries_abbreviated_on_fallback_model() {
    let primary = Arc::new(RecordingProvider::new(vec![Reply::error(
        "503 unavailable",
    )]));
    let fallback = Arc::new(RecordingProvider::new(vec![
        Reply::error("context length exceeded"),
        Reply::text("ABBREVIATED ON ACTIVE"),
    ]));
    let fallback_calls = fallback.captured();
    let primary_ctx = context("previous", primary);
    let fallback_ctx = context("active", fallback);

    let result = run(
        &tool_turn(),
        SummaryContexts::separate(None, Some(&primary_ctx), Some(&fallback_ctx)),
    )
    .await;

    assert!(result.text.starts_with("ABBREVIATED ON ACTIVE"));
    assert_eq!(fallback_calls.lock().len(), 2);
}
