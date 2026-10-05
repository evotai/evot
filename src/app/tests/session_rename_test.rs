use std::sync::Arc;

use evot::search::SessionWithText;
use evot::storage::fs::FsStorage;
use evot::storage::MemoryStorage;
use evot::storage::Storage;
use evot::types::ListSessions;
use evot::types::SessionMeta;

type TestResult = Result<(), Box<dyn std::error::Error>>;
const LEGACY: &str = include_str!("fixtures/schema/session-meta-v0.json");

async fn contract(storage: Arc<dyn Storage>) -> TestResult {
    let original: SessionMeta = serde_json::from_str(LEGACY)?;
    let id = original.session_id.clone();
    storage.save_session(original.clone()).await?;
    let renamed = storage.rename_session(&id, "  生产告警排查  ").await?;
    assert_eq!(renamed.custom_title.as_deref(), Some("生产告警排查"));
    assert_eq!(renamed.title, original.title);
    assert_eq!(renamed.updated_at, original.updated_at);
    assert_eq!(renamed.turns, original.turns);
    // An active Session can still hold metadata from before the rename.
    let mut stale = original.clone();
    stale.title = Some("New automatic title".into());
    stale.turns = 3;
    storage.save_session(stale).await?;
    let persisted = storage.get_session(&id).await?.ok_or("missing session")?;
    assert_eq!(persisted.custom_title.as_deref(), Some("生产告警排查"));
    assert_eq!(persisted.turns, 3);
    assert_eq!(persisted.title.as_deref(), Some("New automatic title"));
    assert!(SessionWithText::extract(persisted.clone(), &[])
        .search_text
        .contains("生产告警排查"));
    assert_eq!(
        storage.list_sessions(ListSessions::default()).await?[0].custom_title,
        persisted.custom_title
    );
    for title in ["", "  ", "bad\nname", "bad\x1bname"] {
        assert!(storage.rename_session(&id, title).await.is_err());
    }
    assert!(storage
        .rename_session(&id, &"中".repeat(121))
        .await
        .is_err());
    assert!(storage.rename_session("missing", "Name").await.is_err());
    storage.rename_session(&id, &"中".repeat(120)).await?;
    Ok(())
}

#[tokio::test]
async fn rename_memory_contract() -> TestResult {
    contract(Arc::new(MemoryStorage::new())).await
}

#[tokio::test]
async fn rename_fs_contract_and_restart() -> TestResult {
    let root = tempfile::tempdir()?;
    contract(Arc::new(FsStorage::new(root.path().into()))).await?;
    let reopened = FsStorage::new(root.path().into());
    let meta = reopened
        .get_session("018f0000-0000-7000-8000-000000000001")
        .await?
        .ok_or("missing")?;
    assert_eq!(meta.custom_title, Some("中".repeat(120)));
    assert_eq!(meta.schema_version, 1);
    assert!(reopened.rename_session("../escape", "Name").await.is_err());
    Ok(())
}

#[tokio::test]
async fn rename_survives_independent_writer_race() -> TestResult {
    let root = tempfile::tempdir()?;
    let a = Arc::new(FsStorage::new(root.path().into()));
    let b = Arc::new(FsStorage::new(root.path().into()));
    let original: SessionMeta = serde_json::from_str(LEGACY)?;
    a.save_session(original.clone()).await?;
    let writer = tokio::spawn(async move {
        for _ in 0..20 {
            b.save_session(original.clone()).await?;
        }
        evot::error::Result::Ok(())
    });
    a.rename_session("018f0000-0000-7000-8000-000000000001", "Pinned name")
        .await?;
    writer.await??;
    assert_eq!(
        a.get_session("018f0000-0000-7000-8000-000000000001")
            .await?
            .ok_or("missing")?
            .custom_title
            .as_deref(),
        Some("Pinned name")
    );
    Ok(())
}

#[test]
fn rename_schema_contract() -> TestResult {
    // Typed legacy reader requires the original wire fields, without defaults.
    #[derive(serde::Deserialize)]
    struct LegacySession {
        session_id: String,
        cwd: String,
        model: String,
        title: Option<String>,
        turns: u32,
        created_at: String,
        updated_at: String,
    }
    let mut current: SessionMeta = serde_json::from_str(LEGACY)?;
    assert_eq!(current.schema_version, 0);
    assert!(current.custom_title.is_none());
    current.schema_version = 1;
    current.custom_title = Some("User name".into());
    let written = serde_json::to_value(&current)?;
    let legacy: LegacySession = serde_json::from_value(written.clone())?;
    assert_eq!(legacy.session_id, current.session_id);
    assert_eq!(legacy.cwd, current.cwd);
    assert_eq!(legacy.model, current.model);
    assert_eq!(legacy.title, current.title);
    assert_eq!(legacy.turns, current.turns);
    assert_eq!(legacy.created_at, current.created_at);
    assert_eq!(legacy.updated_at, current.updated_at);
    let mut future = written;
    future["schema_version"] = serde_json::json!(2);
    let error = serde_json::from_value::<SessionMeta>(future)
        .err()
        .ok_or("future schema accepted")?;
    assert!(error.to_string().contains("unsupported session schema"));
    Ok(())
}

#[tokio::test]
async fn rename_survives_live_session_save_and_clear() -> TestResult {
    let root = tempfile::tempdir()?;
    let storage: Arc<dyn Storage> = Arc::new(FsStorage::new(root.path().into()));
    let id = "018f0000-0000-7000-8000-000000000001";
    let session =
        evot::sessions::Session::new(id.into(), "/work".into(), "test".into(), storage.clone())
            .await?;
    session
        .write_items(vec![evot::types::TranscriptItem::User {
            text: "Original task".into(),
            content: vec![],
        }])
        .await?;
    storage.rename_session(id, "User name").await?;
    session.save().await?;
    session.write_clear_marker().await?;
    session.save().await?;
    let meta = storage.get_session(id).await?.ok_or("missing session")?;
    assert_eq!(meta.custom_title.as_deref(), Some("User name"));
    Ok(())
}
