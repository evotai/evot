use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use evot::session::SessionGates;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn session_gates_are_bounded_and_equal_keys_share_a_lock() {
    let gates = SessionGates::new();
    let addresses: HashSet<_> = (0..10_000)
        .map(|i| gates.gate(&format!("session-{i}")) as *const _)
        .collect();
    assert!(addresses.len() <= 64);
    assert!(addresses.len() > 1);
    assert!(std::ptr::eq(gates.gate("same"), gates.gate("same")));
}

#[tokio::test]
async fn session_gates_serialize_equal_keys_across_yields() -> TestResult {
    let gates = Arc::new(SessionGates::new());
    let active = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let gates = gates.clone();
        let active = active.clone();
        tasks.push(tokio::spawn(async move {
            let _guard = gates.gate("same").lock().await;
            assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
            tokio::task::yield_now().await;
            assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
        }));
    }
    for task in tasks {
        task.await?;
    }
    Ok(())
}

#[test]
fn session_gates_are_owned_per_coordinator_not_globally_shared() {
    let routing = SessionGates::new();
    let lifecycle = SessionGates::new();
    let _guard = routing.gate("same").try_lock();
    assert!(lifecycle.gate("same").try_lock().is_ok());
    let source = include_str!("../../src/agent/run_manager.rs");
    assert!(!source.contains("HashMap"));
    assert!(source.contains("gates: SessionGates"));
}
