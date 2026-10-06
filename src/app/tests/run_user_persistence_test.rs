use std::sync::Arc;

use async_trait::async_trait;
use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::SubmitOutcome;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::storage::MemoryStorage;
use evot::types::TranscriptItem;
use evot_engine::provider::MockProvider;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::Message;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct RecordingProvider {
    requests: Arc<Mutex<Vec<Vec<Message>>>>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}

#[async_trait]
impl StreamProvider for RecordingProvider {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let first = {
            let mut requests = self.requests.lock().await;
            requests.push(config.messages.clone());
            requests.len() == 1
        };
        if first {
            self.entered.add_permits(1);
            if let Ok(permit) = self.release.acquire().await {
                permit.forget();
            }
        }
        MockProvider::text("acknowledged")
            .stream(config, tx, cancel)
            .await
    }
}

fn user_texts(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|message| match message {
            Message::User { content, .. } => Some(
                content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn admitted_inputs_survive_next_run_reload_and_compaction_snapshot() -> TestResult {
    tokio::time::timeout(std::time::Duration::from_secs(20), exercise_persistence()).await??;
    Ok(())
}

async fn exercise_persistence() -> TestResult {
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
    let storage = Arc::new(MemoryStorage::new());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let provider = || RecordingProvider {
        requests: requests.clone(),
        entered: entered.clone(),
        release: release.clone(),
    };
    let agent = Agent::new_with_provider_for_test(&config, "/work", storage.clone(), provider())?;
    let info = agent.create_session("test").await?;
    let session = agent
        .load_session(&info.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;
    let SubmitOutcome::Run(mut run) = agent
        .submit_to_session(QueryRequest::text("review the PR"), session.clone())
        .await?
    else {
        return Err(std::io::Error::other("expected run").into());
    };
    entered.acquire().await?.forget();
    let control = run.handle();
    control.steer(AgentMessage::Llm(Message::user(
        "also check for new issues",
    )));
    // Identical text is an intentional second instruction, not a duplicate
    // event: content-based deduplication would incorrectly discard it.
    control.follow_up(AgentMessage::Llm(Message::user(
        "also check for new issues",
    )));
    release.add_permits(1);
    while run.next().await.is_some() {}

    let expected = vec![
        "review the PR",
        "also check for new issues",
        "also check for new issues",
    ];
    let entries = session.load_all_entries().await?;
    let saved: Vec<_> = entries
        .iter()
        .filter_map(|entry| match &entry.item {
            TranscriptItem::User { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        saved, expected,
        "every admitted user input must be saved exactly once"
    );
    let calls = requests.lock().await;
    assert_eq!(calls.len(), 3);
    for (index, call) in calls.iter().enumerate() {
        assert_eq!(user_texts(call), expected[..=index]);
    }
    drop(calls);

    // A stale completion wake must finish its lifecycle without calling the
    // provider or persisting a synthetic 'continue' user message.
    let SubmitOutcome::Run(mut wake) = agent
        .submit_to_session(QueryRequest::text(""), session.clone())
        .await?
    else {
        return Err("expected wake run".into());
    };
    while let Some(event) = wake.next().await {
        if let evot::agent::RunEventPayload::RunFinished {
            turn_count,
            transcript_count,
            ..
        } = event.payload
        {
            assert_eq!(turn_count, 0);
            assert_eq!(transcript_count, 0);
        }
    }
    assert_eq!(
        requests.lock().await.len(),
        3,
        "empty wake called the provider"
    );
    assert!(!agent.has_active_run(&info.session_id));
    let after_wake = session.load_all_entries().await?;
    let users_after_wake: Vec<_> = after_wake
        .iter()
        .filter_map(|entry| match &entry.item {
            TranscriptItem::User { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(users_after_wake, expected);

    // A fresh Agent rules out recovering the missing instruction from the old
    // run's in-memory context instead of the persisted session.
    let reloaded_agent = Agent::new_with_provider_for_test(&config, "/work", storage, provider())?;
    let reloaded = reloaded_agent
        .load_session(&info.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing reloaded session"))?;
    let (_, engine_context, _, _) = reloaded.compaction_snapshot().await;
    let messages: Vec<_> = engine_context
        .into_iter()
        .filter_map(|message| match message {
            AgentMessage::Llm(message) => Some(message),
            _ => None,
        })
        .collect();
    assert_eq!(
        user_texts(&messages),
        expected,
        "compaction must receive the user's corrections"
    );
    let SubmitOutcome::Run(mut next) = reloaded_agent
        .submit_to_session(QueryRequest::text("continue"), reloaded)
        .await?
    else {
        return Err(std::io::Error::other("expected next run").into());
    };
    while next.next().await.is_some() {}
    let calls = requests.lock().await;
    assert_eq!(calls.len(), 4);
    assert_eq!(user_texts(&calls[3]), vec![
        "review the PR",
        "also check for new issues",
        "also check for new issues",
        "continue"
    ]);
    Ok(())
}
