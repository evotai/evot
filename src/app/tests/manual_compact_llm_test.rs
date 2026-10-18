use std::sync::Arc;
use std::sync::Mutex;

use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::SubmitOutcome;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::observability::UsageSummary;
use evot::storage::MemoryStorage;
use evot::types::AssistantBlock;
use evot::types::CompactionMethod;
use evot::types::TranscriptItem;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use tempfile::TempDir;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn manual_compact_uses_remote_responses_and_persists_blob() -> TestResult {
    let server = MockServer::start().await;
    let sse = concat!(
        "event: response.output_item.done\n",
        "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"compaction\",\"id\":\"cmp_manual\",\"encrypted_content\":\"manual-opaque-state\"}}\n\n",
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
    );
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAiResponses,
        api_key: "test-key".into(),
        base_url: server.uri(),
        models: vec!["gpt-5.6-sol".into()],
        compat_caps: evot_engine::provider::CompatCaps::NONE,
        route_capabilities: evot_engine::provider::RouteCapabilityOverrides {
            verbosity: false,
            remote_compaction: true,
        },
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    config.llm.model_override = Some("gpt-5.6-sol".into());

    let provider = MockProvider::new(vec![]);
    let storage = Arc::new(MemoryStorage::new());
    let agent = Agent::new_with_provider_for_test(&config, "/work", storage, provider)?;
    let session = agent.create_session("remote-manual").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;
    loaded
        .write_items(vec![
            user("old manual remote message"),
            assistant("old assistant"),
            user(&"recent manual remote request ".repeat(5000)),
            assistant("recent answer"),
            user("latest retained request"),
            assistant("latest retained answer"),
            user("final retained request"),
            assistant("final retained answer"),
        ])
        .await?;

    let phases = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&phases);
    let observer: evot::compact::orchestrator::ManualCompactionObserver = Arc::new(move |update| {
        if update.activity.is_none() {
            if let Ok(mut phases) = observed.lock() {
                phases.push(update.phase);
            }
        }
    });
    let outcome = agent
        .compact_with_observer(
            &session.session_id,
            None,
            tokio_util::sync::CancellationToken::new(),
            Some(observer),
        )
        .await?;
    assert!(matches!(
        outcome,
        evot::compact::orchestrator::ManualCompactionOutcome::Compacted {
            method: Some(ref method), ..
        } if *method == CompactionMethod::Remote
    ));
    let observed_phases = phases
        .lock()
        .map_err(|_| std::io::Error::other("phase lock poisoned"))?
        .clone();
    assert_eq!(observed_phases.as_slice(), [
        evot::compact::orchestrator::ManualCompactionPhase::Planning,
        evot::compact::orchestrator::ManualCompactionPhase::Remote,
        evot::compact::orchestrator::ManualCompactionPhase::Complete,
    ]);

    let raw = loaded.load_all_entries().await?;
    let compact = raw.iter().find_map(|entry| match &entry.item {
        TranscriptItem::Compact {
            details,
            messages,
            engine_messages,
            state,
            ..
        } => Some((details, messages, engine_messages, state)),
        _ => None,
    });
    let (details, messages, engine_messages, state) =
        compact.ok_or_else(|| std::io::Error::other("missing compact item"))?;
    assert_eq!(details.method, Some(CompactionMethod::Remote));
    assert_eq!(details.remote_blob_bytes, Some(19));
    assert!(matches!(
        messages.first(),
        Some(TranscriptItem::User { .. })
    ));
    assert!(matches!(
        engine_messages.first(),
        Some(evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant { content, .. }))
            if matches!(content.first(), Some(evot_engine::Content::Thinking {
                metadata: Some(evot_engine::ThinkingMetadata::OpenAiResponses { item }), ..
            }) if item["encrypted_content"] == "manual-opaque-state")
    ));
    assert!(state.context_summary_message.is_none());

    Ok(())
}

#[tokio::test]
async fn manual_remote_failure_persists_fallback_reason() -> TestResult {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_string(r#"{"detail":"Store must be set to false"}"#),
        )
        .mount(&server)
        .await;

    let dir = TempDir::new()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAiResponses,
        api_key: "test-key".into(),
        base_url: server.uri(),
        models: vec!["gpt-5.6-sol".into()],
        compat_caps: evot_engine::provider::CompatCaps::NONE,
        route_capabilities: evot_engine::provider::RouteCapabilityOverrides {
            verbosity: false,
            remote_compaction: true,
        },
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    config.llm.model_override = Some("gpt-5.6-sol".into());

    let provider = MockProvider::new(vec![MockResponse::Text("LOCAL SUMMARY".into())]);
    let storage = Arc::new(MemoryStorage::new());
    let agent = Agent::new_with_provider_for_test(&config, "/work", storage, provider)?;
    let session = agent.create_session("remote-fallback").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;
    loaded
        .write_items(vec![
            user("old remote fallback request"),
            assistant("old answer"),
            user(&"large recent request ".repeat(8000)),
            assistant("recent answer"),
            user("latest retained request"),
            assistant("latest retained answer"),
            user("final retained request"),
            assistant("final retained answer"),
        ])
        .await?;

    let outcome = agent
        .compact(
            &session.session_id,
            None,
            tokio_util::sync::CancellationToken::new(),
        )
        .await?;
    assert!(matches!(
        outcome,
        evot::compact::orchestrator::ManualCompactionOutcome::Compacted {
            method: Some(ref method),
            fallback_reason: Some(ref reason),
            ..
        } if *method == CompactionMethod::RemoteFailedLocal && reason.contains("Store must be set to false")
    ));

    let raw = loaded.load_all_entries().await?;
    let details = raw.iter().find_map(|entry| match &entry.item {
        TranscriptItem::Compact { details, .. } => Some(details),
        _ => None,
    });
    let details = details.ok_or_else(|| std::io::Error::other("missing compact details"))?;
    assert_eq!(details.method, Some(CompactionMethod::RemoteFailedLocal));
    assert!(details
        .fallback_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Store must be set to false")));

    Ok(())
}

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
        evot::compact::orchestrator::ManualCompactionOutcome::Cancelled
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
