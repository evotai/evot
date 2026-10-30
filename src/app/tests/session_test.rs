use evot::agent::*;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::conf::StorageConfig;
use evot::observability::UsageSummary;
use evot::sessions::Session;
use evot::storage::open_storage;
use evot::types::*;
use tempfile::TempDir;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

fn missing_error(message: &str) -> std::io::Error {
    std::io::Error::other(message.to_string())
}

fn engine_user_text(message: &evot_engine::AgentMessage) -> Option<&str> {
    let evot_engine::AgentMessage::Llm(evot_engine::Message::User { content, .. }) = message else {
        return None;
    };
    match content.as_slice() {
        [evot_engine::Content::Text { text }] => Some(text),
        _ => None,
    }
}

fn compact_item(summary: &str, generation: u32) -> TranscriptItem {
    TranscriptItem::Compact {
        id: format!("compact-{generation}"),
        created_at: 0,
        reason: evot::types::CompactReason::Manual,
        summary: summary.into(),
        tokens_before: 100,
        tokens_after: 10,
        messages_before: 4,
        messages_after: 2,
        messages: vec![],
        engine_messages: vec![],
        state: Box::new(evot_engine::CompactionState {
            generation,
            last_summary: Some(summary.into()),
            context_summary_message: Some(evot::compact::context_view::compact_summary_text(
                summary,
            )),
            ..Default::default()
        }),
        details: evot::types::CompactDetails::default(),
    }
}

async fn write_test_compact(
    session: &Session,
    summary: &str,
    new_context: Vec<TranscriptItem>,
) -> TestResult {
    let (_, previous_state, expected_seq) = session.context_snapshot().await;
    let generation = previous_state
        .as_ref()
        .map(|state| state.generation.saturating_add(1))
        .unwrap_or(1);
    let mut item = compact_item(summary, generation);
    if let TranscriptItem::Compact { state, .. } = &mut item {
        if let Some(previous) = previous_state {
            state.file_ops = previous.file_ops;
        }
    }
    if let TranscriptItem::Compact {
        messages,
        engine_messages,
        ..
    } = &mut item
    {
        *messages = new_context.clone();
        *engine_messages = evot::conversation::convert::into_agent_messages(&new_context);
    }
    session
        .write_compact(item, new_context, expected_seq)
        .await?;
    Ok(())
}

#[tokio::test]
async fn new_session_creates_meta_and_empty_transcript() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-100".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    let meta = session.meta().await;
    let transcript = session.transcript().await;
    assert_eq!(meta.session_id, "sess-100");
    assert_eq!(meta.turns, 0);
    assert!(transcript.is_empty());
    assert!(dir
        .path()
        .join("sessions")
        .join("sess-100")
        .join("session.json")
        .exists());
    Ok(())
}

#[tokio::test]
async fn model_selection_update_is_persisted_immediately() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new_with_provider_source(
        "selection-persist".into(),
        "/tmp".into(),
        "provider-a".into(),
        "shared-model".into(),
        "repl",
        storage.clone(),
    )
    .await?;

    session
        .set_model_selection("provider-b".into(), "shared-model".into())
        .await?;
    // Reapplying the active selection (the normal per-submit path) must not
    // create duplicate audit entries.
    session
        .set_model_selection("provider-b".into(), "shared-model".into())
        .await?;

    let raw = session.load_all_entries().await?;
    let changes: Vec<_> = raw
        .iter()
        .filter_map(|entry| match &entry.item {
            TranscriptItem::Stats { kind, data } if kind == "model_change" => Some(data),
            _ => None,
        })
        .collect();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["from_provider"], "provider-a");
    assert_eq!(changes[0]["to_provider"], "provider-b");

    let reopened = Session::open("selection-persist", storage)
        .await?
        .ok_or_else(|| missing_error("missing reopened session"))?;
    let meta = reopened.meta().await;
    assert_eq!(meta.provider, "provider-b");
    assert_eq!(meta.model, "shared-model");
    // Audit facts remain append-only but never enter LLM context.
    assert!(reopened.transcript().await.is_empty());
    Ok(())
}

#[tokio::test]
async fn agent_create_session_keeps_empty_draft_out_of_lists() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = evot::conf::Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["test-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();

    let agent = Agent::new(&config, "/work")?;
    let meta = agent.create_session("repl").await?;

    assert_eq!(meta.cwd, "/work");
    assert_eq!(meta.model, "test-model");
    assert_eq!(meta.provider, "test");
    assert_eq!(meta.source, "repl");
    assert_eq!(meta.turns, 0);

    let loaded = agent
        .sessions()
        .find(&meta.session_id)
        .await?
        .ok_or_else(|| missing_error("missing created session"))?;
    assert_eq!(loaded.session_id, meta.session_id);

    let transcript = agent.sessions().transcript(&meta.session_id).await?;
    assert!(transcript.is_empty());

    let sessions = agent.sessions().list(0).await?;
    assert!(!sessions.iter().any(|s| s.session_id == meta.session_id));

    // A run can persist transcript activity before its final metadata save.
    // Such a session is real and must become visible immediately even while
    // turns/title still carry their draft values.
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or_else(|| missing_error("missing created session"))?;
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "first prompt".into(),
            content: vec![],
        }])
        .await?;
    let sessions = agent.sessions().list(0).await?;
    assert!(sessions.iter().any(|s| s.session_id == meta.session_id));
    Ok(())
}

#[tokio::test]
async fn new_session_binds_requested_workspace_and_resume_keeps_it() -> TestResult {
    let dir = TempDir::new()?;
    let workspace = dir.path().join("project");
    std::fs::create_dir_all(&workspace)?;
    let mut config = evot::conf::Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["test-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    let storage = open_storage(&config.storage)?;
    let agent = Agent::new_with_provider_for_test(
        &config,
        "/work",
        storage,
        evot_engine::provider::MockProvider::text("ok"),
    )?;

    let outcome = agent
        .submit(
            QueryRequest::text("hello")
                .cwd(workspace.to_string_lossy().into_owned())
                .source("http"),
        )
        .await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(format!("unexpected command: {message}").into());
        }
    };
    let session_id = run.session_id.clone();
    while run.next().await.is_some() {}

    let created = agent
        .sessions()
        .find(&session_id)
        .await?
        .ok_or_else(|| missing_error("missing workspace session"))?;
    let expected = std::fs::canonicalize(&workspace)?;
    assert_eq!(created.cwd, expected.to_string_lossy());

    let follow = agent
        .submit(
            QueryRequest::text("again")
                .session_id(Some(session_id.clone()))
                .cwd("/tmp")
                .source("http"),
        )
        .await?;
    let mut follow_run = match follow {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(format!("unexpected command: {message}").into());
        }
    };
    while follow_run.next().await.is_some() {}
    let resumed = agent
        .sessions()
        .find(&session_id)
        .await?
        .ok_or_else(|| missing_error("missing resumed session"))?;
    assert_eq!(resumed.cwd, created.cwd);
    Ok(())
}

