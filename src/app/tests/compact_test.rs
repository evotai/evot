use evot::compact::context_view::resolve_context_items;
use evot::compact::orchestrator::compact_session;
use evot::compact::orchestrator::CompactSettings;
use evot::compact::orchestrator::ManualCompactRequest;
use evot::conf::StorageConfig;
use evot::observability::UsageSummary;
use evot::sessions::Session;
use evot::storage::open_storage;
use evot::types::AssistantBlock;
use evot::types::CompactReason;
use evot::types::TranscriptItem;
use tempfile::TempDir;

const KEEP_RECENT_TOKENS: usize = 1;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn compact_session_persists_structured_item_with_summary_override() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-compact-orchestrator".into(),
        "/tmp".into(),
        "m".into(),
        storage,
    )
    .await?;

    session
        .write_items(vec![
            user("old one with enough text to summarize"),
            assistant("old assistant response"),
            user("recent request"),
            assistant("recent answer"),
        ])
        .await?;

    let compact = compact_session(
        &session,
        ManualCompactRequest {
            reason: CompactReason::Threshold,
            custom_instructions: None,
            summary_override: Some("LLM supplied summary".into()),
            summarizer: None,
            observer: None,
            settings: CompactSettings {
                keep_recent_tokens: KEEP_RECENT_TOKENS,
                context_window: 0,
            },
        },
        tokio_util::sync::CancellationToken::new(),
    )
    .await?
    .ok_or_else(|| std::io::Error::other("expected compaction"))?;

    let TranscriptItem::Compact {
        summary, reason, ..
    } = compact
    else {
        return Err(std::io::Error::other("expected compact item").into());
    };

    assert!(summary.starts_with("LLM supplied summary"));
    assert!(summary.contains("**Turn Context (split turn):**"));
    assert!(summary.contains("recent request"));
    assert_eq!(reason, CompactReason::Threshold);

    let raw = session.load_all_entries().await?;
    assert!(matches!(
        raw.last().map(|e| &e.item),
        Some(TranscriptItem::Compact { .. })
    ));

    let context = session.transcript().await;
    assert!(matches!(
        &context[0],
        TranscriptItem::User { text, .. }
            if text.contains("LLM supplied summary") && text.contains("recent request")
    ));
    assert!(context.iter().any(|item| matches!(
        item,
        TranscriptItem::Assistant { content, .. }
            if evot::types::assistant_text(content) == "recent answer"
    )));
    assert!(!context
        .iter()
        .any(|item| matches!(item, TranscriptItem::User { text, .. } if text == "recent request")));
    assert!(!context.iter().any(
        |item| matches!(item, TranscriptItem::User { text, .. } if text.starts_with("old one"))
    ));

    Ok(())
}

#[tokio::test]
async fn compact_context_view_preserves_full_generated_summary() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-legacy-large-summary".into(),
        "/tmp".into(),
        "m".into(),
        storage.clone(),
    )
    .await?;
    let oversized = format!("overview {} latest critical conclusion", "x".repeat(32_000));
    session
        .write_items(vec![user("old"), assistant("old reply")])
        .await?;
    let summary_item = evot::compact::context_view::compact_summary_item(&oversized);
    let (_, _, expected_seq) = session.context_snapshot().await;
    let item = TranscriptItem::Compact {
        id: "large".into(),
        created_at: 0,
        reason: CompactReason::Threshold,
        summary: oversized.clone(),
        tokens_before: 100,
        tokens_after: 50,
        messages_before: 2,
        messages_after: 1,
        messages: vec![summary_item.clone()],
        engine_messages: evot::conversation::convert::into_agent_messages(std::slice::from_ref(
            &summary_item,
        )),
        state: Box::default(),
        details: Default::default(),
    };
    session
        .write_compact(item, vec![summary_item], expected_seq)
        .await?;

    let session_id = session.session_id().await;
    drop(session);
    let reopened = Session::open(&session_id, storage)
        .await?
        .ok_or_else(|| std::io::Error::other("expected reopened session"))?;
    let context = reopened.transcript().await;
    let summary = match context.first() {
        Some(TranscriptItem::User { text, .. }) => text,
        _ => return Err(std::io::Error::other("expected compact summary user item").into()),
    };
    assert!(summary.contains(&oversized));
    assert!(!summary.contains("compaction summary truncated"));
    assert!(summary.contains("latest critical conclusion"));
    Ok(())
}

