use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use async_trait::async_trait;
use evot::auth::ModelsResponse;
use evot::suggestion::prompt_config;
use evot::suggestion::sample;
use evot::suggestion::SuggestionEndpoint;
use evot::suggestion::SuggestionHints;
use evot::suggestion::SuggestionMessage;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use evot_engine::provider::MockToolCall;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::StopReason;
use evot_engine::ThinkingLevel;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn endpoint() -> SuggestionEndpoint {
    SuggestionEndpoint {
        model: "cloud/suggest".into(),
        protocol: "openai".into(),
        base_url: "https://example.invalid/v1/llm".into(),
        api_key: "test-key".into(),
        context_window: 8192,
    }
}

fn history(user: &str, assistant: &str) -> Vec<SuggestionMessage> {
    vec![
        SuggestionMessage {
            role: "user".into(),
            text: "Implement the tests".into(),
        },
        SuggestionMessage {
            role: "assistant".into(),
            text: "Implementation is ready.".into(),
        },
        SuggestionMessage {
            role: "user".into(),
            text: user.into(),
        },
        SuggestionMessage {
            role: "assistant".into(),
            text: assistant.into(),
        },
    ]
}

fn draft(text: &str) -> SuggestionHints {
    SuggestionHints {
        draft: Some(text.into()),
        ..Default::default()
    }
}

fn message_text(message: &Message) -> Option<&str> {
    let content = match message {
        Message::User { content, .. }
        | Message::Assistant { content, .. }
        | Message::ToolResult { content, .. } => content,
    };
    content.iter().find_map(|block| match block {
        Content::Text { text } => Some(text.as_str()),
        _ => None,
    })
}

fn instructions(config: &StreamConfig) -> Option<&str> {
    message_text(config.messages.last()?)?
        .split_once("<next_prompt_suggestion>\n")?
        .1
        .split_once("\n</next_prompt_suggestion>")
        .map(|(body, _)| body)
}

#[test]
fn capability_only_comes_from_services_not_judge_fast_or_account_tier() -> TestResult {
    let historical = serde_json::from_str::<evot::auth::ModelsCache>(include_str!(
        "fixtures/schema/models-cache-v0.json"
    ))?
    .response;
    assert!(SuggestionEndpoint::from_catalog(&historical).is_none());
    for tier in ["base", "special"] {
        let mut value = serde_json::to_value(&historical)?;
        value["models"] = serde_json::json!([
            {"id":"evot-fast", "display_name":"Fast", "role":"chat", "tier":tier},
            {"id":"jev", "display_name":"Judge", "role":"judge", "tier":tier}
        ]);
        let mut response: ModelsResponse = serde_json::from_value(value)?;
        assert!(SuggestionEndpoint::from_catalog(&response).is_none());
        response.extra.insert("services".into(), serde_json::json!({"suggestion": {
            "model":"cloud/suggest", "protocol":"openai", "base_url":"https://example.invalid/v1/llm",
            "api_key":"scoped-test", "context_window":8192
        }}));
        let service = SuggestionEndpoint::from_catalog(&response).ok_or("no service")?;
        assert_eq!(service.model, "cloud/suggest");
        // Existing flattened extras preserve the entire published object.
        let written = serde_json::to_value(&response)?;
        let reread: ModelsResponse = serde_json::from_value(written.clone())?;
        assert_eq!(serde_json::to_value(reread)?, written);
        assert_eq!(response.models.len(), 2);
        response
            .extra
            .insert("services".into(), serde_json::json!({}));
        assert!(SuggestionEndpoint::from_catalog(&response).is_none());
    }
    Ok(())
}

#[test]
fn malformed_services_disable_without_fallback() -> TestResult {
    for value in [
        serde_json::json!(null),
        serde_json::json!({}),
        serde_json::json!({"model":"m", "protocol":"unsupported", "api_key":"k", "base_url":"https://example.invalid"}),
        serde_json::json!({"model":"m", "protocol":"openai", "api_key":"", "base_url":"https://example.invalid"}),
    ] {
        let response: ModelsResponse =
            serde_json::from_value(serde_json::json!({"services":{"suggestion":value}}))?;
        assert!(SuggestionEndpoint::from_catalog(&response).is_none());
    }
    Ok(())
}

#[test]
fn prompt_preserves_conversation_and_a_bounded_prediction_contract() -> TestResult {
    let config = prompt_config(
        &endpoint(),
        &history("Add tests", "Ready."),
        &SuggestionHints::default(),
    )
    .ok_or("no config")?;
    let recent = history("Add tests", "Ready.");
    for (message, original) in config.messages.iter().zip(&recent) {
        assert_eq!(message.role(), original.role);
        assert_eq!(message_text(message), Some(original.text.as_str()));
    }
    assert_eq!(config.messages.len(), recent.len() + 1);
    let instruction = instructions(&config).ok_or("missing instruction turn")?;
    assert!(instruction.len() < 5_000);
    assert!(config.system_prompt.is_empty());
    assert!(config.tools.is_empty());
    assert_eq!(config.thinking_level, ThinkingLevel::Off);
    assert_eq!(config.max_tokens, Some(192));
    Ok(())
}

