use chrono::DateTime;
use chrono::Utc;
use evot::agent::prompt::skill::load_skill;
use evot::agent::prompt::skill::load_skill_instructions;
use evot::search::SessionCandidates;
use evot::search::SessionDigest;
use evot::search::SessionSearch;
use evot::storage::MemoryStorage;
use evot::storage::Storage;
use evot::types::AssistantBlock;
use evot::types::CompactDetails;
use evot::types::CompactReason;
use evot::types::SessionMeta;
use evot::types::TranscriptEntry;
use evot::types::TranscriptItem;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn user(text: &str) -> TranscriptItem {
    TranscriptItem::User {
        text: text.into(),
        content: vec![],
    }
}

fn assistant(text: &str) -> TranscriptItem {
    TranscriptItem::Assistant {
        content: vec![
            AssistantBlock::Thinking {
                text: "hidden reasoning".into(),
                metadata: None,
            },
            AssistantBlock::ToolCall {
                id: "tool".into(),
                name: "edit".into(),
                input: serde_json::json!({"path": "private.rs"}),
                metadata: None,
            },
            AssistantBlock::Text { text: text.into() },
        ],
        stop_reason: "end_turn".into(),
        usage: Default::default(),
        model: String::new(),
        provider: String::new(),
        timestamp: 0,
        error_message: None,
    }
}

fn compact(summary: &str) -> TranscriptItem {
    TranscriptItem::Compact {
        id: "compact".into(),
        created_at: 0,
        reason: CompactReason::Manual,
        summary: summary.into(),
        tokens_before: 100,
        tokens_after: 10,
        messages_before: 2,
        messages_after: 1,
        messages: vec![],
        engine_messages: vec![],
        state: Box::default(),
        details: CompactDetails::default(),
    }
}

fn meta(id: &str, date: &str) -> SessionMeta {
    let mut session = SessionMeta::new(id.into(), "/work/evot".into(), "model".into());
    session.updated_at = date.into();
    session.title = Some("A session".into());
    session
}

fn entries(items: Vec<TranscriptItem>) -> Vec<TranscriptEntry> {
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            TranscriptEntry::new("session".into(), None, index as u64 + 1, 0, item)
        })
        .collect()
}

#[test]
fn digest_uses_conversation_intent_and_outcome_not_tools() -> TestResult {
    let items = entries(vec![
        user("Investigate slow queries"),
        assistant("Found excessive scanning"),
        user("Can we reduce the cost?"),
        assistant("Added pruning and verified lower cost"),
    ]);
    let digest = SessionDigest::build(&meta("session", "2026-03-10T00:00:00Z"), &items)
        .ok_or("missing digest")?;
    let json = serde_json::to_string(&digest)?;
    assert_eq!(digest.project, "evot");
    assert_eq!(digest.messages.len(), 4);
    assert_eq!(digest.messages[2].text, "Can we reduce the cost?");
    assert!(json.contains("verified lower cost"));
    assert!(!json.contains("hidden reasoning"));
    assert!(!json.contains("private.rs"));
    assert_eq!(digest.omitted_messages, 0);
    Ok(())
}

#[test]
fn digest_uses_latest_nonempty_compact_and_subsequent_turns() -> TestResult {
    let items = entries(vec![
        user("Old raw request"), compact("## Goal\nSuperseded goal"),
        user("Before latest compact"),
        compact("## Goal\nInvestigate warehouse restarts\n## Files and Code Sections\nignored file list\n## Key Decisions\nMemory pressure confirmed\n## Current Work\nValidate warehouse sizing"),
        user("Try a larger warehouse"), assistant("Restart rate dropped"), compact("   "),
        user("How about next week?"),
    ]);
    let digest = SessionDigest::build(&meta("session", "2026-03-10T00:00:00Z"), &items)
        .ok_or("missing digest")?;
    let json = serde_json::to_string(&digest)?;
    assert!(json.contains("Investigate warehouse restarts"));
    assert!(json.contains("Memory pressure confirmed"));
    assert!(json.contains("Restart rate dropped"));
    assert!(json.contains("How about next week?"));
    assert!(!json.contains("Superseded"));
    assert!(!json.contains("Old raw request"));
    assert!(!json.contains("Before latest compact"));
    assert!(!json.contains("ignored file list"));
    Ok(())
}

