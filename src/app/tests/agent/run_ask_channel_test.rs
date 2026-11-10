//! Tests for the ask-channel + run-event select pattern used in the NAPI layer.
//!
//! The real bug: when the engine finishes, it drops the `AskUserFn` which
//! closes the ask channel. If `tokio::select!` picks the closed ask branch
//! (`recv() == None`) before the run branch, it returns EOF and swallows
//! remaining run events like `run_finished`.
//!
//! The fix: when `ask_rx.recv()` returns `None`, permanently disable the
//! ask branch (set to `None`) and continue reading from the run channel.
//!
//! These tests cover regression scenarios under the current production
//! semantics (ask_user is synchronous — no unconsumed ask messages at
//! engine completion). They are not a proof of correctness for arbitrary
//! channel interleavings.

use std::sync::Arc;

use evot::agent::Run;
use evot::session::conversation::RunEvent;
use evot::session::conversation::RunEventPayload;
use evot::types::UsageSummary;
use tokio::sync::mpsc;

/// Helper: create a run_finished RunEvent.
fn make_run_finished() -> RunEvent {
    RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        1,
        RunEventPayload::RunFinished {
            text: "done".into(),
            usage: UsageSummary::default(),
            turn_count: 1,
            duration_ms: 100,
            transcript_count: 2,
            compact_history: vec![],
        },
    )
}

fn make_run_started() -> RunEvent {
    RunEvent::new(
        "run-1".into(),
        "sess-1".into(),
        0,
        RunEventPayload::RunStarted {},
    )
}

/// Simulate the current NAPI `next()` select pattern at a behavioral level.
///
/// This is intentionally a standalone model for regression testing, not a
/// direct call into `NapiRun::next()`.
///
/// When `ask_rx` is `Some`, select across ask + run.
/// When `ask_rx.recv()` returns `None`, set it to `None` and read from run.
/// When `ask_rx` is `None`, only read from run.
async fn select_next(
    run: &mut Run,
    ask_rx: &mut Option<mpsc::UnboundedReceiver<String>>,
) -> Option<String> {
    match ask_rx.as_mut() {
        None => run.next().await.map(|e| e.kind_str().to_string()),
        Some(rx) => {
            tokio::select! {
                ask_json = rx.recv() => {
                    match ask_json {
                        Some(json) => Some(json),
                        None => {
                            *ask_rx = None;
                            run.next().await.map(|e| e.kind_str().to_string())
                        }
                    }
                }
                event = run.next() => {
                    event.map(|e| e.kind_str().to_string())
                }
            }
        }
    }
}

/// Core regression test: ask sender dropped, then run_finished arrives.
/// This is the exact sequence that caused the original bug.
/// The ask channel is empty when dropped (realistic — ask_user is synchronous).
#[tokio::test]
async fn ask_sender_dropped_then_run_finished() {
    let (run_tx, run_rx) = mpsc::unbounded_channel();
    let mut run = Run::from_receiver(run_rx, "sess-1".into(), "run-1".into());

    let (ask_tx, ask_rx) = mpsc::unbounded_channel::<String>();
    let mut ask_slot = Some(ask_rx);

    // Engine finishes: drop ask sender first, then send run_finished.
    // This is the realistic order — engine drops tools (including AskUserFn),
    // then run_loop sends run_finished.
    drop(ask_tx);
    run_tx.send(make_run_finished()).ok();
    drop(run_tx);

    // select may pick ask (None→fallthrough) or run (run_finished) first.
    // Either way, run_finished must be returned.
    let r1 = select_next(&mut run, &mut ask_slot).await;
    assert_eq!(
        r1.as_deref(),
        Some("run_finished"),
        "run_finished must not be swallowed"
    );
}