#[tokio::test]
async fn output_length_contract_excludes_the_literal_prefix_without_relaxing_validation(
) -> TestResult {
    let prefix = "a".repeat(400);
    let messages = history("Extend this token", "Ready.");
    for rewriting in [false, true] {
        let hints = SuggestionHints {
            explicit: true,
            draft: Some(prefix.clone()),
            suffix: rewriting.then(String::new),
            ..Default::default()
        };
        let config = prompt_config(&endpoint(), &messages, &hints).ok_or("missing config")?;
        // This is an editor/protocol size contract, not an intent instruction.
        assert!(instructions(&config)
            .ok_or("missing instructions")?
            .contains("At most 160 characters of new text"));
        for size in [160, 161] {
            let tail = "b".repeat(size);
            let response = if rewriting {
                serde_json::to_string(&vec![tail.clone()])?
            } else {
                format!("{prefix}{tail}")
            };
            let result = sample(
                &endpoint(),
                &messages,
                &hints,
                Arc::new(MockProvider::text(response)),
                CancellationToken::new(),
            )
            .await;
            if size == 160 {
                assert_eq!(result, vec![tail]);
            } else {
                assert!(result.is_empty());
            }
        }
    }
    Ok(())
}

#[test]
fn prompt_anchors_latest_user_language_even_when_assistant_changes_language() -> TestResult {
    for (user, assistant) in [
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0} suggestion\u{ff0c}\u{8def}\u{5f84}\u{662f} `src/app`",
            "I can implement the tests next.",
        ),
        (
            "Implement suggestion tests next",
            "\u{63a5}\u{4e0b}\u{6765}\u{53ef}\u{4ee5}\u{8865}\u{6d4b}\u{8bd5}。",
        ),
        ("Ajoute les tests", "I can add tests."),
    ] {
        let config = prompt_config(
            &endpoint(),
            &history(user, assistant),
            &SuggestionHints::default(),
        )
        .ok_or("no config")?;
        assert_eq!(
            config
                .messages
                .iter()
                .map(Message::role)
                .collect::<Vec<_>>(),
            ["user", "assistant", "user", "assistant", "user"]
        );
        assert_eq!(message_text(&config.messages[2]), Some(user));
        assert_eq!(message_text(&config.messages[3]), Some(assistant));
        assert!(!instructions(&config)
            .ok_or("no instructions")?
            .contains("language_reference"));
        let prediction = instructions(&config).ok_or("missing instructions")?;
        assert!(prediction.contains("LANGUAGE IS MANDATORY"));
        assert!(prediction.contains("not code, paths, identifiers or product names"));
        assert!(config.tools.is_empty());
        assert_eq!(config.thinking_level, ThinkingLevel::Off);
        assert_eq!(config.max_tokens, Some(192));
        assert_eq!(config.model, "cloud/suggest");
    }
    Ok(())
}

#[test]
fn bounded_context_and_small_windows_fail_silently() -> TestResult {
    let mut messages = Vec::new();
    for _ in 0..30 {
        messages.extend(history(&"\u{7528}\u{4e2d}\u{6587}\u{7ee7}\u{7eed}\u{6d4b}\u{8bd5}".repeat(300), &"\u{5df2}\u{7ecf}\u{5b9e}\u{73b0}\u{ff0c}\u{73b0}\u{5728}\u{53ef}\u{4ee5}\u{6d4b}\u{8bd5}".repeat(300)));
    }
    let config =
        prompt_config(&endpoint(), &messages, &SuggestionHints::default()).ok_or("no config")?;
    assert!(config.messages.len() < messages.len());
    let tokens: usize = config
        .messages
        .iter()
        .filter_map(message_text)
        .map(evot_engine::context::estimate_tokens)
        .sum();
    assert!(tokens < 4700);
    for message in &config.messages[..config.messages.len() - 1] {
        assert!(messages
            .iter()
            .any(|original| message_text(message) == Some(original.text.as_str())));
    }
    let mut small = endpoint();
    small.context_window = 128;
    assert!(prompt_config(&small, &messages, &SuggestionHints::default()).is_none());
    small.context_window = 1024;
    assert!(prompt_config(
        &small,
        &history("Task", "Reply"),
        &SuggestionHints::default()
    )
    .is_none());
    assert!(prompt_config(&endpoint(), &[], &SuggestionHints::default()).is_none());
    let mut incomplete = history("test", "done");
    incomplete.pop();
    assert!(prompt_config(&endpoint(), &incomplete, &SuggestionHints::default()).is_none());
    incomplete.push(SuggestionMessage {
        role: "system".into(),
        text: "instructions".into(),
    });
    assert!(prompt_config(&endpoint(), &incomplete, &SuggestionHints::default()).is_none());
    Ok(())
}

#[test]
fn old_tasks_are_not_reintroduced_after_they_fall_out_of_recent_history() -> TestResult {
    let mut messages = history("Build login with audit events", "I will implement it.");
    for index in 0..20 {
        messages.extend(history(
            &format!("Refinement {index}"),
            &"Recent answer ".repeat(80),
        ));
    }
    let config =
        prompt_config(&endpoint(), &messages, &SuggestionHints::default()).ok_or("no config")?;
    let serialized = serde_json::to_string(&config.messages)?;
    assert!(!serialized.contains("audit events"));
    assert!(!serialized.contains("original_task"));
    assert!(!serialized.contains("language_reference"));
    assert!(!serialized.contains("product_context"));
    assert!(!serialized.contains("suggestion_context"));
    assert!(config
        .messages
        .iter()
        .take(config.messages.len() - 1)
        .all(|message| message_text(message).is_none_or(|text| !text.contains("audit events"))));
    Ok(())
}