#[tokio::test]
async fn resume_transcript_replays_retained_messages_with_lightweight_compact_card() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = evot::conf::Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["test-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    let agent = Agent::new(&config, "/work")?;
    let meta = agent.create_session("repl").await?;
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or_else(|| missing_error("missing resume session"))?;
    let legitimate_user =
        "The conversation history before this release contains user-authored context";
    let context = vec![
        evot::compact::context_view::compact_summary_item("summary"),
        TranscriptItem::User {
            provenance: None,
            text: legitimate_user.into(),
            content: vec![],
        },
        TranscriptItem::User {
            provenance: None,
            text: "retained".into(),
            content: vec![],
        },
    ];
    write_test_compact(&session, "summary", context).await?;
    session
        .write_items(vec![TranscriptItem::Assistant {
            content: vec![AssistantBlock::Text {
                text: "after compact".into(),
            }],
            stop_reason: "stop".into(),
            usage: UsageSummary::default(),
            model: String::new(),
            provider: String::new(),
            timestamp: 0,
            error_message: None,
        }])
        .await?;

    let resumed = agent.sessions().resume_transcript(&meta.session_id).await?;

    assert_eq!(resumed.len(), 4);
    assert!(matches!(
        &resumed[0],
        TranscriptItem::User { text, .. } if text == legitimate_user
    ));
    assert!(matches!(
        &resumed[1],
        TranscriptItem::User { text, .. } if text == "retained"
    ));
    assert!(matches!(
        &resumed[2],
        TranscriptItem::Compact {
            summary,
            messages,
            engine_messages,
            state,
            ..
        } if summary == "summary"
            && messages.is_empty()
            && engine_messages.is_empty()
            && state.generation == 0
            && state.last_summary.is_none()
            && state.context_summary_message.is_none()
    ));
    assert!(matches!(
        &resumed[3],
        TranscriptItem::Assistant { content, .. }
            if matches!(&content[..], [AssistantBlock::Text { text }] if text == "after compact")
    ));
    Ok(())
}

#[tokio::test]
async fn open_session_returns_none_for_missing() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::open("nonexistent", storage.clone()).await?;
    assert!(session.is_none());
    Ok(())
}

/// A missing API key must NOT block startup: the agent constructs fine and a
/// session can be created. The failure is deferred to query time, where it is
/// surfaced as a visible error event pointing the user at settings.
#[tokio::test]
async fn missing_api_key_defers_to_query_time() -> TestResult {
    let dir = TempDir::new()?;
    let mut config = evot::conf::Config::new(dir.path().to_path_buf());
    config
        .providers
        .insert("anthropic".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "".into(), // <- the key the dashboard has not set yet
            base_url: "http://localhost".into(),
            models: vec!["claude-sonnet".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "anthropic".into();

    // Construction must succeed despite the empty key (no startup gate).
    let agent = Agent::new(&config, "/work")?;
    let session = agent.create_session("repl").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| missing_error("missing session"))?;

    // The error appears at query time as a visible Error event, not a panic
    // or a silent finish.
    let outcome = agent
        .submit_to_session(QueryRequest::text("hello"), loaded)
        .await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(missing_error(&format!("unexpected command: {message}")).into())
        }
    };

    let mut error_message = None;
    while let Some(event) = run.next().await {
        if let RunEventPayload::Error { message } = event.payload {
            error_message = Some(message);
        }
    }

    let message = error_message.ok_or_else(|| missing_error("expected an error event"))?;
    assert!(
        message.contains("API key") && message.contains("anthropic"),
        "error should name the missing key and provider: {message}"
    );
    Ok(())
}

/// Fresh-install path: no providers configured at all (the default env file is
/// fully commented out). The agent must still construct and the failure must
/// surface at query time as a visible error pointing at configuration — not a
/// startup crash or a `provider '' not found` panic.
#[tokio::test]
async fn no_provider_configured_defers_to_query_time() -> TestResult {
    let dir = TempDir::new()?;
    // Config::new leaves `providers` empty and `llm.provider` blank, exactly
    // like a brand-new install before any key is entered.
    let config = evot::conf::Config::new(dir.path().to_path_buf());

    // Construction must succeed despite zero providers (no startup gate).
    let agent = Agent::new(&config, "/work")?;
    let session = agent.create_session("repl").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or_else(|| missing_error("missing session"))?;

    let outcome = agent
        .submit_to_session(QueryRequest::text("hello"), loaded)
        .await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(missing_error(&format!("unexpected command: {message}")).into())
        }
    };

    let mut error_message = None;
    while let Some(event) = run.next().await {
        if let RunEventPayload::Error { message } = event.payload {
            error_message = Some(message);
        }
    }

    let message = error_message.ok_or_else(|| missing_error("expected an error event"))?;
    assert!(
        message.contains("provider"),
        "error should point at provider configuration: {message}"
    );
    Ok(())
}

#[tokio::test]
async fn round_trip_session_with_transcript() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-200".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "hello".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text { text: "hi".into() }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    let loaded = Session::open("sess-200", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing loaded session"))?;
    assert_eq!(loaded.meta().await.turns, 0);
    assert_eq!(loaded.transcript().await.len(), 2);
    Ok(())
}