#[tokio::test]
async fn compact_after_clear_does_not_inherit_previous_summary() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-compact-after-clear".into(),
        "/tmp".into(),
        "m".into(),
        storage,
    )
    .await?;

    session
        .write_items(vec![user("old request"), assistant("old response")])
        .await?;
    let old_summary =
        evot::compact::context_view::compact_summary_item("OLD BRANCH SUMMARY MUST NOT RETURN");
    let (_, _, expected_seq) = session.context_snapshot().await;
    session
        .write_compact(
            TranscriptItem::Compact {
                id: "old-compact".into(),
                created_at: 1,
                reason: CompactReason::Manual,
                summary: "OLD BRANCH SUMMARY MUST NOT RETURN".into(),
                tokens_before: 100,
                tokens_after: 10,
                messages_before: 2,
                messages_after: 1,
                messages: vec![old_summary.clone()],
                engine_messages: evot::conversation::convert::into_agent_messages(
                    std::slice::from_ref(&old_summary),
                ),
                state: Box::new(evot_engine::CompactionState {
                    generation: 1,
                    last_summary: Some("OLD BRANCH SUMMARY MUST NOT RETURN".into()),
                    context_summary_message: old_summary.as_user_text(),
                    ..Default::default()
                }),
                details: Default::default(),
            },
            vec![old_summary],
            expected_seq,
        )
        .await?;
    session.write_clear_marker().await?;
    session
        .write_items(vec![
            user("new branch request with enough content to summarize"),
            assistant("new branch response with enough content to summarize"),
            user("new retained request"),
            assistant("new retained response"),
        ])
        .await?;

    let compact = compact_session(
        &session,
        ManualCompactRequest {
            reason: CompactReason::Manual,
            custom_instructions: None,
            summary_override: None,
            summarizer: None,
            observer: None,
            settings: CompactSettings {
                keep_recent_tokens: KEEP_RECENT_TOKENS,
                context_window: 0,
            },
        },
        tokio_util::sync::CancellationToken::new(),
    )
    .await?
    .ok_or_else(|| std::io::Error::other("expected post-clear compaction"))?;

    let TranscriptItem::Compact { summary, .. } = compact else {
        return Err(std::io::Error::other("expected compact item").into());
    };
    assert!(!summary.contains("OLD BRANCH SUMMARY MUST NOT RETURN"));
    assert!(summary.contains("new branch request"));
    Ok(())
}

#[tokio::test]
async fn compact_context_view_uses_latest_compact_boundary() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    let session = Session::new(
        "sess-compact-boundary".into(),
        "/tmp".into(),
        "m".into(),
        storage,
    )
    .await?;

    session
        .write_items(vec![
            user("old"),
            assistant("old reply"),
            user("kept"),
            assistant("kept reply"),
        ])
        .await?;
    compact_session(
        &session,
        ManualCompactRequest {
            reason: CompactReason::Manual,
            custom_instructions: None,
            summary_override: Some("summary one".into()),
            summarizer: None,
            observer: None,
            settings: CompactSettings {
                keep_recent_tokens: KEEP_RECENT_TOKENS,
                context_window: 0,
            },
        },
        tokio_util::sync::CancellationToken::new(),
    )
    .await?;
    session.write_items(vec![user("after")]).await?;

    let entries = session.load_all_entries().await?;
    let context = resolve_context_items(&entries);

    assert!(matches!(
        &context[0],
        TranscriptItem::User { text, .. }
            if text.contains("summary one") && text.contains("kept")
    ));
    assert!(context.iter().any(|item| matches!(
        item,
        TranscriptItem::Assistant { content, .. }
            if evot::types::assistant_text(content) == "kept reply"
    )));
    assert!(!context
        .iter()
        .any(|item| matches!(item, TranscriptItem::User { text, .. } if text == "kept")));
    assert!(context
        .iter()
        .any(|item| matches!(item, TranscriptItem::User { text, .. } if text == "after")));
    assert!(!context
        .iter()
        .any(|item| matches!(item, TranscriptItem::User { text, .. } if text == "old")));

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