#[test]
fn digest_falls_back_for_unknown_summary_format_and_empty_prune() -> TestResult {
    let session = meta("session", "2026-03-10T00:00:00Z");
    let unknown = SessionDigest::build(
        &session,
        &entries(vec![
            user("Request"),
            compact("Unstructured summary: compared database plans"),
        ]),
    )
    .ok_or("missing")?;
    assert!(unknown
        .compact
        .as_deref()
        .is_some_and(|text| text.contains("compared database plans")));
    let pruned = SessionDigest::build(
        &session,
        &entries(vec![user("Original intent"), compact(""), assistant("")]),
    )
    .ok_or("missing")?;
    assert!(pruned.compact.is_none());
    assert_eq!(pruned.messages.len(), 1);
    assert_eq!(pruned.messages[0].text, "Original intent");
    Ok(())
}

#[test]
fn digest_includes_compacts_retained_tail_without_synthetic_summary() -> TestResult {
    let mut item = compact("## Goal\nCompare warehouse sizes");
    if let TranscriptItem::Compact { messages, .. } = &mut item {
        *messages = vec![
            user(&evot::compact::context_view::compact_summary_text(
                "Synthetic marker",
            )),
            user("Retained request not covered by summary"),
            assistant("Retained answer"),
        ];
    }
    let digest = SessionDigest::build(
        &meta("session", "2026-03-10T00:00:00Z"),
        &entries(vec![
            user("Original request"),
            item,
            user("New request"),
            assistant("New answer"),
        ]),
    )
    .ok_or("missing digest")?;
    assert_eq!(digest.messages.len(), 4);
    assert_eq!(
        digest.messages[0].text,
        "Retained request not covered by summary"
    );
    assert_eq!(digest.messages[2].text, "New request");
    assert!(!serde_json::to_string(&digest)?.contains("Synthetic marker"));
    Ok(())
}

#[test]
fn digest_skips_synthetic_users_and_sessions_without_real_requests() {
    let session = meta("session", "2026-03-10T00:00:00Z");
    let synthetic = evot::compact::context_view::compact_summary_text("Synthetic summary");
    assert!(SessionDigest::build(
        &session,
        &entries(vec![user(&synthetic), assistant("Reply")])
    )
    .is_none());
    assert!(SessionDigest::build(&session, &[]).is_none());
}

#[test]
fn digest_bounds_long_unicode_messages_preserving_intent_and_final_outcome() -> TestResult {
    let session = meta("session", "2026-03-10T00:00:00Z");
    let mut items = vec![user(&format!(
        "First intent {} first ending",
        "中".repeat(2_000)
    ))];
    for index in 0..40 {
        items.push(user(&format!("Middle {index} {}", "文".repeat(500))));
        items.push(assistant(&format!("Progress {index} {}", "字".repeat(500))));
    }
    items.push(user("Last request"));
    items.push(assistant("Final verified outcome"));
    let digest = SessionDigest::build(&session, &entries(items)).ok_or("missing")?;
    assert!(serde_json::to_string(&digest)?.chars().count() <= 3_000);
    assert!(digest.omitted_messages > 0);
    assert!(digest.messages[0].text.contains("First intent"));
    assert!(digest.messages[0].text.contains("first ending"));
    assert!(digest.messages[0].text.contains("[truncated]"));
    assert_eq!(
        digest.messages.last().ok_or("missing final reply")?.text,
        "Final verified outcome"
    );
    assert!(digest
        .messages
        .iter()
        .any(|message| message.text == "Last request"));
    Ok(())
}

async fn save(
    storage: &dyn Storage,
    session: SessionMeta,
    items: Vec<TranscriptItem>,
) -> TestResult {
    let id = session.session_id.clone();
    storage.save_session(session).await?;
    let mut items = entries(items);
    for entry in &mut items {
        entry.session_id = id.clone();
    }
    if !items.is_empty() {
        storage.append_entries(items).await?;
    }
    Ok(())
}