#[tokio::test]
async fn resume_session_appends_transcript() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-300".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "first".into(),
            content: vec![],
        }])
        .await?;

    let resumed = Session::open("sess-300", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing resumed session"))?;

    resumed
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "second".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "reply".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    let final_state = Session::open("sess-300", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing final state"))?;
    assert_eq!(final_state.transcript().await.len(), 3);
    assert_eq!(final_state.meta().await.turns, 0);
    Ok(())
}

#[tokio::test]
async fn session_title_comes_from_first_user_message() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-title".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "summarize the quarterly numbers for the infra team".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "working".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;
    session.save().await?;

    let loaded = Session::open("sess-title", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing titled session"))?;
    let title = loaded
        .meta()
        .await
        .title
        .ok_or_else(|| missing_error("missing session title"))?;

    assert_eq!(title, "summarize the quarterly numbers for the infra team");
    Ok(())
}

#[tokio::test]
async fn session_title_skips_compact_summary_user_message() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-title-compact".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    // Seed a real first turn so the session already has a good title.
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "debug the flaky auth integration test".into(),
            content: vec![],
        }])
        .await?;
    session.save().await?;

    // After compaction the context view starts with a synthetic summary user
    // message. Title rebuild must skip it and keep tracking real user turns.
    let summary_item =
        evot::compact::context_view::compact_summary_item("auth suite was flaky on CI");
    let real_user = TranscriptItem::User {
        provenance: None,
        text: "re-run the suite after the fix".into(),
        content: vec![],
    };
    write_test_compact(&session, "auth suite was flaky on CI", vec![
        summary_item,
        real_user,
    ])
    .await?;
    session.save().await?;

    let loaded = Session::open("sess-title-compact", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing compacted session"))?;
    let title = loaded
        .meta()
        .await
        .title
        .ok_or_else(|| missing_error("missing session title"))?;

    assert!(
        !title.starts_with("The conversation history before this point"),
        "title leaked compact summary prefix: {title}"
    );
    assert_eq!(title, "re-run the suite after the fix");
    Ok(())
}

#[tokio::test]
async fn save_clears_a_previously_polluted_title() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-title-heal".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    // Simulate what an older release persisted: a title derived from the
    // compaction summary boilerplate.
    session
        .update_meta(|meta| {
            meta.title = Some("The conversation history before this poi.. … 继续".to_string());
            Ok(())
        })
        .await?;

    // Compact down to a context that holds only the synthetic summary item, so
    // no real user turn is available to rebuild a title from.
    write_test_compact(&session, "everything so far", vec![
        evot::compact::context_view::compact_summary_item("everything so far"),
    ])
    .await?;
    session.save().await?;

    let loaded = Session::open("sess-title-heal", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    assert_eq!(loaded.meta().await.title, None);
    Ok(())
}

#[tokio::test]
async fn save_keeps_a_clean_title_when_context_has_no_user_turn() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-title-keep".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .update_meta(|meta| {
            meta.title = Some("investigate the flaky resume test".to_string());
            Ok(())
        })
        .await?;

    write_test_compact(&session, "everything so far", vec![
        evot::compact::context_view::compact_summary_item("everything so far"),
    ])
    .await?;
    session.save().await?;

    let loaded = Session::open("sess-title-keep", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    assert_eq!(
        loaded.meta().await.title.as_deref(),
        Some("investigate the flaky resume test")
    );
    Ok(())
}

#[tokio::test]
async fn save_and_load_meta() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let meta = SessionMeta::new("sess-001".into(), "/tmp".into(), "claude-sonnet".into());
    storage.save_session(meta).await?;

    let loaded = storage
        .get_session("sess-001")
        .await?
        .ok_or_else(|| missing_error("missing session meta"))?;
    assert_eq!(loaded.session_id, "sess-001");
    assert_eq!(loaded.cwd, "/tmp");
    assert_eq!(loaded.model, "claude-sonnet");
    assert_eq!(loaded.turns, 0);
    Ok(())
}

#[tokio::test]
async fn load_meta_not_found() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let loaded = storage.get_session("nonexistent").await?;
    assert!(loaded.is_none());
    Ok(())
}

// --- PLACEHOLDER_REST ---

#[tokio::test]
async fn save_and_load_transcript() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    storage
        .append_entry(TranscriptEntry::new(
            "sess-002".into(),
            None,
            1,
            0,
            TranscriptItem::User {
                provenance: None,
                text: "hello".into(),
                content: vec![],
            },
        ))
        .await?;
    storage
        .append_entry(TranscriptEntry::new(
            "sess-002".into(),
            None,
            2,
            0,
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "hi there".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ))
        .await?;

    let loaded = storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-002".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(loaded.len(), 2);
    assert!(matches!(&loaded[0].item, TranscriptItem::User { text, .. } if text == "hello"));
    assert!(
        matches!(&loaded[1].item, TranscriptItem::Assistant { content, ..} if matches!(&content[..], [AssistantBlock::Text { text }] if text == "hi there"))
    );
    Ok(())
}

