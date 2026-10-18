use chrono::DateTime;
use chrono::Utc;
use evot::agent::prompt::skill::load_skill;
use evot::agent::prompt::skill::load_skill_instructions;
use evot::search::SessionDigest;
use evot::search::SessionSearchTool;
use evot::search::MAX_CALLS_PER_RUN;
use evot::search::PAGE_CHARS;
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
        provenance: None,
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

fn now() -> Result<DateTime<Utc>, chrono::ParseError> {
    Ok(DateTime::parse_from_rfc3339("2026-03-10T00:00:00Z")?.with_timezone(&Utc))
}

fn cancel() -> tokio_util::sync::CancellationToken {
    tokio_util::sync::CancellationToken::new()
}

fn test_config(root: &std::path::Path) -> evot::conf::Config {
    use evot::conf::Config;
    use evot::conf::Protocol;
    use evot::conf::ProviderProfile;
    let mut config = Config::new(root.into());
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
    config
}

#[tokio::test]
async fn sessions_command_attaches_the_tool_and_the_model_drives_the_scan() -> TestResult {
    use std::sync::Arc;

    use evot::agent::Agent;
    use evot::agent::QueryRequest;
    use evot::agent::SubmitOutcome;
    use evot_engine::provider::MockProvider;
    use evot_engine::provider::MockResponse;
    use evot_engine::provider::MockToolCall;

    let tmp = tempfile::tempdir()?;
    let config = test_config(tmp.path());
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
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "session_search".into(),
            arguments: serde_json::json!({
                "keywords": ["warehouse", "restart"],
            }),
        }]),
        MockResponse::Text(format!(
            "Found a relevant session.\n- {past_id} — Memory pressure — 2026-03-09 — Diagnosed warehouse restarts"
        )),
    ]);
    let agent = Agent::new_with_provider_for_test(
        &config,
        tmp.path().to_string_lossy(),
        storage,
        provider,
    )?;
    let current = agent.create_session("test").await?;
    let session = agent
        .load_session(&current.session_id)
        .await?
        .ok_or("missing session")?;
    let outcome = agent
        .submit_to_session(
            QueryRequest::text("/sessions 最近半个月 warehouse 为什么重启"),
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
    // The prompt carries instructions and the raw request, not evidence.
    assert!(prompt.contains("# Session search"));
    assert!(prompt.contains("最近半个月 warehouse 为什么重启"));
    assert!(prompt.contains("Current UTC time:"));
    assert!(!prompt.contains("Diagnose warehouse memory pressure"));
    // Evidence arrives through the tool the model called.
    let tool_result = transcript
        .iter()
        .find_map(|item| match item {
            TranscriptItem::ToolResult { content, .. } => Some(content),
            _ => None,
        })
        .ok_or("model should have called session_search")?;
    assert!(tool_result.contains("Diagnose warehouse memory pressure"));
    assert!(tool_result.contains("Confirmed insufficient memory"));
    assert!(tool_result.contains("\"since_days\":null"));
    assert!(tool_result.contains("\"matched_keywords\":[\"warehouse\",\"restart\"]"));
    assert!(tool_result.contains(past_id));
    Ok(())
}

#[tokio::test]
async fn ordinary_turns_do_not_expose_session_search() -> TestResult {
    use std::sync::Arc;

    use evot::agent::Agent;
    use evot::agent::QueryRequest;
    use evot::agent::SubmitOutcome;
    use evot_engine::provider::MockProvider;
    use evot_engine::provider::MockResponse;
    use evot_engine::provider::MockToolCall;

    let tmp = tempfile::tempdir()?;
    let config = test_config(tmp.path());
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "session_search".into(),
            arguments: serde_json::json!({}),
        }]),
        MockResponse::Text("done".into()),
    ]);
    let agent = Agent::new_with_provider_for_test(
        &config,
        tmp.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        provider,
    )?;
    let current = agent.create_session("test").await?;
    let session = agent
        .load_session(&current.session_id)
        .await?
        .ok_or("missing session")?;
    let outcome = agent
        .submit_to_session(QueryRequest::text("hello"), session)
        .await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(format!("unexpected command: {message}").into())
        }
    };
    while run.next().await.is_some() {}
    let transcript = agent.sessions().transcript(&current.session_id).await?;
    let tool_result = transcript
        .iter()
        .find_map(|item| match item {
            TranscriptItem::ToolResult { content, .. } => Some(content),
            _ => None,
        })
        .ok_or("the unknown tool call should still produce a result")?;
    assert!(
        tool_result.to_lowercase().contains("not found"),
        "{tool_result}"
    );
    Ok(())
}