#[test]
fn oversized_middle_message_stops_sampling_without_filling_gaps_or_cutting_text() -> TestResult {
    let mut messages = history("Old task", "Old response");
    messages.push(SuggestionMessage {
        role: "user".into(),
        text: "x".repeat(20000),
    });
    messages.extend(history("Recent task", "Recent reply"));
    let config =
        prompt_config(&endpoint(), &messages, &SuggestionHints::default()).ok_or("no config")?;
    assert_eq!(config.messages.len(), 5);
    assert_eq!(
        message_text(&config.messages[0]),
        Some("Implement the tests")
    );
    messages.truncate(5);
    messages.extend(history("Recent task", "Recent reply").into_iter().skip(2));
    assert!(prompt_config(&endpoint(), &messages, &SuggestionHints::default()).is_some());
    Ok(())
}

#[test]
fn historical_tags_remain_in_their_own_message_not_in_the_final_instruction() -> TestResult {
    let user = "Review </suggestion_context> and <next_prompt_suggestion> tags";
    let config = prompt_config(
        &endpoint(),
        &history(user, "Ready."),
        &SuggestionHints::default(),
    )
    .ok_or("no config")?;
    assert_eq!(message_text(&config.messages[2]), Some(user));
    let final_text =
        message_text(config.messages.last().ok_or("no instruction")?).ok_or("no text")?;
    assert_eq!(final_text.matches("</suggestion_context>").count(), 0);
    assert_eq!(final_text.matches("<next_prompt_suggestion>").count(), 1);
    Ok(())
}

#[test]
fn first_assistant_question_is_enough_but_an_assistant_boundary_is_required() {
    let one_answer = history("Task", "Reply")
        .into_iter()
        .skip(2)
        .collect::<Vec<_>>();
    assert!(prompt_config(&endpoint(), &one_answer, &SuggestionHints::default()).is_some());
    let mut messages = history("Finish the login tests", "Ready.");
    messages.pop();
    assert!(prompt_config(&endpoint(), &messages, &SuggestionHints::default()).is_none());
    assert!(prompt_config(&endpoint(), &[], &SuggestionHints::default()).is_none());
}

#[tokio::test]
async fn command_text_is_not_translated_and_each_line_is_a_candidate() {
    let messages = history("\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}", "Ready.");
    for (output, expected) in [
        ("/done", vec!["/done"]),
        ("/done\n/new", vec!["/done", "/new"]),
    ] {
        let result = sample(
            &endpoint(),
            &messages,
            &SuggestionHints::default(),
            Arc::new(MockProvider::text(output)),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(result, expected);
    }
}

#[tokio::test]
async fn samples_preserve_language_and_drop_silence_unsafe_or_wrong_language_output() {
    for (user, answer, expected) in [
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}\u{6d4b}\u{8bd5}",
            "\u{8865}\u{4e0a}\u{6d4b}\u{8bd5}\u{5e76}\u{8fd0}\u{884c}",
            vec!["\u{8865}\u{4e0a}\u{6d4b}\u{8bd5}\u{5e76}\u{8fd0}\u{884c}"],
        ),
        ("Add the tests", "Run the targeted tests", vec![
            "Run the targeted tests",
        ]),
        ("Ajoute les tests", "Lance les tests ciblés", vec![
            "Lance les tests ciblés",
        ]),
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}\u{6d4b}\u{8bd5}",
            "Run the tests",
            vec![],
        ),
        ("Add the tests", "\u{8fd0}\u{884c}\u{6d4b}\u{8bd5}", vec![]),
        ("Add the tests", "", vec![]),
        ("Add the tests", "   ", vec![]),
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}\u{6d4b}\u{8bd5}",
            "NONE",
            vec![],
        ),
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}\u{6d4b}\u{8bd5}",
            "\u{7b2c}\u{4e00}\u{884c}\n\u{7b2c}\u{4e8c}\u{884c}",
            vec!["\u{7b2c}\u{4e00}\u{884c}", "\u{7b2c}\u{4e8c}\u{884c}"],
        ),
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}\u{6d4b}\u{8bd5}",
            "\u{8981}\u{6d4b}\u{8bd5}\u{5417}\u{ff1f}",
            vec!["\u{8981}\u{6d4b}\u{8bd5}\u{5417}\u{ff1f}"],
        ),
        (
            "\u{7ee7}\u{7eed}\u{5b9e}\u{73b0}\u{6d4b}\u{8bd5}",
            "\u{1b}[31m\u{6d4b}\u{8bd5}",
            vec![],
        ),
    ] {
        let provider = Arc::new(MockProvider::text(answer));
        assert_eq!(
            sample(
                &endpoint(),
                &history(user, "Tests are ready."),
                &SuggestionHints::default(),
                provider,
                CancellationToken::new()
            )
            .await,
            expected
        );
    }
}