#[tokio::test]
async fn open_resumes_from_last_compact_entry() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-compact".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "old message 1".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "old reply 1".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
            TranscriptItem::User {
                provenance: None,
                text: "old message 2".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "old reply 2".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    // Commit a Compact control point atomically.
    write_test_compact(&session, "summary of prior context", vec![
        evot::compact::context_view::compact_summary_item("summary of prior context"),
        TranscriptItem::User {
            provenance: None,
            text: "old message 2".into(),
            content: vec![],
        },
        TranscriptItem::Assistant {
            content: vec![AssistantBlock::Text {
                text: "old reply 2".into(),
            }],
            stop_reason: "stop".into(),
            usage: UsageSummary::default(),
            model: String::new(),
            provider: String::new(),
            timestamp: 0,
            error_message: None,
        },
    ])
    .await?;

    // Append more messages after compaction
    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "new message after compact".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "new reply".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    // Load — should resume from the structured compact boundary
    let loaded = Session::open("sess-compact", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing compacted session"))?;
    let transcript = loaded.transcript().await;

    // Should have: compact summary + retained snapshot + new messages.
    assert_eq!(transcript.len(), 5);
    assert!(
        matches!(&transcript[0], TranscriptItem::User { text, .. } if text.contains("summary of prior context"))
    );
    assert!(matches!(&transcript[1], TranscriptItem::User { text, .. } if text == "old message 2"));
    assert!(
        matches!(&transcript[2], TranscriptItem::Assistant { content, ..} if matches!(&content[..], [AssistantBlock::Text { text }] if text == "old reply 2"))
    );
    assert!(
        matches!(&transcript[3], TranscriptItem::User { text, .. } if text == "new message after compact")
    );
    Ok(())
}

#[tokio::test]
async fn write_compact_bounds_summary_without_touching_retained_user() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-bounded-compact-write".into(),
        "/tmp".into(),
        "model".into(),
        storage,
    )
    .await?;
    let limit = evot_engine::context::DEFAULT_SUMMARY_MAX_BYTES;
    let summary = format!(
        "SUMMARY_HEAD\n{}\nSUMMARY_TAIL",
        "s".repeat(limit.saturating_mul(2))
    );
    let retained_user = format!("LIVE_USER_HEAD\n{}\nLIVE_USER_TAIL", "u".repeat(limit));
    let replacement = vec![
        evot::compact::context_view::compact_summary_item(&summary),
        TranscriptItem::User {
            provenance: None,
            text: retained_user.clone(),
            content: vec![],
        },
    ];
    let mut item = compact_item(&summary, 1);
    if let TranscriptItem::Compact {
        messages,
        engine_messages,
        ..
    } = &mut item
    {
        *messages = replacement.clone();
        *engine_messages = evot::conversation::convert::into_agent_messages(&replacement);
    }

    session.write_compact(item, replacement, 0).await?;

    let entries = session.load_all_entries().await?;
    let (stored_summary, stored_messages, stored_engine, stored_state) = entries
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
        .ok_or_else(|| missing_error("missing persisted compact item"))?;
    assert!(stored_summary.len() <= limit);
    assert!(stored_summary.starts_with("SUMMARY_HEAD"));
    assert!(stored_summary.ends_with("SUMMARY_TAIL"));

    let stored_boundary = stored_messages
        .first()
        .and_then(TranscriptItem::as_user_text)
        .ok_or_else(|| missing_error("missing stored summary boundary"))?;
    assert!(stored_boundary.len() <= limit);
    assert_eq!(
        stored_messages
            .get(1)
            .and_then(TranscriptItem::as_user_text),
        Some(retained_user.clone())
    );
    let engine_boundary = stored_engine
        .first()
        .and_then(engine_user_text)
        .ok_or_else(|| missing_error("missing stored engine summary boundary"))?;
    assert!(engine_boundary.len() <= limit);
    assert_eq!(
        stored_engine.get(1).and_then(engine_user_text),
        Some(retained_user.as_str())
    );
    assert_eq!(
        stored_state.last_summary.as_deref(),
        Some(stored_summary.as_str())
    );
    assert_eq!(
        stored_state.context_summary_message.as_deref(),
        Some(engine_boundary)
    );

    let transcript = session.transcript().await;
    assert_eq!(
        transcript.get(1).and_then(TranscriptItem::as_user_text),
        Some(retained_user)
    );
    Ok(())
}

#[tokio::test]
async fn open_bounds_legacy_poisoned_summary_without_touching_live_user() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session_id = "sess-legacy-poisoned-summary";
    let session = Session::new(
        session_id.into(),
        "/tmp".into(),
        "model".into(),
        storage.clone(),
    )
    .await?;
    drop(session);

    let limit = evot_engine::context::DEFAULT_SUMMARY_MAX_BYTES;
    let summary = format!(
        "LEGACY_SUMMARY_HEAD\n{}\nLEGACY_SUMMARY_TAIL",
        "p".repeat(limit.saturating_mul(2))
    );
    let live_user = format!("LIVE_PROMPT_HEAD\n{}\nLIVE_PROMPT_TAIL", "q".repeat(limit));
    let compact_context = vec![evot::compact::context_view::compact_summary_item(&summary)];
    let mut item = compact_item(&summary, 1);
    if let TranscriptItem::Compact {
        messages,
        engine_messages,
        ..
    } = &mut item
    {
        *messages = compact_context.clone();
        *engine_messages = evot::conversation::convert::into_agent_messages(&compact_context);
    }
    // Bypass Session::write_compact to emulate a poisoned item persisted by an
    // older release before write-time bounds existed.
    storage
        .append_entries(vec![
            TranscriptEntry::new(session_id.into(), None, 1, 0, item),
            TranscriptEntry::new(session_id.into(), None, 2, 0, TranscriptItem::User {
                provenance: None,
                text: live_user.clone(),
                content: vec![],
            }),
        ])
        .await?;

    let reopened = Session::open(session_id, storage)
        .await?
        .ok_or_else(|| missing_error("missing reopened poisoned session"))?;
    let transcript = reopened.transcript().await;
    let transcript_boundary = transcript
        .first()
        .and_then(TranscriptItem::as_user_text)
        .ok_or_else(|| missing_error("missing repaired transcript boundary"))?;
    assert!(transcript_boundary.len() <= limit);
    assert_eq!(
        transcript.get(1).and_then(TranscriptItem::as_user_text),
        Some(live_user.clone())
    );

    let (engine, state, seq) = reopened.context_snapshot().await;
    assert_eq!(seq, 2);
    let engine_boundary = engine
        .first()
        .and_then(engine_user_text)
        .ok_or_else(|| missing_error("missing repaired engine boundary"))?;
    assert!(engine_boundary.len() <= limit);
    assert_eq!(engine_boundary, transcript_boundary);
    assert_eq!(
        engine.get(1).and_then(engine_user_text),
        Some(live_user.as_str())
    );
    let state = state.ok_or_else(|| missing_error("missing repaired compaction state"))?;
    assert!(state
        .last_summary
        .as_ref()
        .is_some_and(|summary| summary.len() <= limit));
    assert_eq!(
        state.context_summary_message.as_deref(),
        Some(engine_boundary)
    );
    Ok(())
}