#[tokio::test]
async fn page_filters_window_automation_current_and_empty_without_keywords() -> TestResult {
    let storage = std::sync::Arc::new(MemoryStorage::new());
    save(
        storage.as_ref(),
        meta("recent", "2026-03-09T00:00:00Z"),
        vec![user("Totally different wording")],
    )
    .await?;
    save(
        storage.as_ref(),
        meta("boundary", "2026-03-03T00:00:00Z"),
        vec![user("Other project")],
    )
    .await?;
    save(storage.as_ref(), meta("old", "2026-03-02T00:00:00Z"), vec![
        user("query keyword"),
    ])
    .await?;
    save(
        storage.as_ref(),
        meta("current", "2026-03-09T00:00:00Z"),
        vec![user("Current query")],
    )
    .await?;
    save(
        storage.as_ref(),
        meta("empty", "2026-03-09T00:00:00Z"),
        vec![],
    )
    .await?;
    save(
        storage.as_ref(),
        meta("automated", "2026-03-09T00:00:00Z").with_source("automation"),
        vec![user("Background task")],
    )
    .await?;
    let tool = SessionSearchTool::new(storage, "current");
    let page = tool.page(Some(7), &[], 0, 20, now()?, &cancel()).await?;
    assert_eq!(page.sessions_in_window, 3);
    assert_eq!(page.excluded_empty, 1);
    assert_eq!(page.returned, 2);
    assert_eq!(page.remaining, 0);
    assert!(page.next_cursor.is_none());
    assert_eq!(page.sessions[0].digest.session_id, "recent");
    assert_eq!(page.sessions[1].digest.session_id, "boundary");
    assert_eq!(
        page.oldest_in_window.as_deref(),
        Some("2026-03-03T00:00:00Z")
    );
    assert_eq!(
        page.newest_in_window.as_deref(),
        Some("2026-03-09T00:00:00Z")
    );
    let all = tool.page(None, &[], 0, 20, now()?, &cancel()).await?;
    assert_eq!(all.returned, 3);
    assert_eq!(all.sessions[2].digest.session_id, "old");
    Ok(())
}

#[tokio::test]
async fn page_ranks_keyword_hits_first_then_newest_without_filtering() -> TestResult {
    let storage = std::sync::Arc::new(MemoryStorage::new());
    save(
        storage.as_ref(),
        meta("newest-miss", "2026-03-09T00:00:00Z"),
        vec![user("Unrelated work")],
    )
    .await?;
    save(
        storage.as_ref(),
        meta("title-hit", "2026-03-08T00:00:00Z"),
        vec![user("Set up the campaign")],
    )
    .await?;
    storage.rename_session("title-hit", "小红书 发帖").await?;
    save(
        storage.as_ref(),
        meta("double-hit", "2026-03-06T00:00:00Z"),
        vec![user("Post to XiaoHongShu"), assistant("Published on xhs")],
    )
    .await?;
    save(
        storage.as_ref(),
        meta("oldest-miss", "2026-03-05T00:00:00Z"),
        vec![user("Nothing here")],
    )
    .await?;
    let tool = SessionSearchTool::new(storage, "current");
    let keywords = vec![
        "小红书".to_string(),
        "xiaohongshu".into(),
        " XHS ".into(),
        "".into(),
    ];
    let page = tool.page(None, &keywords, 0, 20, now()?, &cancel()).await?;
    let ids: Vec<&str> = page
        .sessions
        .iter()
        .map(|item| item.digest.session_id.as_str())
        .collect();
    assert_eq!(ids, [
        "double-hit",
        "title-hit",
        "newest-miss",
        "oldest-miss"
    ]);
    assert_eq!(page.keyword_hits, 2);
    assert_eq!(page.keywords, ["小红书", "xiaohongshu", "xhs"]);
    assert_eq!(page.sessions[0].matched_keywords, ["xiaohongshu", "xhs"]);
    assert_eq!(page.sessions[1].matched_keywords, ["小红书"]);
    assert!(page.sessions[2].matched_keywords.is_empty());
    Ok(())
}

#[tokio::test]
async fn page_cursor_walks_the_ranked_list_in_bounded_chunks() -> TestResult {
    let storage = std::sync::Arc::new(MemoryStorage::new());
    for index in 0..7 {
        save(
            storage.as_ref(),
            meta(
                &format!("session-{index}"),
                &format!("2026-03-0{}T00:00:00Z", 9 - index),
            ),
            vec![user(&format!("Request {index}"))],
        )
        .await?;
    }
    let tool = SessionSearchTool::new(storage, "current");
    let first = tool.page(None, &[], 0, 3, now()?, &cancel()).await?;
    assert_eq!(first.returned, 3);
    assert_eq!(first.remaining, 4);
    assert_eq!(first.next_cursor, Some(3));
    assert_eq!(first.sessions[0].digest.session_id, "session-0");
    let second = tool.page(None, &[], 3, 3, now()?, &cancel()).await?;
    assert_eq!(second.sessions[0].digest.session_id, "session-3");
    assert_eq!(second.remaining, 1);
    assert_eq!(second.next_cursor, Some(6));
    let last = tool.page(None, &[], 6, 3, now()?, &cancel()).await?;
    assert_eq!(last.returned, 1);
    assert_eq!(last.remaining, 0);
    assert!(last.next_cursor.is_none());
    let past_end = tool.page(None, &[], 99, 3, now()?, &cancel()).await?;
    assert_eq!(past_end.returned, 0);
    assert_eq!(past_end.remaining, 0);
    Ok(())
}