/// Run events are not lost when the ask channel is closed before consumption.
/// select! may or may not drain the ask branch — the invariant is that all
/// run events are delivered regardless.
#[tokio::test]
async fn run_events_not_lost_after_ask_close() {
    let (run_tx, run_rx) = mpsc::unbounded_channel();
    let mut run = Run::from_receiver(run_rx, "sess-1".into(), "run-1".into());

    let (_ask_tx, ask_rx) = mpsc::unbounded_channel::<String>();
    let mut ask_slot = Some(ask_rx);

    // Close the ask sender before consuming events.
    drop(_ask_tx);

    // Send multiple run events.
    run_tx.send(make_run_started()).ok();
    run_tx.send(make_run_finished()).ok();
    drop(run_tx);

    // Drain everything.
    let mut events = Vec::new();
    while let Some(e) = select_next(&mut run, &mut ask_slot).await {
        events.push(e);
    }

    assert!(
        events.contains(&"run_started".to_string()),
        "got: {events:?}"
    );
    assert!(
        events.contains(&"run_finished".to_string()),
        "got: {events:?}"
    );
    // Note: ask_slot may or may not be None here — when select! always picks
    // the run branch first, ask_rx never gets polled to None. This is fine;
    // the important invariant is that no run events are lost.
}

/// Normal flow: ask event arrives mid-run, then run completes.
#[tokio::test]
async fn ask_event_then_run_finished() {
    let (run_tx, run_rx) = mpsc::unbounded_channel();
    let mut run = Run::from_receiver(run_rx, "sess-1".into(), "run-1".into());

    let (ask_tx, ask_rx) = mpsc::unbounded_channel::<String>();
    let mut ask_slot = Some(ask_rx);

    // Run starts.
    run_tx.send(make_run_started()).ok();
    let r = select_next(&mut run, &mut ask_slot).await;
    assert_eq!(r.as_deref(), Some("run_started"));

    // Ask event arrives (no run events pending — select must pick ask).
    ask_tx.send("ask_q1".into()).ok();
    // Give tokio a chance to process.
    tokio::task::yield_now().await;
    let r = select_next(&mut run, &mut ask_slot).await;
    assert_eq!(r.as_deref(), Some("ask_q1"));
    assert!(ask_slot.is_some(), "ask branch still alive");

    // Engine finishes.
    drop(ask_tx);
    run_tx.send(make_run_finished()).ok();
    drop(run_tx);

    // Must get run_finished.
    let mut events = Vec::new();
    while let Some(e) = select_next(&mut run, &mut ask_slot).await {
        events.push(e);
    }
    assert!(
        events.contains(&"run_finished".to_string()),
        "got: {events:?}"
    );
}

/// When run channel is empty and ask is drained, returns None (stream done).
#[tokio::test]
async fn both_channels_empty_returns_none() {
    let (_run_tx, run_rx) = mpsc::unbounded_channel();
    let mut run = Run::from_receiver(run_rx, "sess-1".into(), "run-1".into());

    drop(_run_tx);
    let mut ask_slot: Option<mpsc::UnboundedReceiver<String>> = None;

    let r = select_next(&mut run, &mut ask_slot).await;
    assert!(r.is_none());
}

/// Abort fires while both channels are pending — must return None immediately.
/// This tests the same select pattern as NAPI `next()` but standalone,
/// since NAPI types can't be instantiated in unit tests. It verifies that
/// the abort_notify branch wins over pending ask/run channels.
#[tokio::test]
async fn abort_interrupts_pending_select() {
    let (_run_tx, run_rx) = mpsc::unbounded_channel::<RunEvent>();
    let mut run = Run::from_receiver(run_rx, "sess-1".into(), "run-1".into());

    let (_ask_tx, ask_rx) = mpsc::unbounded_channel::<String>();
    let mut ask_slot = Some(ask_rx);

    let abort = Arc::new(tokio::sync::Notify::new());

    // Simulate the three-way select with abort, matching NAPI logic.
    let abort_clone = abort.clone();
    let result = tokio::spawn(async move {
        let rx = &mut ask_slot;
        match rx.as_mut() {
            None => unreachable!(),
            Some(ask_rx) => {
                tokio::select! {
                    ask_json = ask_rx.recv() => {
                        ask_json.map(|j| format!("ask:{j}"))
                    }
                    event = run.next() => {
                        event.map(|e: RunEvent| format!("run:{}", e.kind_str()))
                    }
                    _ = abort_clone.notified() => {
                        run.abort();
                        None::<String>
                    }
                }
            }
        }
    });

    // Neither channel has data — select is blocked. Fire abort.
    tokio::task::yield_now().await;
    abort.notify_waiters();

    let r = result.await.expect("task should not panic");
    assert!(r.is_none(), "abort should return None, got: {r:?}");
}
