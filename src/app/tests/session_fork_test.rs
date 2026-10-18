use std::sync::Arc;

use evot::conf::StorageConfig;
use evot::observability::UsageSummary;
use evot::sessions::Session;
use evot::sessions::SessionQueries;
use evot::sessions::SessionService;
use evot::storage::open_storage;
use evot::storage::MemoryStorage;
use evot::storage::Storage;
use evot::types::AssistantBlock;
use evot::types::CompactReason;
use evot::types::SessionMeta;
use evot::types::TranscriptItem;
use serde::Deserialize;
use tempfile::TempDir;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;
const LEGACY: &str = include_str!("fixtures/schema/session-meta-v0.json");

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

async fn seeded_session(storage: Arc<dyn Storage>, id: &str) -> TestResult {
    let session = Session::new_with_provider_source(
        id.into(),
        "/work".into(),
        "provider-a".into(),
        "model-a".into(),
        "repl",
        storage,
    )
    .await?;
    session
        .write_items(vec![user("read the code"), assistant("done reading")])
        .await?;
    session.increment_turn().await;
    session.save().await?;
    Ok(())
}

async fn fork_contract(storage: Arc<dyn Storage>) -> TestResult {
    seeded_session(storage.clone(), "root").await?;
    let service = SessionService::new(storage.clone(), "/work".into());
    let before = storage.get_session("root").await?.ok_or("root missing")?;

    let fork = service.fork("root", Some("  抽 Storage trait ")).await?;
    assert_ne!(fork.session_id, "root");
    assert_eq!(fork.parent_session_id.as_deref(), Some("root"));
    assert_eq!(fork.fork_seq, Some(2));
    assert_eq!(fork.custom_title.as_deref(), Some("抽 Storage trait"));
    assert_eq!(fork.title, before.title);
    assert_eq!(fork.provider, "provider-a");
    assert_eq!(fork.model, "model-a");
    assert_eq!(fork.cwd, "/work");
    assert_eq!(fork.source, "repl");
    assert_eq!(fork.turns, before.turns);
    assert_eq!(fork.total_input_tokens, 0);

    // The fork sees the same conversation; the source is untouched.
    let queries = SessionQueries::new(storage.clone());
    let forked_items = queries.transcript(&fork.session_id).await?;
    let root_items = queries.transcript("root").await?;
    assert_eq!(forked_items.len(), root_items.len());
    assert_eq!(
        forked_items.first().and_then(|i| i.as_user_text()),
        Some("read the code".into())
    );
    let after = storage.get_session("root").await?.ok_or("root missing")?;
    assert_eq!(after.updated_at, before.updated_at);
    assert!(after.parent_session_id.is_none());

    // The fork is a regular session: it can be reopened and continued.
    let reopened = Session::open(&fork.session_id, storage.clone())
        .await?
        .ok_or("fork missing")?;
    assert_eq!(reopened.transcript().await.len(), 2);
    reopened.write_items(vec![user("only in fork")]).await?;
    assert_eq!(queries.transcript("root").await?.len(), 2);
    assert_eq!(queries.transcript(&fork.session_id).await?.len(), 3);

    // A fork without a title keeps the automatic title only.
    let untitled = service.fork("root", Some("   ")).await?;
    assert!(untitled.custom_title.is_none());
    assert_eq!(untitled.title, before.title);

    assert!(service.fork("missing", None).await.is_err());
    assert!(service.fork("root", Some("bad\nname")).await.is_err());
    Ok(())
}

#[tokio::test]
async fn fork_memory_contract() -> TestResult {
    fork_contract(Arc::new(MemoryStorage::new())).await
}

#[tokio::test]
async fn fork_fs_contract() -> TestResult {
    let dir = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(dir.path().to_path_buf()))?;
    fork_contract(storage).await
}

#[tokio::test]
async fn fork_copies_only_the_active_branch_after_compaction() -> TestResult {
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "compacted".into(),
        "/work".into(),
        "m".into(),
        storage.clone(),
    )
    .await?;
    session
        .write_items(vec![user("old"), assistant("old reply")])
        .await?;
    let summary_item = evot::compact::context_view::compact_summary_item("summary of old");
    let (_, _, expected_seq) = session.context_snapshot().await;
    let item = TranscriptItem::Compact {
        id: "c1".into(),
        created_at: 0,
        reason: CompactReason::Threshold,
        summary: "summary of old".into(),
        tokens_before: 100,
        tokens_after: 10,
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
    session.write_items(vec![user("after compact")]).await?;

    let service = SessionService::new(storage.clone(), "/work".into());
    let fork = service.fork("compacted", None).await?;
    // Compact point + one entry after it, renumbered from 1.
    let entries = storage.load_active_entries(&fork.session_id).await?;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].seq, 1);
    assert!(matches!(entries[0].item, TranscriptItem::Compact { .. }));
    assert_eq!(entries[1].item.as_user_text(), Some("after compact".into()));
    assert!(entries.iter().all(|e| e.session_id == fork.session_id));
    assert!(entries.iter().all(|e| e.run_id.is_none()));
    assert_eq!(fork.fork_seq, Some(4));

    let reopened = Session::open(&fork.session_id, storage)
        .await?
        .ok_or("fork missing")?;
    assert_eq!(reopened.transcript().await.len(), 2);
    Ok(())
}