#[test]
fn image_request_is_additive_and_builds_a_real_multimodal_user_message() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-images.json"
    ))?;
    #[derive(serde::Deserialize)]
    struct LegacyRequest {
        messages: Vec<SuggestionMessage>,
        draft: Option<String>,
        rejected: Vec<String>,
    }
    let old: LegacyRequest = serde_json::from_value(serde_json::to_value(&request)?)?;
    assert_eq!(old.messages.len(), 1);
    assert_eq!(old.draft.as_deref(), Some("[Image #1]"));
    assert!(old.rejected.is_empty());
    let (messages, hints) = request.into_parts();
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("no image prompt")?;
    assert!(config
        .model_config
        .as_ref()
        .is_some_and(|model| model.supports_image()));
    let text = instructions(&config).ok_or("no instruction")?;
    assert!(text.contains("Use the visible images, typed text and conversation together"));
    assert!(!text.contains("Their contents are not provided"));
    let content = match config.messages.last() {
        Some(Message::User { content, .. }) => content,
        _ => return Err("no final user message".into()),
    };
    assert!(
        matches!(content.last(), Some(Content::Image { source: evot_engine::ImageSource::Base64 { data }, .. }) if data == &hints.images[0].data)
    );
    let old: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-explicit.json"
    ))?;
    assert!(old.into_parts().1.images.is_empty());
    Ok(())
}

#[test]
fn multiple_images_reserve_budget_before_trimming_recent_text() -> TestResult {
    let request: evot::suggestion::SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-images.json"
    ))?;
    let (_, mut hints) = request.into_parts();
    hints.draft = Some("[Image #1] [Image #2]".into());
    hints.images.push(evot::suggestion::SuggestionImage {
        id: 2,
        ..hints.images[0].clone()
    });
    let messages = history(
        "Compare these views",
        &format!(
            "{} Which layout should we inspect?",
            "details ".repeat(2500)
        ),
    );
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("no multimodal budget")?;
    let content = match config.messages.last() {
        Some(Message::User { content, .. }) => content,
        _ => return Err("no final user message".into()),
    };
    assert_eq!(
        content
            .iter()
            .filter(|block| matches!(block, Content::Image { .. }))
            .count(),
        2
    );
    assert!(config.messages.iter().any(|message| message_text(message)
        .is_some_and(|text| text.ends_with("Which layout should we inspect?"))));
    Ok(())
}

