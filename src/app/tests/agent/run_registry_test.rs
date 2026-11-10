use evot::agent::run::registry::RunRegistry;
use evot::agent::RunControl;
use tokio_util::sync::CancellationToken;

fn message() -> evot_engine::AgentMessage {
    evot_engine::AgentMessage::Llm(evot_engine::Message::user("queued"))
}

#[test]
fn runtime_maps_events_without_an_unbounded_forwarding_queue() {
    let source = include_str!("../../src/agent/run/runtime.rs");
    assert!(!source.contains("fn forward_events"));
    assert!(!source.contains("runtime_rx"));
    assert!(!source.contains("unbounded_channel"));
    assert!(source.contains("event_channel(control.clone())"));
    assert!(source.contains("engine.submit_bounded("));
    assert!(!source.contains("fn build_agent"));
    assert!(!source.contains("AnthropicProvider"));
    let construction = include_str!("../../src/agent/run/engine.rs");
    assert!(!construction.contains("RunRegistry"));
    assert!(!construction.contains("session.write"));
    assert!(source.contains("pending_events.extend(map_agent_event(&event))"));
}

#[test]
fn dropping_unconsumed_run_synchronously_cancels_its_control() {
    let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let run = evot::agent::Run::from_receiver(rx, "session".into(), "run".into());
    let control = run.handle();
    drop(run);
    assert!(control.is_cancelled());
}

#[tokio::test]
async fn dropping_exhausted_run_does_not_cancel_successful_control() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    drop(tx);
    let mut run = evot::agent::Run::from_receiver(rx, "session".into(), "run".into());
    let control = run.handle();
    assert!(run.next().await.is_none());
    drop(run);
    assert!(!control.is_cancelled());
}

#[test]
fn steering_reports_admission_and_rejects_stopping_or_completed_runs() {
    let registry = RunRegistry::default();
    assert!(!registry.try_steer("session", message()));
    let handle = RunControl::new();
    let completed = CancellationToken::new();
    registry.register(
        "session".into(),
        "run".into(),
        handle.clone(),
        completed.clone(),
    );
    assert!(registry.try_steer("session", message()));
    assert_eq!(handle.queued_steering().len(), 1);
    handle.abort();
    assert!(!registry.try_steer("session", message()));
    registry.complete("session", "run", &completed);
    assert!(!registry.try_steer("session", message()));
}

#[test]
fn registry_completion_before_registration_never_leaves_stale_run() {
    let registry = RunRegistry::default();
    let completed = CancellationToken::new();
    registry.complete("session", "run", &completed);
    registry.register("session".into(), "run".into(), RunControl::new(), completed);
    assert!(!registry.contains("session"));
}

#[test]
fn registry_old_completion_cannot_remove_new_run() {
    let registry = RunRegistry::default();
    let old = CancellationToken::new();
    let new = CancellationToken::new();
    let handle = RunControl::new();
    registry.register(
        "session".into(),
        "old".into(),
        RunControl::new(),
        old.clone(),
    );
    registry.register("session".into(), "new".into(), handle.clone(), new.clone());
    registry.complete("session", "old", &old);
    assert!(registry.contains("session"));
    registry.steer("session", message());
    registry.follow_up("session", message());
    assert_eq!(handle.queued_steering().len(), 1);
    assert_eq!(handle.queued_follow_ups().len(), 1);
    registry.complete("session", "new", &new);
    assert!(!registry.contains("session"));
}

#[test]
fn registry_abort_requests_cancellation_but_waits_for_explicit_completion() {
    let registry = RunRegistry::default();
    let handle = RunControl::new();
    let completed = CancellationToken::new();
    registry.register(
        "session".into(),
        "run".into(),
        handle.clone(),
        completed.clone(),
    );
    let signal = registry.abort("session");
    assert!(signal.is_some());
    assert!(handle.is_cancelled());
    assert!(!completed.is_cancelled());
    assert!(registry.contains("session"));
    registry.complete("session", "run", &completed);
    assert!(completed.is_cancelled());
    assert!(!registry.contains("session"));
}

#[test]
fn registry_completed_runs_reject_queue_mutations_and_are_pruned() {
    let registry = RunRegistry::default();
    let handle = RunControl::new();
    let completed = CancellationToken::new();
    registry.register(
        "session".into(),
        "run".into(),
        handle.clone(),
        completed.clone(),
    );
    completed.cancel();
    registry.steer("session", message());
    registry.follow_up("session", message());
    assert!(handle.queued_steering().is_empty());
    assert!(handle.queued_follow_ups().is_empty());
    assert!(!registry.contains("session"));
    assert!(registry.abort("missing").is_none());
}