#[tokio::test]
async fn open_bounds_remote_fallback_without_mutating_opaque_state() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session_id = "sess-legacy-remote-summary";
    let session = Session::new(
        session_id.into(),
        "/tmp".into(),
        "configured-model".into(),
        storage.clone(),
    )
    .await?;
    drop(session);

    let limit = evot_engine::context::DEFAULT_SUMMARY_MAX_BYTES;
    let fallback = format!(
        "REMOTE_FALLBACK_HEAD\n{}\nREMOTE_FALLBACK_TAIL",
        "r".repeat(limit.saturating_mul(2))
    );
    let opaque_item = serde_json::json!({
        "type": "compaction",
        "id": "cmp_legacy",
        "encrypted_content": "opaque-state"
    });
    let remote_message = evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
        content: vec![evot_engine::Content::Thinking {
            thinking: fallback.clone(),
            metadata: Some(evot_engine::ThinkingMetadata::OpenAiResponses {
                item: opaque_item.clone(),
            }),
        }],
        stop_reason: evot_engine::StopReason::Stop,
        model: "gpt-5.6-sol".into(),
        provider: "explicit-provider".into(),
        usage: evot_engine::Usage::default(),
        timestamp: 7,
        error_message: None,
        response_id: None,
    });
    let transcript_context = vec![evot::compact::context_view::compact_summary_item(&fallback)];
    let mut item = compact_item(&fallback, 1);
    if let TranscriptItem::Compact {
        messages,
        engine_messages,
        state,
        ..
    } = &mut item
    {
        *messages = transcript_context;
        *engine_messages = vec![remote_message];
        // Older data may have incorrectly retained a local context pointer for
        // a provider-native replacement. Resume must clear it.
        state.context_summary_message = Some(fallback.clone());
    }
    storage
        .append_entry(TranscriptEntry::new(session_id.into(), None, 1, 0, item))
        .await?;

    let reopened = Session::open(session_id, storage)
        .await?
        .ok_or_else(|| missing_error("missing reopened remote session"))?;
    assert_eq!(reopened.meta().await.model, "configured-model");
    let (engine, state, _) = reopened.context_snapshot().await;
    match engine.first() {
        Some(evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
            content,
            model,
            provider,
            timestamp,
            ..
        })) => {
            assert_eq!(model, "gpt-5.6-sol");
            assert_eq!(provider, "explicit-provider");
            assert_eq!(*timestamp, 7);
            match content.as_slice() {
                [evot_engine::Content::Thinking { thinking, metadata }] => {
                    assert!(thinking.len() <= limit);
                    assert!(thinking.starts_with("REMOTE_FALLBACK_HEAD"));
                    assert!(thinking.ends_with("REMOTE_FALLBACK_TAIL"));
                    assert!(matches!(
                        metadata,
                        Some(evot_engine::ThinkingMetadata::OpenAiResponses { item })
                            if item == &opaque_item
                    ));
                }
                _ => return Err(missing_error("unexpected remote replacement content").into()),
            }
        }
        _ => return Err(missing_error("missing remote replacement message").into()),
    }
    let state = state.ok_or_else(|| missing_error("missing remote compaction state"))?;
    assert!(state
        .last_summary
        .as_ref()
        .is_some_and(|summary| summary.len() <= limit));
    assert!(state.context_summary_message.is_none());
    Ok(())
}

#[tokio::test]
async fn compaction_seed_updates_restores_and_clear_breaks_chain() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-compact-seed".into(),
        "/tmp".into(),
        "model".into(),
        storage.clone(),
    )
    .await?;

    let mut first = compact_item("summary-v1", 1);
    if let TranscriptItem::Compact {
        details,
        messages,
        engine_messages,
        state,
        ..
    } = &mut first
    {
        details.read_files.push("src/read.rs".into());
        details.modified_files.push("src/edited.rs".into());
        state.file_ops.read.insert("src/read.rs".into());
        state.file_ops.edited.insert("src/edited.rs".into());
        *messages = vec![evot::compact::context_view::compact_summary_item(
            "summary-v1",
        )];
        *engine_messages = evot::conversation::convert::into_agent_messages(messages);
    }
    session
        .write_compact(
            first,
            vec![evot::compact::context_view::compact_summary_item(
                "summary-v1",
            )],
            0,
        )
        .await?;

    let seed = session
        .compaction_seed()
        .await
        .ok_or_else(|| missing_error("missing in-process compaction seed"))?;
    assert_eq!(seed.generation, 1);
    assert_eq!(seed.last_summary.as_deref(), Some("summary-v1"));
    assert!(seed.file_ops.read.contains("src/read.rs"));
    assert!(seed.file_ops.edited.contains("src/edited.rs"));

    write_test_compact(&session, "summary-v2", vec![
        evot::compact::context_view::compact_summary_item("summary-v2"),
    ])
    .await?;
    assert_eq!(
        session
            .compaction_seed()
            .await
            .map(|state| state.generation),
        Some(2)
    );

    drop(session);
    let reopened = Session::open("sess-compact-seed", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing compacted session"))?;
    let restored = reopened
        .compaction_seed()
        .await
        .ok_or_else(|| missing_error("missing restored compaction seed"))?;
    assert_eq!(restored.generation, 2);
    assert_eq!(restored.last_summary.as_deref(), Some("summary-v2"));

    reopened.write_clear_marker().await?;
    assert!(reopened.compaction_seed().await.is_none());
    drop(reopened);

    let after_clear = Session::open("sess-compact-seed", storage)
        .await?
        .ok_or_else(|| missing_error("missing cleared session"))?;
    assert!(after_clear.compaction_seed().await.is_none());
    Ok(())
}

#[tokio::test]
async fn open_without_compact_returns_all_entries() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-no-compact".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "hello".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text { text: "hi".into() }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    let loaded = Session::open("sess-no-compact", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let transcript = loaded.transcript().await;
    assert_eq!(transcript.len(), 2);
    assert!(matches!(&transcript[0], TranscriptItem::User { text, .. } if text == "hello"));
    assert!(
        matches!(&transcript[1], TranscriptItem::Assistant { content, ..} if matches!(&content[..], [AssistantBlock::Text { text }] if text == "hi"))
    );
    Ok(())
}

#[tokio::test]
async fn write_items_is_append_only() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-append".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "first".into(),
            content: vec![],
        }])
        .await?;

    write_test_compact(&session, "compacted", vec![
        evot::compact::context_view::compact_summary_item("compacted"),
    ])
    .await?;

    // Raw storage should have 2 entries (User + Compact), not a rewrite
    let raw = storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-append".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(raw.len(), 2);
    assert!(matches!(&raw[0].item, TranscriptItem::User { .. }));
    assert!(matches!(&raw[1].item, TranscriptItem::Compact { .. }));
    Ok(())
}

