//! `ProcessRegistry` admission and lifecycle, tested without an `Agent`.

use evot::agent::processes::ProcessRegistry;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn acquire_is_idempotent_per_session_and_distinct_across_sessions() -> TestResult {
    let registry = ProcessRegistry::new();
    let first = registry.acquire("a")?;
    let again = registry.acquire("a")?;
    let other = registry.acquire("b")?;
    assert!(std::sync::Arc::ptr_eq(&first, &again));
    assert!(!std::sync::Arc::ptr_eq(&first, &other));
    Ok(())
}

#[test]
fn idle_unreferenced_managers_are_dropped_on_the_next_acquire() -> TestResult {
    let registry = ProcessRegistry::new();
    let idle = registry.acquire("idle")?;
    let weak = std::sync::Arc::downgrade(&idle);
    drop(idle);
    assert!(weak.upgrade().is_some());
    // The idle manager has no live work and no other owner, so acquiring for a
    // different session reclaims it instead of retaining it forever.
    let _busy = registry.acquire("busy")?;
    assert!(weak.upgrade().is_none());
    let recreated = registry.acquire("idle")?;
    assert_eq!(std::sync::Arc::strong_count(&recreated), 2);
    Ok(())
}

#[test]
fn retained_managers_stay_bounded_when_every_one_is_still_referenced() -> TestResult {
    let registry = ProcessRegistry::new();
    let mut held = Vec::new();
    for index in 0..256 {
        held.push(registry.acquire(&format!("session-{index}"))?);
    }
    let error = match registry.acquire("one-too-many") {
        Ok(_) => return Err("expected the retained-manager limit to reject".into()),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("limit: 256"), "{error}");
    // Capacity applies only to new sessions, not turns of an admitted session.
    assert!(std::sync::Arc::ptr_eq(
        &held[0],
        &registry.acquire("session-0")?
    ));
    drop(held);
    // Once the holders are gone, the idle managers are reclaimed.
    registry.acquire("one-too-many")?;
    Ok(())
}

#[tokio::test]
async fn unknown_sessions_report_nothing_rather_than_failing() -> TestResult {
    let registry = ProcessRegistry::new();
    assert!(registry.summaries("missing").is_empty());
    assert_eq!(registry.blocking_waiters("missing"), 0);
    assert_eq!(registry.release_blocking_waiters("missing"), 0);
    assert_eq!(registry.pending_notifications("missing"), 0);
    assert_eq!(registry.pending_wake_notifications("missing"), 0);
    assert!(registry.stop_background("missing", "task").await?.is_none());
    assert!(registry.stop_all_background("missing").await.is_empty());
    registry.retire("missing").await;
    assert_eq!(registry.kill_all_now(), 0);
    Ok(())
}

#[tokio::test]
async fn retire_forgets_the_session_manager() -> TestResult {
    let registry = ProcessRegistry::new();
    let before = registry.acquire("s")?;
    registry.retire("s").await;
    let after = registry.acquire("s")?;
    assert!(!std::sync::Arc::ptr_eq(&before, &after));
    assert_manager_closed(&before).await?;
    Ok(())
}

async fn assert_manager_closed(manager: &evot_engine::tools::ProcessManager) -> TestResult {
    let dir = tempfile::tempdir()?;
    let request = evot_engine::tools::process::StartProcess {
        command: tokio::process::Command::new("evot-registry-test-must-not-spawn"),
        command_text: "closed manager test".into(),
        description: None,
        tool_call_id: "closed".into(),
        cwd: dir.path().to_path_buf(),
        timeout: std::time::Duration::from_secs(1),
        output_dir: dir.path().to_path_buf(),
        tail_bytes: 1024,
        background_reason: None,
        background_on_timeout: false,
    };
    let error = manager
        .start(request)
        .await
        .err()
        .ok_or("manager remained open")?;
    assert!(error.to_string().contains("closed"), "{error}");
    Ok(())
}

#[tokio::test]
async fn dropping_registry_closes_managers_even_with_external_holders() -> TestResult {
    let registry = ProcessRegistry::new();
    let manager = registry.acquire("s")?;
    drop(registry);
    assert_manager_closed(&manager).await
}

#[test]
fn agent_delegates_process_admission_and_lifecycle() {
    let agent = include_str!("../src/agent/agent.rs");
    assert!(!agent.contains("process_managers"));
    assert!(!agent.contains("MAX_SESSION_PROCESS_MANAGERS"));
    assert!(!agent.contains("ProcessManager::new"));
    let registry = include_str!("../src/agent/processes.rs");
    for forbidden in [
        "use crate::gateway",
        "use crate::storage",
        "use super::Agent",
    ] {
        assert!(!registry.contains(forbidden));
    }
}
