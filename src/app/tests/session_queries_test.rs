use std::sync::Arc;

use evot::sessions::Session;
use evot::sessions::SessionQueries;
use evot::storage::MemoryStorage;
use evot::types::TranscriptItem;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn session_queries_filter_drafts_before_limit_without_an_agent() -> TestResult {
    let storage = Arc::new(MemoryStorage::new());
    let visible = Session::new_with_provider_source(
        evot::types::new_id(),
        "/work".into(),
        "provider".into(),
        "model".into(),
        "test",
        storage.clone(),
    )
    .await?;
    visible
        .write_items(vec![TranscriptItem::User {
            provenance: None,
            text: "hello".into(),
            content: vec![],
        }])
        .await?;
    let draft = Session::new_with_provider_source(
        evot::types::new_id(),
        "/work".into(),
        "provider".into(),
        "model".into(),
        "test",
        storage.clone(),
    )
    .await?;
    let queries = SessionQueries::new(storage);
    let rows = queries.list(1).await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session_id, visible.session_id().await);
    let draft_id = draft.session_id().await;
    assert!(queries.find(&draft_id).await?.is_some());
    assert!(queries.transcript(&draft_id).await?.is_empty());
    let id = visible.session_id().await;
    assert_eq!(queries.transcript(&id).await?.len(), 1);
    assert_eq!(queries.resume_transcript(&id).await?.len(), 1);
    assert_eq!(queries.context_transcript(&id).await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn session_queries_missing_session_is_empty() -> TestResult {
    let queries = SessionQueries::new(Arc::new(MemoryStorage::new()));
    let id = evot::types::new_id();
    assert!(queries.find(&id).await?.is_none());
    assert!(queries.transcript(&id).await?.is_empty());
    assert!(queries.resume_transcript(&id).await?.is_empty());
    assert!(queries.context_transcript(&id).await?.is_empty());
    Ok(())
}

#[test]
fn session_queries_do_not_own_run_control_or_duplicate_agent_queries() {
    let queries = include_str!("../src/sessions/queries.rs");
    for forbidden in [
        "Arc<Agent>",
        "RunControl",
        "delete_session",
        "abort_run",
        "crate::gateway",
    ] {
        assert!(!queries.contains(forbidden));
    }
    for file in [
        include_str!("../src/sessions/session.rs"),
        include_str!("../src/sessions/queries.rs"),
        include_str!("../src/conversation/convert.rs"),
    ] {
        assert!(!file.contains("crate::agent"));
    }
    let agent = include_str!("../src/agent/agent.rs");
    assert!(!agent.contains("RwLock<Arc<dyn Storage>>"));
    for removed in [
        "pub async fn list_sessions",
        "pub async fn find_session",
        "fn resume_transcript_items",
        "pub async fn load_transcript",
    ] {
        assert!(!agent.contains(removed));
    }
}