#[tokio::test]
async fn failed_batch_does_not_publish_session_state_or_advance_sequence() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-failed-batch".into(),
        "/tmp".into(),
        "model".into(),
        storage.clone(),
    )
    .await?;

    let transcript_path = dir
        .path()
        .join("sessions")
        .join("sess-failed-batch")
        .join("transcript.jsonl");
    std::fs::create_dir(&transcript_path)?;

    let result = session
        .write_items(vec![compact_item("must not publish", 1)])
        .await;
    assert!(result.is_err());
    assert!(session.transcript().await.is_empty());
    assert!(session.compaction_seed().await.is_none());

    std::fs::remove_dir(&transcript_path)?;
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "first durable item".into(),
            content: vec![],
        }])
        .await?;

    let entries = session.load_all_entries().await?;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].seq, 1);
    assert!(matches!(
        &entries[0].item,
        TranscriptItem::User { text, .. } if text == "first durable item"
    ));
    Ok(())
}

#[tokio::test]
async fn concurrent_batches_receive_contiguous_non_interleaved_sequences() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-concurrent-batches".into(),
        "/tmp".into(),
        "model".into(),
        storage,
    )
    .await?;

    let left = {
        let session = session.clone();
        tokio::spawn(async move {
            session
                .write_items(vec![
                    TranscriptItem::User {
                        provenance: None,
                        text: "left-1".into(),
                        content: vec![],
                    },
                    TranscriptItem::User {
                        provenance: None,
                        text: "left-2".into(),
                        content: vec![],
                    },
                ])
                .await
        })
    };
    let right = {
        let session = session.clone();
        tokio::spawn(async move {
            session
                .write_items(vec![
                    TranscriptItem::User {
                        provenance: None,
                        text: "right-1".into(),
                        content: vec![],
                    },
                    TranscriptItem::User {
                        provenance: None,
                        text: "right-2".into(),
                        content: vec![],
                    },
                ])
                .await
        })
    };
    left.await??;
    right.await??;

    let entries = session.load_all_entries().await?;
    assert_eq!(entries.len(), 4);
    assert_eq!(
        entries.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    let texts = entries
        .iter()
        .filter_map(|entry| match &entry.item {
            TranscriptItem::User { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(
        texts == ["left-1", "left-2", "right-1", "right-2"]
            || texts == ["right-1", "right-2", "left-1", "left-2"]
    );
    Ok(())
}

#[tokio::test]
async fn independent_storage_handles_cannot_duplicate_sequences() -> TestResult {
    let dir = TempDir::new()?;
    let first_storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let created = Session::new(
        "sess-independent-handles".into(),
        "/tmp".into(),
        "model".into(),
        first_storage.clone(),
    )
    .await?;
    let second_storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let reopened = Session::open("sess-independent-handles", second_storage)
        .await?
        .ok_or_else(|| missing_error("missing reopened session"))?;

    let first = tokio::spawn(async move {
        created
            .write_items(vec![TranscriptItem::User {
                provenance: None,
                text: "first writer".into(),
                content: vec![],
            }])
            .await
    });
    let second = tokio::spawn(async move {
        reopened
            .write_items(vec![TranscriptItem::User {
                provenance: None,
                text: "second writer".into(),
                content: vec![],
            }])
            .await
    });
    first.await??;
    second.await??;

    let entries = first_storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-independent-handles".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
        vec![1, 2]
    );
    Ok(())
}

#[tokio::test]
async fn turn_write_rebases_after_external_advancement_without_losing_messages() -> TestResult {
    let dir = TempDir::new()?;
    let first_storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let first = Session::new(
        "sess-rebased-turn".into(),
        "/tmp".into(),
        "model".into(),
        first_storage.clone(),
    )
    .await?;
    let second_storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let second = Session::open("sess-rebased-turn", second_storage)
        .await?
        .ok_or_else(|| missing_error("missing second session handle"))?;
    let (_, _, expected_seq) = first.context_snapshot().await;

    second
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "external".into(),
            content: vec![],
        }])
        .await?;
    let append = first
        .write_items_at(
            vec![TranscriptItem::User {
                provenance: None,
                text: "stale run".into(),
                content: vec![],
            }],
            expected_seq,
        )
        .await?;
    assert_eq!(append.next_seq, 2);
    assert_eq!(
        append.interleaved_context_items, 1,
        "an external user message is context the run never saw"
    );

    let entries = first_storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-rebased-turn".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(matches!(
        &entries[0].item,
        TranscriptItem::User { text, .. } if text == "external"
    ));
    assert!(matches!(
        &entries[1].item,
        TranscriptItem::User { text, .. } if text == "stale run"
    ));
    Ok(())
}

/// A background-task notice (or any stats item) written by the same process
/// during a run advances the sequence but is not conversation content. The
/// turn write must land after it and report zero interleaved context items so
/// the run's compaction is still persisted.
#[tokio::test]
async fn turn_write_after_stats_notice_reports_no_interleaved_context() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-notice-during-run".into(),
        "/tmp".into(),
        "model".into(),
        storage.clone(),
    )
    .await?;
    let (_, _, expected_seq) = session.context_snapshot().await;

    // Same Session handle, as the CLI's ui_notice path does mid-run.
    session
        .write_items(vec![TranscriptItem::Stats {
            kind: "ui_notice".into(),
            data: serde_json::json!({ "text": "completed in background" }),
        }])
        .await?;
    let append = session
        .write_items_at(
            vec![TranscriptItem::User {
                provenance: None,
                text: "turn prompt".into(),
                content: vec![],
            }],
            expected_seq,
        )
        .await?;
    assert_eq!(append.next_seq, 2);
    assert_eq!(append.interleaved_context_items, 0);

    // Now the compaction planned against the advanced generation is accepted.
    session
        .write_compact(
            compact_item("summary", 1),
            vec![TranscriptItem::User {
                provenance: None,
                text: "summary".into(),
                content: vec![],
            }],
            append.next_seq,
        )
        .await?;
    let entries = storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-notice-during-run".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert!(matches!(
        entries.last().map(|entry| &entry.item),
        Some(TranscriptItem::Compact { .. })
    ));
    Ok(())
}