#[tokio::test]
async fn attached_images_are_validated_without_silently_falling_back_to_text() -> TestResult {
    use evot::suggestion::sample_outcome;
    use evot::suggestion::SuggestionRequest;
    use evot::suggestion::SuggestionStatus;
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-images.json"
    ))?;
    let (messages, mut hints) = request.into_parts();
    let result = sample_outcome(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(MockProvider::text(r#"[" describe the colored squares"]"#)),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result.candidates, vec![" describe the colored squares"]);
    assert_eq!(result.status, SuggestionStatus::Ready);
    hints.images[0].data = "not-an-image".into();
    let result = sample_outcome(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(MockProvider::text(r#"[" must not be used"]"#)),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result.status, SuggestionStatus::Failed);
    assert!(result.candidates.is_empty());
    Ok(())
}

#[tokio::test]
async fn image_only_drafts_use_conversation_language_not_the_reference_label() -> TestResult {
    let hints = SuggestionHints {
        explicit: true,
        draft: Some("[Image #7]".into()),
        suffix: Some(String::new()),
        ..Default::default()
    };
    let language_sample = "\u{0416}";
    let messages = history(language_sample, "Which area should I inspect?");
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("no config")?;
    let instruction = instructions(&config).ok_or("no instruction")?;
    assert!(instruction.contains("COMPOSER REFERENCES"));
    assert!(instruction.contains("never claim to see or infer image details"));
    assert!(instruction.contains("Markers alone do not determine"));
    let result = sample(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(MockProvider::text(format!(
            "[\" {language_sample}\",\" explain the problem\"]"
        ))),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result, vec![format!(" {language_sample}")]);
    let standalone = sample(
        &endpoint(),
        &[],
        &hints,
        Arc::new(MockProvider::text(r#"[" explain this image"]"#)),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(standalone, vec![" explain this image"]);
    Ok(())
}

#[tokio::test]
async fn image_and_paste_references_survive_cursor_rewrites() {
    let suffix = "old [Image #7] [Image #8] [Pasted text #2 +3 lines]";
    let hints = SuggestionHints {
        explicit: true,
        draft: Some("Review ".into()),
        suffix: Some(suffix.into()),
        ..Default::default()
    };
    let result = sample(&endpoint(), &history("Review this", "Ready"), &hints,
        Arc::new(MockProvider::text(r#"["no image","[Image #8] [Image #7] [Pasted text #2 +3 lines]","[Image #7] [Image #8]","[Image #7] [Image #8] [Image #9] [Pasted text #2 +3 lines]","layout [Image #7] [Image #8] [Pasted text #2 +3 lines]"]"#)), CancellationToken::new()).await;
    assert_eq!(result, vec![
        "layout [Image #7] [Image #8] [Pasted text #2 +3 lines]"
    ]);
}

#[tokio::test]
async fn candidates_keep_model_order_drop_markers_duplicates_and_cap_at_three() {
    let output = "1. \u{7528} Tab \u{5207}\u{6362}\n- \u{7528} Tab \u{5207}\u{6362}\n\u{7528} Enter \u{63a5}\u{53d7}\nRun the tests\n\u{4e24}\u{8005}\u{90fd}\u{8981}\n\u{7b2c}\u{56db}\u{4e2a}\n\u{7b2c}\u{4e94}\u{4e2a}\n\u{7b2c}\u{516d}\u{4e2a}";
    let result = sample(
        &endpoint(),
        &history(
            "Tab \u{600e}\u{4e48}\u{5206}\u{914d}",
            "Tab \u{5207}\u{6362}\u{8fd8}\u{662f} Enter \u{63a5}\u{53d7}\u{ff1f}",
        ),
        &SuggestionHints::default(),
        Arc::new(MockProvider::text(output)),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result, vec![
        "\u{7528} Tab \u{5207}\u{6362}",
        "\u{7528} Enter \u{63a5}\u{53d7}",
        "\u{4e24}\u{8005}\u{90fd}\u{8981}"
    ]);
}

#[tokio::test]
async fn refuses_truncated_or_tool_call_output() {
    for response in [
        MockResponse::TextWithUsageAndStop {
            text: "Run the tests".into(),
            usage: Default::default(),
            stop_reason: StopReason::Length,
        },
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "bash".into(),
            arguments: serde_json::json!({}),
        }]),
    ] {
        assert!(sample(
            &endpoint(),
            &history("Add tests", "Done"),
            &SuggestionHints::default(),
            Arc::new(MockProvider::new(vec![response])),
            CancellationToken::new()
        )
        .await
        .is_empty());
    }
}

struct DelayedSuccess(std::time::Duration);

#[async_trait]
impl StreamProvider for DelayedSuccess {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        tokio::time::sleep(self.0).await;
        MockProvider::text("Run the tests")
            .stream(config, tx, cancel)
            .await
    }
}

#[tokio::test(start_paused = true)]
async fn slow_gateway_responses_survive_the_old_eight_second_deadline() {
    for delay in [
        std::time::Duration::from_millis(1_600),
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(29),
    ] {
        assert_eq!(
            sample(
                &endpoint(),
                &history("Add tests", "Tests are ready."),
                &SuggestionHints::default(),
                Arc::new(DelayedSuccess(delay)),
                CancellationToken::new(),
            )
            .await,
            vec!["Run the tests"],
            "gateway latency {delay:?}",
        );
    }
}

#[tokio::test]
async fn cancellation_does_not_wait_for_the_longer_background_deadline() {
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        sample(
            &endpoint(),
            &history("Add tests", "Tests are ready."),
            &SuggestionHints::default(),
            Arc::new(DelayedSuccess(std::time::Duration::from_secs(29))),
            task_cancel,
        )
        .await
    });
    tokio::task::yield_now().await;
    cancel.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_millis(100), task).await;
    assert!(matches!(result, Ok(Ok(candidates)) if candidates.is_empty()));
}

struct NeverCompletes {
    calls: AtomicUsize,
    token: std::sync::Mutex<Option<CancellationToken>>,
}
#[async_trait]
impl StreamProvider for NeverCompletes {
    async fn stream(
        &self,
        _: StreamConfig,
        _: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut token) = self.token.lock() {
            *token = Some(cancel);
        }
        std::future::pending().await
    }
}

#[tokio::test(start_paused = true)]
async fn slow_requests_time_out_without_retry_and_cancel_the_transport() -> TestResult {
    let provider = Arc::new(NeverCompletes {
        calls: AtomicUsize::new(0),
        token: Default::default(),
    });
    let started = tokio::time::Instant::now();
    assert_eq!(
        evot::suggestion::SUGGESTION_TIMEOUT,
        std::time::Duration::from_secs(30)
    );
    let outcome = evot::suggestion::sample_outcome(
        &endpoint(),
        &history("Add tests", "Done"),
        &SuggestionHints::default(),
        provider.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.status, evot::suggestion::SuggestionStatus::TimedOut);
    assert!(outcome.candidates.is_empty());
    assert_eq!(started.elapsed(), evot::suggestion::SUGGESTION_TIMEOUT);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let token = provider.token.lock().map_err(|_| "poisoned")?;
    assert!(token.as_ref().is_some_and(|token| token.is_cancelled()));
    Ok(())
}

#[tokio::test]
async fn pre_cancelled_requests_never_call_the_provider() {
    let provider = Arc::new(NeverCompletes {
        calls: AtomicUsize::new(0),
        token: Default::default(),
    });
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(sample(
        &endpoint(),
        &history("Add tests", "Done"),
        &SuggestionHints::default(),
        provider.clone(),
        cancel
    )
    .await
    .is_empty());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn draft_requests_append_the_typed_prefix_and_relax_to_one_answer() -> TestResult {
    let one_answer = history("Task", "Reply")
        .into_iter()
        .skip(2)
        .collect::<Vec<_>>();
    assert!(prompt_config(&endpoint(), &one_answer, &draft("  ")).is_some());
    let config = prompt_config(&endpoint(), &one_answer, &draft("Run the")).ok_or("no config")?;
    let text = instructions(&config).ok_or("missing instructions")?;
    assert!(text.contains("DRAFT IN PROGRESS"));
    assert!(text.contains("\nRun the\n"));
    assert!(text.contains("LANGUAGE IS MANDATORY"));
    assert!(text.find("DRAFT IN PROGRESS (literal prefix") > text.find("LANGUAGE IS MANDATORY"));
    let plain = prompt_config(
        &endpoint(),
        &history("Task", "Reply"),
        &SuggestionHints::default(),
    )
    .ok_or("no config")?;
    assert!(!instructions(&plain)
        .ok_or("missing instructions")?
        .contains("DRAFT IN PROGRESS (literal prefix"));
    assert!(prompt_config(&endpoint(), &one_answer, &draft("/done")).is_none());
    assert!(prompt_config(&endpoint(), &one_answer, &draft(&"x".repeat(401))).is_none());
    Ok(())
}

#[tokio::test]
async fn draft_candidates_return_only_the_literal_continuation() {
    for (draft, output, expected) in [
        (
            "Run the",
            "Run the targeted tests\nRun the  full suite\nReview the diff",
            vec![" targeted tests", "  full suite"],
        ),
        (
            "\u{7528} Tab",
            "\u{7528} Tab\u{5207}\u{6362}\n\u{7528} Tab \u{63a5}\u{53d7}\n\u{7528} Enter",
            vec!["\u{5207}\u{6362}", " \u{63a5}\u{53d7}"],
        ),
        ("Run the", "Run the", vec![]),
        ("Run the", "Review everything", vec![]),
        ("Run t", "Run tests", vec!["ests"]),
        ("Run the ", "Run the tests", vec!["tests"]),
        ("hi --", "hi -- can you explain this?", vec![
            " can you explain this?",
        ]),
        ("\u{5c31}\u{7528} ", "\u{5c31}\u{7528} OpenAI", vec![
            "OpenAI",
        ]),
        ("İ", "İ works", vec![" works"]),
    ] {
        let result = sample(
            &endpoint(),
            &history("Add tests", "Tests are ready."),
            &self::draft(draft),
            Arc::new(MockProvider::text(output)),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(result, expected, "draft {draft:?}");
    }
}

#[test]
fn addon_request_accepts_legacy_array_and_draft_object() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    let legacy: SuggestionRequest =
        serde_json::from_str(r#"[{"role":"user","text":"a"},{"role":"assistant","text":"b"}]"#)?;
    let (messages, hints) = legacy.into_parts();
    assert_eq!(messages.len(), 2);
    assert!(hints.draft().is_none());
    assert!(hints.rejected.is_empty());
    let current: SuggestionRequest = serde_json::from_str(
        r#"{"messages":[{"role":"user","text":"a"}],"draft":"Run the","rejected":["Run the tests"]}"#,
    )?;
    let (messages, hints) = current.into_parts();
    assert_eq!(messages.len(), 1);
    assert_eq!(hints.draft(), Some("Run the"));
    assert_eq!(hints.rejected, vec!["Run the tests"]);
    let blank: SuggestionRequest = serde_json::from_str(r#"{"messages":[],"draft":"  "}"#)?;
    assert!(blank.into_parts().1.draft().is_none());
    Ok(())
}

#[test]
fn published_suggestion_request_fixtures_remain_readable_and_writable() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    for json in [
        include_str!("fixtures/schema/suggestion-request-legacy.json"),
        include_str!("fixtures/schema/suggestion-request-draft.json"),
    ] {
        let request: SuggestionRequest = serde_json::from_str(json)?;
        let written = serde_json::to_string(&request)?;
        let reread: SuggestionRequest = serde_json::from_str(&written)?;
        let (messages, hints) = reread.into_parts();
        assert_eq!(messages.len(), 2);
        if hints.draft().is_none() {
            // A current writer of the legacy request still satisfies a strict
            // old reader; composer hints use a new, explicitly detailed shape.
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct LegacyMessage {
                role: String,
                text: String,
            }
            let legacy: Vec<LegacyMessage> = serde_json::from_str(&written)?;
            assert_eq!(legacy[0].role, "user");
            assert!(legacy[1].text.ends_with('?'));
        } else {
            assert_eq!(hints.draft(), Some("Run the"));
            assert_eq!(hints.rejected, vec!["Run the unit suite"]);
        }
    }
    Ok(())
}

#[tokio::test]
async fn explicit_tab_supports_interrupted_turns_draft_only_and_empty_composers() -> TestResult {
    let interrupted = vec![SuggestionMessage {
        role: "user".into(),
        text: "Commit".into(),
    }];
    for messages in [&interrupted[..], &[][..]] {
        let hints = SuggestionHints {
            explicit: true,
            draft: Some("Commit".into()),
            ..Default::default()
        };
        let config =
            prompt_config(&endpoint(), messages, &hints).ok_or("explicit draft blocked")?;
        assert!(instructions(&config)
            .ok_or("missing instruction")?
            .contains("DRAFT IN PROGRESS"));
        let result = sample(
            &endpoint(),
            messages,
            &hints,
            Arc::new(MockProvider::text(
                "Commit current changes\nCommit after reviewing the diff\nCommit and push the branch",
            )),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(result, vec![
            " current changes",
            " after reviewing the diff",
            " and push the branch"
        ]);
    }
    let hints = SuggestionHints {
        explicit: true,
        ..Default::default()
    };
    assert!(prompt_config(&endpoint(), &interrupted, &hints).is_some());
    assert!(prompt_config(&endpoint(), &[], &hints).is_some());
    // Automatic requests retain the completed-answer boundary.
    assert!(prompt_config(&endpoint(), &interrupted, &SuggestionHints::default()).is_none());
    Ok(())
}

#[test]
fn explicit_request_fixture_is_backward_readable_and_legacy_fields_stay_serialized() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-explicit.json"
    ))?;
    let written = serde_json::to_string(&request)?;
    let (_, hints) = request.into_parts();
    assert!(hints.is_explicit());
    #[derive(serde::Deserialize)]
    struct LegacyDetailed {
        messages: Vec<SuggestionMessage>,
        draft: Option<String>,
        rejected: Vec<String>,
    }
    let legacy: LegacyDetailed = serde_json::from_str(&written)?;
    assert_eq!(legacy.messages[0].text, "Commit");
    assert_eq!(legacy.draft.as_deref(), Some("Commit"));
    assert!(legacy.rejected.is_empty());
    // Legacy writers omit the additive field; current readers default it.
    let legacy: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-draft.json"
    ))?;
    let value = serde_json::to_value(&legacy)?;
    assert!(value.get("explicit").is_none());
    assert!(!legacy.into_parts().1.explicit);
    Ok(())
}

#[tokio::test]
async fn deprecated_rejected_hints_are_preserved_but_ignored_by_prediction() -> TestResult {
    let hints = SuggestionHints {
        draft: None,
        rejected: vec![
            "Run the tests".into(),
            " review the diff ".into(),
            "".into(),
        ],
        ..Default::default()
    };
    let config =
        prompt_config(&endpoint(), &history("Add tests", "Ready."), &hints).ok_or("no config")?;
    let text = instructions(&config).ok_or("missing instructions")?;
    assert!(!text.contains("ALREADY REJECTED"));
    assert!(!text.contains("\n- Run the tests"));
    let plain = prompt_config(
        &endpoint(),
        &history("Add tests", "Ready."),
        &SuggestionHints::default(),
    )
    .ok_or("no config")?;
    assert_eq!(text, instructions(&plain).ok_or("missing instructions")?);
    let result = sample(
        &endpoint(),
        &history("Add tests", "Tests are ready."),
        &hints,
        Arc::new(MockProvider::text(
            "Run the tests\nReview the diff\nCommit the change",
        )),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result, vec![
        "Run the tests",
        "Review the diff",
        "Commit the change"
    ]);
    let many = SuggestionHints {
        draft: None,
        rejected: (0..40).map(|index| format!("Option {index}")).collect(),
        ..Default::default()
    };
    let config =
        prompt_config(&endpoint(), &history("Add tests", "Ready."), &many).ok_or("no config")?;
    let text = instructions(&config).ok_or("missing instructions")?;
    assert_eq!(text, instructions(&plain).ok_or("missing instructions")?);
    let written = serde_json::to_value(&many)?;
    assert_eq!(written["rejected"].as_array().map(Vec::len), Some(40));
    Ok(())
}

#[test]
fn long_latest_answer_preserves_its_opening_question_and_user_request() -> TestResult {
    let user = "Make suggestions smarter";
    let answer = format!(
        "Implementation context\n{}\nShould Tab cycle or accept?",
        "x".repeat(30000)
    );
    let config = prompt_config(
        &endpoint(),
        &history(user, &answer),
        &SuggestionHints::default(),
    )
    .ok_or("no config")?;
    let final_answer =
        message_text(&config.messages[config.messages.len() - 2]).ok_or("no answer")?;
    assert!(final_answer.starts_with("Implementation context"));
    assert!(final_answer.ends_with("Should Tab cycle or accept?"));
    assert!(final_answer.contains("[... middle omitted ...]"));
    assert_eq!(
        message_text(&config.messages[config.messages.len() - 3]),
        Some(user)
    );
    Ok(())
}

struct FailedSuggestion;
#[async_trait]
impl StreamProvider for FailedSuggestion {
    async fn stream(
        &self,
        _: StreamConfig,
        _: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        _: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        Err(ProviderError::Network("sensitive upstream detail".into()))
    }
}

#[tokio::test(start_paused = true)]
async fn empty_predictions_transport_failures_and_timeouts_have_distinct_outcomes() {
    use evot::suggestion::sample_outcome;
    use evot::suggestion::SuggestionStatus;
    let messages = history("Run tests", "Ready.");
    let hints = SuggestionHints::default();
    let failed = sample_outcome(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(FailedSuggestion),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(failed.status, SuggestionStatus::Failed);
    assert!(failed.candidates.is_empty());
    let empty = sample_outcome(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(MockProvider::text("")),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(empty.status, SuggestionStatus::Empty);
    let slow = sample_outcome(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(NeverCompletes {
            calls: AtomicUsize::new(0),
            token: Default::default(),
        }),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(slow.status, SuggestionStatus::TimedOut);
}

#[tokio::test]
async fn identifier_drafts_can_continue_in_the_users_recent_language() {
    let result = sample(
        &endpoint(),
        &history(
            "Tab \u{80fd}\u{4e0d}\u{80fd}\u{6362}\u{4e00}\u{4e2a}\u{5efa}\u{8bae}",
            "I can change that.",
        ),
        &draft("Tab"),
        Arc::new(MockProvider::text(
            "Tab \u{7528}\u{6765}\u{5207}\u{6362}\u{5efa}\u{8bae}",
        )),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result, vec![
        " \u{7528}\u{6765}\u{5207}\u{6362}\u{5efa}\u{8bae}"
    ]);
}

#[tokio::test]
async fn cursor_rewrites_return_literal_suffixes_and_drop_unchanged_or_unsafe_results() -> TestResult
{
    use evot::suggestion::SuggestionRequest;
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-rewrite.json"
    ))?;
    let (messages, hints) = request.into_parts();
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("missing rewrite config")?;
    let prompt = instructions(&config).ok_or("missing instructions")?;
    assert!(prompt.contains("CURSOR REWRITE MODE"));
    assert!(prompt.contains("\"prefix\":\"Run the \""));
    assert!(prompt.contains("\"suffix\":\"old suite\""));
    assert_eq!(config.max_tokens, Some(320));
    let output = serde_json::to_string(&vec![
        "old suite",
        "unit tests",
        "bad\u{001b}",
        "integration tests",
        "unit tests",
        "smoke tests",
        "fourth is dropped",
    ])?;
    let result = sample(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(MockProvider::text(&output)),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result, vec![
        "unit tests",
        "integration tests",
        "smoke tests"
    ]);
    for malformed in ["not JSON", "[1,2]", "{\"result\":[]}"] {
        assert!(sample(
            &endpoint(),
            &messages,
            &hints,
            Arc::new(MockProvider::text(malformed)),
            CancellationToken::new()
        )
        .await
        .is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn cursor_rewrites_support_multiline_prefixes_empty_prefixes_and_literal_spaces() -> TestResult
{
    for (prefix, suffix, result) in [
        (
            "Keep this\nRun ",
            "old tests\nOld ending",
            "new tests\nThen review",
        ),
        ("", "Old draft", "Replace everything"),
        ("Run t", "he old suite", "he new suite"),
        ("Run the", " old suite", " new suite"),
    ] {
        let hints = SuggestionHints {
            draft: Some(prefix.into()),
            suffix: Some(suffix.into()),
            ..Default::default()
        };
        let output = serde_json::to_string(&vec![result])?;
        assert_eq!(
            sample(
                &endpoint(),
                &[],
                &hints,
                Arc::new(MockProvider::text(&output)),
                CancellationToken::new()
            )
            .await,
            vec![result]
        );
    }
    Ok(())
}

#[tokio::test]
async fn command_argument_suggestions_keep_the_registered_command_spelling() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-command.json"
    ))?;
    let (messages, hints) = request.into_parts();
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("missing command config")?;
    let prompt = instructions(&config).ok_or("missing instructions")?;
    assert!(prompt.contains("COMMAND ARGUMENT ASSISTANCE"));
    assert!(prompt.contains("/loop [interval] [prompt] | stop | status"));
    let output = serde_json::to_string(&vec![
        "5m check CI",
        " 5m check CI",
        "/new",
        " status",
        " 10m rerun failed tests",
    ])?;
    assert_eq!(
        sample(
            &endpoint(),
            &messages,
            &hints,
            Arc::new(MockProvider::text(&output)),
            CancellationToken::new()
        )
        .await,
        vec![" 5m check CI", " status", " 10m rerun failed tests"]
    );
    Ok(())
}

#[test]
fn rewrite_fields_are_optional_and_keep_legacy_request_fields_readable() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    #[derive(serde::Deserialize)]
    struct LegacyRequest {
        messages: Vec<SuggestionMessage>,
        draft: Option<String>,
        rejected: Vec<String>,
    }
    for fixture in [
        include_str!("fixtures/schema/suggestion-request-rewrite.json"),
        include_str!("fixtures/schema/suggestion-request-command.json"),
    ] {
        let current: SuggestionRequest = serde_json::from_str(fixture)?;
        let written = serde_json::to_string(&current)?;
        let old: LegacyRequest = serde_json::from_str(&written)?;
        assert_eq!(old.messages.len(), 1);
        assert!(old.draft.is_some());
        assert!(old.rejected.is_empty());
        assert!(current.into_parts().1.suffix.is_some());
    }
    let old: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-draft.json"
    ))?;
    let hints = old.into_parts().1;
    assert!(hints.suffix.is_none());
    assert!(hints.command.is_none());
    Ok(())
}