#[tokio::test]
async fn sessions_command_loads_builtin_and_prepares_evidence_in_one_turn() -> TestResult {
    use std::sync::Arc;

    use evot::agent::Agent;
    use evot::agent::QueryRequest;
    use evot::agent::SubmitOutcome;
    use evot::conf::Config;
    use evot::conf::Protocol;
    use evot::conf::ProviderProfile;
    use evot_engine::provider::MockProvider;

    let tmp = tempfile::tempdir()?;
    let mut config = Config::new(tmp.path().into());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["test-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: Some(128_000),
        max_tokens: Some(4_096),
        supports_image: None,
    });
    config.llm.provider = "test".into();
    let storage = Arc::new(MemoryStorage::new());
    let past_id = "018f0000-0000-7000-8000-000000000001";
    save(
        storage.as_ref(),
        meta(past_id, "2026-03-09T00:00:00Z"),
        vec![
            user("Investigate warehouse restarts"),
            compact("## Goal\nDiagnose warehouse memory pressure"),
            assistant("Confirmed insufficient memory"),
        ],
    )
    .await?;
    let agent = Agent::new_with_provider_for_test(&config, tmp.path().to_string_lossy(), storage,
        MockProvider::text(format!("Found a relevant session.\n- {past_id} — Memory pressure — 2026-03-09 — Diagnosed warehouse restarts")))?;
    let current = agent.create_session("test").await?;
    let session = agent
        .load_session(&current.session_id)
        .await?
        .ok_or("missing session")?;
    let outcome = agent
        .submit_to_session(
            QueryRequest::text("/sessions --all why nodes crash"),
            session,
        )
        .await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(format!("unexpected command: {message}").into())
        }
    };
    while run.next().await.is_some() {}
    let transcript = agent.sessions().transcript(&current.session_id).await?;
    let prompt = transcript
        .iter()
        .find_map(|item| match item {
            TranscriptItem::User { text, .. } => Some(text),
            _ => None,
        })
        .ok_or("missing prepared prompt")?;
    assert!(prompt.contains("# Session search"));
    assert!(prompt.contains("why nodes crash"));
    assert!(prompt.contains("Diagnose warehouse memory pressure"));
    assert!(prompt.contains("Confirmed insufficient memory"));
    assert!(prompt.contains("\"included\":1"));
    assert!(prompt.contains(past_id));
    assert!(!transcript
        .iter()
        .any(|item| matches!(item, TranscriptItem::ToolResult { .. })));
    Ok(())
}

fn now() -> Result<DateTime<Utc>, chrono::ParseError> {
    Ok(DateTime::parse_from_rfc3339("2026-03-10T00:00:00Z")?.with_timezone(&Utc))
}

#[tokio::test]
async fn candidates_filter_window_automation_current_and_empty_not_keywords() -> TestResult {
    let storage = MemoryStorage::new();
    save(&storage, meta("recent", "2026-03-09T00:00:00Z"), vec![
        user("Totally different wording"),
    ])
    .await?;
    save(&storage, meta("boundary", "2026-03-03T00:00:00Z"), vec![
        user("Other project"),
    ])
    .await?;
    save(&storage, meta("old", "2026-03-02T00:00:00Z"), vec![user(
        "query keyword",
    )])
    .await?;
    save(&storage, meta("current", "2026-03-09T00:00:00Z"), vec![
        user("Current query"),
    ])
    .await?;
    save(&storage, meta("empty", "2026-03-09T00:00:00Z"), vec![]).await?;
    save(
        &storage,
        meta("automated", "2026-03-09T00:00:00Z").with_source("automation"),
        vec![user("Background task")],
    )
    .await?;
    let search = SessionSearch {
        query: "query keyword".into(),
        window_days: Some(7),
    };
    let candidates =
        SessionCandidates::collect(&storage, &search, now()?, "current", 100_000).await?;
    assert_eq!(candidates.sessions_in_window, 3);
    assert_eq!(candidates.excluded_empty, 1);
    assert_eq!(candidates.included, 2);
    assert_eq!(candidates.sessions[0].session_id, "recent");
    assert_eq!(candidates.sessions[1].session_id, "boundary");
    assert_eq!(candidates.not_included, 0);
    let all = SessionSearch {
        window_days: None,
        ..search
    };
    assert_eq!(
        SessionCandidates::collect(&storage, &all, now()?, "current", 100_000)
            .await?
            .included,
        3
    );
    Ok(())
}