#[tokio::test]
async fn lineage_walks_parents_and_stops_at_deleted_or_cyclic_links() -> TestResult {
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    seeded_session(storage.clone(), "root").await?;
    let service = SessionService::new(storage.clone(), "/work".into());
    let child = service.fork("root", Some("child")).await?;
    let grandchild = service.fork(&child.session_id, Some("grandchild")).await?;

    let queries = SessionQueries::new(storage.clone());
    let chain = queries.lineage(&grandchild.session_id).await?;
    let ids: Vec<&str> = chain.iter().map(|m| m.session_id.as_str()).collect();
    assert_eq!(ids, vec![
        "root",
        child.session_id.as_str(),
        grandchild.session_id.as_str()
    ]);
    assert_eq!(queries.lineage("root").await?.len(), 1);
    assert!(queries.lineage("missing").await?.is_empty());

    // Deleting the middle node makes the grandchild a root.
    storage.delete_session(&child.session_id).await?;
    let chain = queries.lineage(&grandchild.session_id).await?;
    assert_eq!(chain.len(), 1);
    assert_eq!(chain[0].session_id, grandchild.session_id);

    // Corrupted self-referencing link terminates.
    let mut looped = SessionMeta::new("loop".into(), "/work".into(), "m".into());
    looped.parent_session_id = Some("loop".into());
    storage.save_session(looped).await?;
    assert_eq!(queries.lineage("loop").await?.len(), 1);
    Ok(())
}

/// The metadata shape required by readers released before fork existed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySessionMeta {
    #[serde(default)]
    schema_version: u32,
    session_id: String,
    cwd: String,
    model: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    thinking_level: Option<String>,
    title: Option<String>,
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    source: String,
    turns: u32,
    #[serde(default)]
    message_count: u32,
    #[serde(default)]
    context_tokens: usize,
    #[serde(default)]
    context_budget: usize,
    #[serde(default)]
    total_input_tokens: u64,
    #[serde(default)]
    total_output_tokens: u64,
    #[serde(default)]
    span_count: Option<u32>,
    created_at: String,
    updated_at: String,
}

#[test]
fn fork_fields_are_backward_compatible() -> TestResult {
    // Old data → current reader: missing fields read as root.
    let legacy: SessionMeta = serde_json::from_str(LEGACY)?;
    assert!(legacy.parent_session_id.is_none());
    assert!(legacy.fork_seq.is_none());

    // Current writer (root) → strict legacy reader: no new keys leak.
    let root = serde_json::to_string(&legacy)?;
    let parsed: LegacySessionMeta = serde_json::from_str(&root)?;
    assert_eq!(parsed.session_id, legacy.session_id);
    assert_eq!(parsed.turns, 2);
    let _ = (
        parsed.schema_version,
        parsed.cwd,
        parsed.model,
        parsed.provider,
        parsed.thinking_level,
        parsed.title,
        parsed.custom_title,
        parsed.source,
        parsed.message_count,
        parsed.context_tokens,
        parsed.context_budget,
        parsed.total_input_tokens,
        parsed.total_output_tokens,
        parsed.span_count,
        parsed.created_at,
        parsed.updated_at,
    );

    // Forked meta round-trips through JSON with the new fields intact.
    let mut fork = legacy.clone();
    fork.session_id = "fork".into();
    fork.parent_session_id = Some(legacy.session_id.clone());
    fork.fork_seq = Some(7);
    let json = serde_json::to_string(&fork)?;
    let value: serde_json::Value = serde_json::from_str(&json)?;
    assert_eq!(value["parent_session_id"], legacy.session_id);
    assert_eq!(value["fork_seq"], 7);
    let back: SessionMeta = serde_json::from_str(&json)?;
    assert_eq!(back.parent_session_id, fork.parent_session_id);
    assert_eq!(back.fork_seq, Some(7));
    Ok(())
}
