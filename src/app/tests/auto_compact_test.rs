use std::sync::Arc;

use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::RunEventPayload;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::observability::UsageSummary;
use evot::storage::MemoryStorage;
use evot::types::AssistantBlock;
use evot::types::TranscriptItem;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use evot_engine::Usage;
use tempfile::TempDir;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn auto_compaction_persists_structured_compact_item() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["gpt-4o".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();

    let provider = MockProvider::new(vec![
        // Pre-prompt compaction now runs before the new request is sent, so
        // the first provider call is the summarization call.
        MockResponse::Text("AUTO SUMMARY FROM LLM".into()),
        MockResponse::TextWithUsageStopAndModel {
            text: "assistant response after pre-prompt compaction".into(),
            usage: Usage {
                input: 10_000,
                output: 10,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 10_010,
                reasoning_output: 0,
            },
            stop_reason: evot_engine::StopReason::Stop,
            model: "gpt-4o".into(),
        },
    ]);

    let storage = Arc::new(MemoryStorage::new());
    let agent = Agent::new_with_provider_for_test(&config, "/work", storage, provider)?;
    agent.with_limits(evot::agent::ExecutionLimits {
        max_turns: 3,
        max_total_tokens: 1_000_000,
        max_duration_secs: 60,
    });
    let session = agent.create_session("test").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;

    loaded
        .write_items(vec![
            user(&"old message one ".repeat(30_000)),
            assistant("old assistant one"),
            user(&"old message two ".repeat(30_000)),
            assistant("old assistant two"),
            user(&"old message three ".repeat(30_000)),
            assistant("old assistant three"),
            user("old message four"),
            assistant("old assistant four"),
            user("old message five"),
            assistant("old assistant five"),
            user("old message six"),
            assistant("old assistant six"),
            user("old message seven"),
            assistant_with_usage("old assistant seven", 130_000),
        ])
        .await?;

    let outcome = agent
        .submit_to_session(QueryRequest::text("new request"), loaded.clone())
        .await?;
    let mut run = match outcome {
        evot::agent::SubmitOutcome::Run(run) => run,
        evot::agent::SubmitOutcome::Command(message) => {
            return Err(std::io::Error::other(format!("unexpected command: {message}")).into())
        }
    };

    let mut saw_compaction = false;
    while let Some(event) = run.next().await {
        if matches!(
            event.payload,
            RunEventPayload::ContextCompactionCompleted { .. }
        ) {
            saw_compaction = true;
        }
    }
    assert!(saw_compaction, "expected auto compaction event");

    let raw = loaded.load_all_entries().await?;
    let compact_index = raw
        .iter()
        .position(|entry| matches!(entry.item, TranscriptItem::Compact { .. }))
        .ok_or_else(|| std::io::Error::other("missing compact boundary"))?;
    let prompt_indices: Vec<_> = raw
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            matches!(&entry.item, TranscriptItem::User { text, .. } if text == "new request")
                .then_some(index)
        })
        .collect();
    assert_eq!(
        prompt_indices.len(),
        1,
        "initial prompt must be persisted exactly once"
    );
    assert!(
        prompt_indices[0] > compact_index,
        "pre-prompt compaction must precede admission of the new prompt"
    );
    let compact = raw
        .iter()
        .find_map(|entry| match &entry.item {
            TranscriptItem::Compact {
                summary,
                messages,
                engine_messages,
                state,
                ..
            } => Some((summary, messages, engine_messages, state)),
            _ => None,
        })
        .ok_or_else(|| std::io::Error::other("missing structured compact item"))?;
    assert_eq!(compact.0, "AUTO SUMMARY FROM LLM");
    assert!(!compact.1.is_empty());
    assert!(!compact.2.is_empty());
    assert_eq!(
        compact.3.last_summary.as_deref(),
        Some("AUTO SUMMARY FROM LLM")
    );

    let expected_engine_context = compact.2.clone();

    let resumed = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing resumed session"))?;
    let (resumed_engine_context, resumed_state, _) = resumed.context_snapshot().await;
    // Compaction happens before the request is sent, so the resumed context is
    // the persisted post-compaction snapshot plus the turn that followed it.
    assert_eq!(
        &resumed_engine_context[..expected_engine_context.len()],
        expected_engine_context.as_slice()
    );
    assert!(matches!(
        resumed_engine_context.last(),
        Some(evot_engine::AgentMessage::Llm(
            evot_engine::Message::Assistant { content, .. }
        )) if content.iter().any(|block| matches!(
            block,
            evot_engine::Content::Text { text }
                if text == "assistant response after pre-prompt compaction"
        ))
    ));
    assert_eq!(
        resumed_state.and_then(|state| state.last_summary),
        Some("AUTO SUMMARY FROM LLM".to_string())
    );
    let transcript = resumed.transcript().await;
    assert!(
        matches!(&transcript[0], TranscriptItem::User { text, .. } if text.contains("AUTO SUMMARY FROM LLM"))
    );
    assert!(
        transcript.iter().all(|item| {
            !matches!(item, TranscriptItem::User { text, .. } if text.starts_with("old message one "))
        }),
        "evicted history must not reappear after resume"
    );

    Ok(())
}

fn user(text: &str) -> TranscriptItem {
    TranscriptItem::User {
        provenance: None,
        text: text.into(),
        content: vec![],
    }
}

fn assistant(text: &str) -> TranscriptItem {
    assistant_with_usage(text, 0)
}

fn assistant_with_usage(text: &str, input_tokens: u64) -> TranscriptItem {
    TranscriptItem::Assistant {
        content: vec![AssistantBlock::Text { text: text.into() }],
        stop_reason: "stop".into(),
        usage: UsageSummary {
            input: input_tokens,
            output: 10,
            cache_read: 0,
            cache_write: 0,
        },
        model: "gpt-4o".into(),
        provider: "test".into(),
        timestamp: evot_engine::now_ms(),
        error_message: None,
    }
}