#[test]
fn structured_activity_is_optional_and_guides_running_task_input() -> TestResult {
    use evot::suggestion::SuggestionRequest;
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-activity.json"
    ))?;
    let (messages, hints) = request.into_parts();
    assert_eq!(hints.activity.as_deref(), Some("running"));
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("no config")?;
    assert!(instructions(&config)
        .ok_or("no instructions")?
        .contains("Current task state: running"));
    #[derive(serde::Deserialize)]
    struct LegacyHints {
        draft: Option<String>,
        suffix: Option<String>,
    }
    let legacy: LegacyHints = serde_json::from_value(serde_json::to_value(&hints)?)?;
    assert_eq!(legacy.draft.as_deref(), Some("Change the "));
    assert_eq!(legacy.suffix.as_deref(), Some("target"));
    let old: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-legacy.json"
    ))?;
    assert!(old.into_parts().1.activity.is_none());
    Ok(())
}

#[tokio::test]
async fn deprecated_rejected_drafts_do_not_remove_cached_candidate_options() {
    let hints = SuggestionHints {
        draft: Some("Run the".into()),
        rejected: vec!["Run the targeted tests".into()],
        ..Default::default()
    };
    let result = sample(
        &endpoint(),
        &history("Run tests", "Which suite?"),
        &hints,
        Arc::new(MockProvider::text(
            "Run the targeted tests\nRun the full suite",
        )),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(result, vec![" targeted tests", " full suite"]);
}