#[tokio::test]
async fn candidates_budget_reports_partial_coverage_without_dropping_recent_for_old() -> TestResult
{
    let storage = MemoryStorage::new();
    for (id, date) in [
        ("recent", "2026-03-09T00:00:00Z"),
        ("older", "2026-03-08T00:00:00Z"),
        ("oldest", "2026-03-07T00:00:00Z"),
    ] {
        save(&storage, meta(id, date), vec![
            user(&"中".repeat(400)),
            assistant(&"文".repeat(400)),
        ])
        .await?;
    }
    let search = SessionSearch {
        query: "semantic intent".into(),
        window_days: None,
    };
    let candidates =
        SessionCandidates::collect(&storage, &search, now()?, "current", 1_900).await?;
    assert_eq!(candidates.included, 1);
    assert_eq!(candidates.not_included, 2);
    assert_eq!(candidates.sessions[0].session_id, "recent");
    assert_eq!(
        candidates.oldest_included.as_deref(),
        Some("2026-03-09T00:00:00Z")
    );
    assert_eq!(candidates.newest_included, candidates.oldest_included);
    let none = SessionCandidates::collect(&storage, &search, now()?, "current", 0).await?;
    assert_eq!(none.included, 0);
    assert_eq!(none.not_included, 3);
    assert!(none.oldest_included.is_none());
    Ok(())
}

#[tokio::test]
async fn candidates_report_corrupt_transcripts_without_failing_other_sessions() -> TestResult {
    use evot::storage::fs::FsStorage;
    let root = tempfile::tempdir()?;
    let storage = FsStorage::new(root.path().into());
    let healthy = "018f0000-0000-7000-8000-000000000001";
    let corrupt = "018f0000-0000-7000-8000-000000000002";
    save(&storage, meta(healthy, "2026-03-09T00:00:00Z"), vec![user(
        "Healthy session",
    )])
    .await?;
    save(&storage, meta(corrupt, "2026-03-09T00:00:00Z"), vec![user(
        "Corrupt session",
    )])
    .await?;
    std::fs::write(
        root.path()
            .join("sessions")
            .join(corrupt)
            .join("transcript.jsonl"),
        b"corrupt data\n",
    )?;
    let search = SessionSearch {
        query: "a topic".into(),
        window_days: None,
    };
    let candidates =
        SessionCandidates::collect(&storage, &search, now()?, "current", 100_000).await?;
    assert_eq!(candidates.included, 1);
    assert_eq!(candidates.unreadable, 1);
    assert_eq!(candidates.not_included, 0);
    assert_eq!(candidates.sessions[0].session_id, healthy);
    Ok(())
}

#[tokio::test]
async fn candidates_reject_overflowing_time_windows() -> TestResult {
    let search = SessionSearch {
        query: "a topic".into(),
        window_days: Some(u32::MAX),
    };
    let error =
        SessionCandidates::collect(&MemoryStorage::new(), &search, now()?, "current", 100_000)
            .await
            .err()
            .ok_or("expected an invalid window error")?;
    assert!(error.to_string().contains("window is too large"));
    Ok(())
}

#[tokio::test]
async fn candidates_character_budget_and_skill_prompt_contract() -> TestResult {
    let storage = MemoryStorage::new();
    for index in 0..60 {
        save(
            &storage,
            meta(&format!("session-{index:03}"), "2026-03-09T00:00:00Z"),
            (0..20).map(|_| user(&"x".repeat(400))).collect(),
        )
        .await?;
    }
    let search = SessionSearch {
        query: "a query\nwith \"quotes\"".into(),
        window_days: None,
    };
    let candidates =
        SessionCandidates::collect(&storage, &search, now()?, "current", 100_000).await?;
    assert!(candidates.not_included > 0);
    assert!(serde_json::to_string(&candidates)?.chars().count() <= 100_000);
    let skill = load_skill(&[] as &[std::path::PathBuf], "session-search")?;
    let instructions = load_skill_instructions(&skill)?;
    assert!(instructions.contains("Do not call tools"));
    assert!(instructions.contains("untrusted historical data"));
    assert!(instructions.contains("- <session_id> — <title> — <updated_at date>"));
    let prompt = candidates.prompt(&search.query, &instructions)?;
    assert!(prompt.contains("`session-search` skill is already loaded"));
    assert!(prompt.contains(&serde_json::to_string(&search.query)?));
    assert!(prompt.contains("\"not_included\":"));
    assert!(!prompt.contains("grep"));
    Ok(())
}