/// External context and a stats item interleaved together: only the context
/// item is counted.
#[tokio::test]
async fn turn_write_counts_only_context_items_among_interleaved_writes() -> TestResult {
    let dir = TempDir::new()?;
    let first_storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let first = Session::new(
        "sess-mixed-interleave".into(),
        "/tmp".into(),
        "model".into(),
        first_storage,
    )
    .await?;
    let second_storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let second = Session::open("sess-mixed-interleave", second_storage)
        .await?
        .ok_or_else(|| missing_error("missing second session handle"))?;
    let (_, _, expected_seq) = first.context_snapshot().await;

    second
        .write_items(vec![
            TranscriptItem::Stats {
                kind: "ui_notice".into(),
                data: serde_json::json!({}),
            },
            TranscriptItem::User {
                provenance: None,
                text: "external".into(),
                content: vec![],
            },
            TranscriptItem::Stats {
                kind: "ui_notice".into(),
                data: serde_json::json!({}),
            },
        ])
        .await?;
    let append = first
        .write_items_at(
            vec![TranscriptItem::User {
                provenance: None,
                text: "run prompt".into(),
                content: vec![],
            }],
            expected_seq,
        )
        .await?;
    assert_eq!(append.next_seq, 4);
    assert_eq!(append.interleaved_context_items, 1);
    Ok(())
}

#[tokio::test]
async fn stale_compaction_plan_is_rejected_before_persistence() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-stale-compact".into(),
        "/tmp".into(),
        "model".into(),
        storage,
    )
    .await?;

    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "planned history".into(),
            content: vec![],
        }])
        .await?;
    let expected_seq = 1;
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "concurrent write".into(),
            content: vec![],
        }])
        .await?;

    let result = session
        .write_compact(
            compact_item("stale summary", 1),
            vec![TranscriptItem::User {
                provenance: None,
                text: "stale replacement".into(),
                content: vec![],
            }],
            expected_seq,
        )
        .await;
    assert!(result.is_err());

    let entries = session.load_all_entries().await?;
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .all(|entry| !matches!(entry.item, TranscriptItem::Compact { .. })));
    let transcript = session.transcript().await;
    assert_eq!(transcript.len(), 2);
    assert!(matches!(
        &transcript[1],
        TranscriptItem::User { text, .. } if text == "concurrent write"
    ));
    Ok(())
}

#[tokio::test]
async fn multiple_compactions_uses_last() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-multi-compact".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "msg1".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "reply1".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    // First compaction
    write_test_compact(&session, "compact-v1", vec![
        evot::compact::context_view::compact_summary_item("compact-v1"),
        TranscriptItem::User {
            provenance: None,
            text: "msg1".into(),
            content: vec![],
        },
    ])
    .await?;

    // More messages
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "msg2".into(),
            content: vec![],
        }])
        .await?;

    // Second compaction
    write_test_compact(&session, "compact-v2", vec![
        evot::compact::context_view::compact_summary_item("compact-v2"),
        TranscriptItem::User {
            provenance: None,
            text: "msg2".into(),
            content: vec![],
        },
    ])
    .await?;

    // One more message after second compaction
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "msg3".into(),
            content: vec![],
        }])
        .await?;

    // Load should use the second (last) compact
    let loaded = Session::open("sess-multi-compact", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let transcript = loaded.transcript().await;

    // compact-v2 messages (1) + msg3 (1) = 2
    assert_eq!(transcript.len(), 3);
    assert!(
        matches!(&transcript[0], TranscriptItem::User { text, .. } if text.contains("compact-v2"))
    );
    assert!(matches!(&transcript[1], TranscriptItem::User { text, .. } if text == "msg2"));
    assert!(matches!(&transcript[2], TranscriptItem::User { text, .. } if text == "msg3"));
    Ok(())
}

// ---------------------------------------------------------------------------
// Stats filtering on resume
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stats_items_persisted_but_filtered_on_resume() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-stats".into(),
        "/tmp".into(),
        "m".into(),
        storage.clone(),
    )
    .await?;

    // Write a mix of conversation items and stats
    let stats_item = evot::observability::TranscriptStats::LlmCallCompleted(
        evot::observability::LlmCallCompletedStats {
            turn: 1,
            attempt: 0,
            usage: evot::observability::UsageSummary {
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
            },
            metrics: None,
            error: None,
            context_window: 0,
            stop_reason: "stop".into(),
        },
    )
    .to_item();

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "hello".into(),
                content: vec![],
            },
            stats_item,
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text { text: "hi".into() }],
                stop_reason: "end_turn".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;
    session.save().await?;

    // Raw storage should have 3 entries
    let raw = storage
        .list_entries(evot::types::ListTranscriptEntries {
            session_id: "sess-stats".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(raw.len(), 3);
    assert!(
        matches!(&raw[1].item, TranscriptItem::Stats { kind, .. } if kind == "llm_call_completed")
    );

    // Resumed session transcript should only have 2 items (no stats)
    let loaded = Session::open("sess-stats", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let transcript = loaded.transcript().await;
    assert_eq!(transcript.len(), 2);
    assert!(matches!(&transcript[0], TranscriptItem::User { text, .. } if text == "hello"));
    assert!(
        matches!(&transcript[1], TranscriptItem::Assistant { content, ..} if matches!(&content[..], [AssistantBlock::Text { text }] if text == "hi"))
    );
    Ok(())
}

#[tokio::test]
async fn stats_after_compact_filtered_on_resume() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-stats-compact".into(),
        "/tmp".into(),
        "m".into(),
        storage.clone(),
    )
    .await?;

    // Write initial messages
    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "old msg".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "old reply".into(),
                }],
                stop_reason: "end_turn".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    // Write compact + stats + new message
    let compact_stats = evot::observability::TranscriptStats::ContextCompactionCompleted(
        evot::observability::ContextCompactionCompletedStats {
            reason: evot::types::CompactReason::Threshold,
            result: evot::observability::CompactionResult::Compacted {
                before_message_count: 10,
                after_message_count: 4,
                before_tokens: 30000,
                after_tokens: 12000,
                messages_evicted: 6,
                current_run_reclaimed: 0,
                method: None,
                remote_blob_bytes: None,
                fallback_reason: None,
            },
            context_window: 0,
            will_retry: false,
        },
    )
    .to_item();

    write_test_compact(&session, "summary", vec![
        evot::compact::context_view::compact_summary_item("summary"),
    ])
    .await?;
    session
        .write_items(vec![compact_stats, TranscriptItem::User {
            provenance: None,
            text: "new msg".into(),
            content: vec![],
        }])
        .await?;
    session.save().await?;

    // Resume: should see compact base + new msg, no stats
    let loaded = Session::open("sess-stats-compact", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let transcript = loaded.transcript().await;
    assert_eq!(transcript.len(), 2);
    assert!(
        matches!(&transcript[0], TranscriptItem::User { text, .. } if text.contains("summary"))
    );
    assert!(matches!(&transcript[1], TranscriptItem::User { text, .. } if text == "new msg"));
    Ok(())
}

