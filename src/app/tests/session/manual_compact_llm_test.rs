use std::sync::Arc;

use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::SubmitOutcome;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::session::storage::MemoryStorage;
use evot::types::AssistantBlock;
use evot::types::TranscriptItem;
use evot::types::UsageSummary;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use tempfile::TempDir;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn manual_compact_uses_llm_summary() -> TestResult {
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
        MockResponse::Text("MANUAL LLM SUMMARY".into()),
        MockResponse::Text("MANUAL SPLIT SUMMARY".into()),
    ]);
    let storage = Arc::new(MemoryStorage::new());
    let agent = Agent::new_with_provider_for_test(&config, "/work", storage, provider)?;
    let session = agent.create_session("test").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;

    loaded
        .write_items(vec![
            user("old manual compact message"),
            assistant("old assistant"),
            user(&"recent manual compact request ".repeat(5000)),
            assistant("recent answer"),
            user("latest retained request"),
            assistant("latest retained answer"),
            user("final retained request"),
            assistant("final retained answer"),
        ])
        .await?;

    let outcome = agent
        .submit_to_session(
            QueryRequest::text("/compact focus on decisions"),
            loaded.clone(),
        )
        .await?;
    match outcome {
        SubmitOutcome::Command(message) => assert!(message.contains("Session compacted")),
        SubmitOutcome::Run(_) => {
            return Err(std::io::Error::other("expected command outcome").into())
        }
    }

    let raw = loaded.load_all_entries().await?;
    let summary = raw.iter().find_map(|entry| match &entry.item {
        TranscriptItem::Compact { summary, .. } => Some(summary.as_str()),
        _ => None,
    });
    assert!(matches!(summary, Some(summary) if summary.contains("MANUAL LLM SUMMARY")));
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let cancelled = agent.compact(&session.session_id, None, cancel).await?;
    assert!(matches!(
        cancelled,
        evot::session::compact::orchestrator::ManualCompactionOutcome::Cancelled
    ));

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
    TranscriptItem::Assistant {
        content: vec![AssistantBlock::Text { text: text.into() }],
        stop_reason: "stop".into(),
        usage: UsageSummary::default(),
        model: String::new(),
        provider: String::new(),
        timestamp: 0,
        error_message: None,
    }
}