#[tokio::test]
async fn page_size_is_bounded_by_characters_but_never_empty() -> TestResult {
    let storage = std::sync::Arc::new(MemoryStorage::new());
    for index in 0..60 {
        save(
            storage.as_ref(),
            meta(&format!("session-{index:03}"), "2026-03-09T00:00:00Z"),
            (0..20).map(|_| user(&"中".repeat(400))).collect(),
        )
        .await?;
    }
    let tool = SessionSearchTool::new(storage, "current");
    let page = tool.page(None, &[], 0, 40, now()?, &cancel()).await?;
    assert!(page.returned > 0);
    assert!(page.returned < 40);
    assert_eq!(page.returned + page.remaining, 60);
    assert!(serde_json::to_string(&page)?.chars().count() <= PAGE_CHARS + 1_000);
    Ok(())
}

#[tokio::test]
async fn page_reports_corrupt_transcripts_without_failing_other_sessions() -> TestResult {
    use evot::storage::fs::FsStorage;
    let root = tempfile::tempdir()?;
    let storage = std::sync::Arc::new(FsStorage::new(root.path().into()));
    let healthy = "018f0000-0000-7000-8000-000000000001";
    let corrupt = "018f0000-0000-7000-8000-000000000002";
    save(
        storage.as_ref(),
        meta(healthy, "2026-03-09T00:00:00Z"),
        vec![user("Healthy session")],
    )
    .await?;
    save(
        storage.as_ref(),
        meta(corrupt, "2026-03-09T00:00:00Z"),
        vec![user("Corrupt session")],
    )
    .await?;
    std::fs::write(
        root.path()
            .join("sessions")
            .join(corrupt)
            .join("transcript.jsonl"),
        b"corrupt data\n",
    )?;
    let tool = SessionSearchTool::new(storage, "current");
    let page = tool.page(None, &[], 0, 20, now()?, &cancel()).await?;
    assert_eq!(page.returned, 1);
    assert_eq!(page.unreadable, 1);
    assert_eq!(page.sessions[0].digest.session_id, healthy);
    Ok(())
}

#[tokio::test]
async fn page_rejects_overflowing_time_windows() -> TestResult {
    let tool = SessionSearchTool::new(std::sync::Arc::new(MemoryStorage::new()), "current");
    let error = tool
        .page(Some(u32::MAX), &[], 0, 20, now()?, &cancel())
        .await
        .err()
        .ok_or("expected an invalid window error")?;
    assert!(error.to_string().contains("window is too large"));
    Ok(())
}

#[tokio::test]
async fn execute_validates_arguments_and_caps_calls_per_run() -> TestResult {
    use evot_engine::AgentTool;
    let storage = std::sync::Arc::new(MemoryStorage::new());
    save(storage.as_ref(), meta("one", "2026-03-09T00:00:00Z"), vec![
        user("Something"),
    ])
    .await?;
    let tool = SessionSearchTool::new(storage, "current");
    let ctx = || evot_engine::ToolContext {
        tool_call_id: "call".into(),
        tool_name: "session_search".into(),
        cancel: cancel(),
        on_update: None,
        on_progress: None,
        cwd: std::env::temp_dir(),
        path_guard: std::sync::Arc::new(evot_engine::PathGuard::open()),
        spill: None,
        supports_image: true,
    };
    let bad = tool
        .execute(serde_json::json!({"since_days": "two weeks"}), ctx())
        .await;
    assert!(matches!(bad, Err(evot_engine::ToolError::InvalidArgs(_))));
    for _ in 0..MAX_CALLS_PER_RUN {
        let result = tool.execute(serde_json::json!({}), ctx()).await?;
        assert_eq!(result.retention, evot_engine::Retention::CurrentRun);
        assert_eq!(result.details["returned"], 1);
    }
    let over = tool.execute(serde_json::json!({}), ctx()).await;
    assert!(
        matches!(over, Err(evot_engine::ToolError::Failed(message)) if message.contains("already called"))
    );
    Ok(())
}

#[test]
fn skill_prompt_contract_describes_tool_driven_search() -> TestResult {
    let skill = load_skill(&[] as &[std::path::PathBuf], "session-search")?;
    let instructions = load_skill_instructions(&skill)?;
    assert!(instructions.contains("`session_search` tool"));
    assert!(instructions.contains("since_days"));
    assert!(instructions.contains("next_cursor"));
    assert!(instructions.contains("untrusted historical data"));
    assert!(instructions.contains("- <session_id> — <title> — <updated_at date>"));
    assert!(!instructions.contains("--days"));
    Ok(())
}