/// Session titles come from raw user input, not assistant commentary.
#[tokio::test]
async fn title_is_correct_when_user_message_is_clean() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-clean-title".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;

    // Store only raw user input in the transcript.
    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "refactor the auth module to use JWT".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "I will inspect the auth module.".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;
    session.save().await?;

    let loaded = Session::open("sess-clean-title", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let title = loaded
        .meta()
        .await
        .title
        .ok_or_else(|| missing_error("missing session title"))?;

    assert_eq!(title, "refactor the auth module to use JWT");
    Ok(())
}

// ---------------------------------------------------------------------------
// Marker tests — /clear, /goto, new Compact marker
// ---------------------------------------------------------------------------

#[tokio::test]
async fn clear_marker_resets_context() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-clear".into(),
        "/tmp".into(),
        "model".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "msg1".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "reply1".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    session.write_clear_marker().await?;

    // In-memory transcript should be empty after clear
    assert!(session.transcript().await.is_empty());

    // New messages after clear
    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "fresh start".into(),
            content: vec![],
        }])
        .await?;

    // Reload from storage — should only see post-clear messages
    let loaded = Session::open("sess-clear", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let transcript = loaded.transcript().await;
    assert_eq!(transcript.len(), 1);
    assert!(matches!(&transcript[0], TranscriptItem::User { text, .. } if text == "fresh start"));
    Ok(())
}

#[tokio::test]
async fn structured_compact_entry_rebuilds_context() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;

    let session = Session::new(
        "sess-new-compact".into(),
        "/tmp".into(),
        "model".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "old".into(),
                content: vec![],
            },
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "old reply".into(),
                }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ])
        .await?;

    let replacement = vec![TranscriptItem::User {
        provenance: None,
        text: "compacted summary".into(),
        content: vec![],
    }];
    let mut item = compact_item("compacted summary", 1);
    if let TranscriptItem::Compact {
        messages,
        engine_messages,
        ..
    } = &mut item
    {
        *messages = replacement.clone();
        *engine_messages = evot::conversation::convert::into_agent_messages(&replacement);
    }
    session.write_compact(item, replacement, 2).await?;

    session
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "after compact".into(),
            content: vec![],
        }])
        .await?;

    // Reload — should see the exact compact snapshot plus the new message.
    let loaded = Session::open("sess-new-compact", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing session"))?;
    let transcript = loaded.transcript().await;
    assert_eq!(transcript.len(), 2);
    assert!(
        matches!(&transcript[0], TranscriptItem::User { text, .. } if text.contains("compacted summary"))
    );
    assert!(matches!(&transcript[1], TranscriptItem::User { text, .. } if text == "after compact"));
    Ok(())
}

#[test]
fn marker_item_is_not_context() {
    let item = TranscriptItem::Marker {
        kind: evot::types::MarkerKind::Clear,
        messages: vec![],
    };
    assert!(!item.is_context_item());
}

// ---------------------------------------------------------------------------
// LLM request payload — delta persistence
// ---------------------------------------------------------------------------

fn llm_started_item(prompt: &str) -> TranscriptItem {
    use evot::observability::*;
    TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        model: "m".into(),
        system_prompt: prompt.into(),
        tool_definitions: vec![ToolDef {
            name: "read".into(),
            description: "read a file".into(),
            parameters: serde_json::json!({"type": "object"}),
        }],
        ..Default::default()
    })
    .to_item()
}

#[tokio::test]
async fn llm_request_payload_is_delta_persisted() -> TestResult {
    use evot::observability::TranscriptStats;

    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-delta".into(),
        "/tmp".into(),
        "m".into(),
        storage.clone(),
    )
    .await?;

    // Same payload twice, then a changed one.
    session
        .write_items(vec![llm_started_item("prompt v1")])
        .await?;
    session
        .write_items(vec![llm_started_item("prompt v1")])
        .await?;
    session
        .write_items(vec![llm_started_item("prompt v2")])
        .await?;

    let entries = storage
        .list_entries(evot::types::ListTranscriptEntries {
            session_id: "sess-delta".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    let persisted: Vec<(String, usize)> = entries
        .iter()
        .filter_map(|e| match TranscriptStats::try_from_item(&e.item) {
            Some(TranscriptStats::LlmCallStarted(s)) => {
                Some((s.system_prompt, s.tool_definitions.len()))
            }
            _ => None,
        })
        .collect();
    // The repeat is stripped to empty; the changed payload is persisted full.
    assert_eq!(persisted, vec![
        ("prompt v1".to_string(), 1),
        (String::new(), 0),
        ("prompt v2".to_string(), 1),
    ]);
    Ok(())
}

#[tokio::test]
async fn session_title_uses_typed_line_of_expanded_command() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-command-title".into(),
        "/tmp".into(),
        "claude-sonnet".into(),
        storage.clone(),
    )
    .await?;
    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: evot::command::command_prompt(
                    "loop",
                    "/loop 5m watch the CI run",
                    "You are running a recurring loop.\n\nRules:\n- never busy-poll",
                ),
                content: vec![],
            },
            TranscriptItem::User {
                provenance: None,
                text: evot::command::command_prompt("loop-wakeup", "loop wakeup #1", "Continue"),
                content: vec![],
            },
        ])
        .await?;
    session.save().await?;

    let loaded = Session::open("sess-command-title", storage.clone())
        .await?
        .ok_or_else(|| missing_error("missing titled session"))?;
    let title = loaded
        .meta()
        .await
        .title
        .ok_or_else(|| missing_error("missing session title"))?;
    assert_eq!(title, "/loop 5m watch the CI run");
    Ok(())
}
