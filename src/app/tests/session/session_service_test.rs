use std::sync::Arc;

use evot::session::storage::MemoryStorage;
use evot::session::SessionSelection;
use evot::session::SessionService;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn selection() -> SessionSelection {
    SessionSelection {
        provider: "fixture".into(),
        model: "model".into(),
        thinking_level: Some("high".into()),
    }
}

#[tokio::test]
async fn creation_validates_workspace_but_preserves_unspecified_default() -> TestResult {
    let dir = tempfile::tempdir()?;
    let service = SessionService::new(
        Arc::new(MemoryStorage::new()),
        "/default-not-on-disk".into(),
    );
    let draft = service
        .create("http", None, "fixture".into(), "model".into())
        .await?;
    assert_eq!(draft.cwd, "/default-not-on-disk");
    assert_eq!(draft.source, "http");
    assert_eq!(draft.thinking_level, None);
    let workspace = dir.path().join("project");
    std::fs::create_dir(&workspace)?;
    let draft = service
        .create(
            "cli",
            Some(&workspace.to_string_lossy()),
            "fixture".into(),
            "model".into(),
        )
        .await?;
    assert_eq!(
        draft.cwd,
        std::fs::canonicalize(&workspace)?.to_string_lossy()
    );
    let file = dir.path().join("file");
    std::fs::write(&file, "fixture")?;
    for invalid in [
        "".to_string(),
        file.to_string_lossy().into_owned(),
        dir.path().join("missing").to_string_lossy().into_owned(),
    ] {
        assert!(service
            .create("cli", Some(&invalid), "fixture".into(), "model".into())
            .await
            .is_err());
    }
    Ok(())
}

#[tokio::test]
async fn resolving_existing_session_preserves_workspace_and_source() -> TestResult {
    let service = SessionService::new(Arc::new(MemoryStorage::new()), "/original".into());
    let meta = service
        .create("http", None, "old".into(), "old-model".into())
        .await?;
    let session = service
        .resolve(
            Some(&meta.session_id),
            "cli",
            selection(),
            Some("/missing-new-workspace"),
        )
        .await?;
    let updated = session.meta().await;
    assert_eq!(updated.cwd, "/original");
    assert_eq!(updated.source, "http");
    assert_eq!(updated.provider, "fixture");
    assert_eq!(updated.model, "model");
    assert_eq!(updated.thinking_level.as_deref(), Some("high"));
    session.save().await?;
    let loaded = service
        .load(&meta.session_id)
        .await?
        .ok_or("session missing")?;
    assert_eq!(loaded.meta().await.thinking_level, updated.thinking_level);
    let cleared = service
        .resolve(
            Some(&meta.session_id),
            "ignored",
            SessionSelection {
                thinking_level: None,
                ..selection()
            },
            None,
        )
        .await?;
    assert_eq!(cleared.meta().await.thinking_level, None);
    Ok(())
}

#[tokio::test]
async fn missing_session_uses_requested_id_and_frozen_selection() -> TestResult {
    let service = SessionService::new(Arc::new(MemoryStorage::new()), "/default".into());
    assert!(service.load("new-session").await?.is_none());
    assert!(service
        .resolve(Some("rejected"), "channel", selection(), Some(""))
        .await
        .is_err());
    assert!(service.load("rejected").await?.is_none());
    let session = service
        .resolve(Some("new-session"), "channel", selection(), None)
        .await?;
    let meta = session.meta().await;
    assert_eq!(meta.session_id, "new-session");
    assert_eq!(meta.source, "channel");
    assert_eq!(meta.thinking_level.as_deref(), Some("high"));
    let other = service.resolve(None, "cli", selection(), None).await?;
    assert_ne!(other.session_id().await, meta.session_id);
    Ok(())
}

#[test]
fn session_service_does_not_own_provider_or_run_policy() {
    let service = include_str!("../../src/session/service.rs");
    for forbidden in [
        "LlmConfig",
        "RunRegistry",
        "StreamProvider",
        "crate::surface::gateway",
        "ToolMode",
    ] {
        assert!(!service.contains(forbidden), "{forbidden}");
    }
    for agent in [
        include_str!("../../src/agent/agent.rs"),
        include_str!("../../src/agent/agent_sessions.rs"),
    ] {
        assert!(!agent.contains("fn canonical_workspace"));
        assert!(!agent.contains("Session::new_with_provider_source"));
    }
}
