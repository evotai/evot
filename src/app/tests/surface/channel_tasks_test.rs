use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use evot::surface::gateway::channel_tasks::ChannelTasks;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn channel_tasks_gracefully_cancel_and_join() {
    let cancel = CancellationToken::new();
    let child = cancel.clone();
    let settled = Arc::new(AtomicBool::new(false));
    let observed = settled.clone();
    let task = tokio::spawn(async move {
        child.cancelled().await;
        observed.store(true, Ordering::SeqCst);
    });
    ChannelTasks::new(cancel.clone(), vec![task])
        .shutdown(Duration::from_secs(1))
        .await;
    assert!(cancel.is_cancelled());
    assert!(settled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn channel_tasks_abort_stalled_workers_after_deadline() -> TestResult {
    let cancel = CancellationToken::new();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _held_until_drop = dropped_tx;
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    started_rx.await?;
    let tasks = ChannelTasks::new(cancel, vec![task]);
    tokio::time::timeout(Duration::from_secs(1), tasks.shutdown(Duration::ZERO)).await?;
    assert!(dropped_rx.await.is_err());
    Ok(())
}

#[tokio::test]
async fn channel_tasks_drop_cancels_when_parent_future_is_abandoned() -> TestResult {
    let cancel = CancellationToken::new();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _held_until_drop = dropped_tx;
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    started_rx.await?;
    drop(ChannelTasks::new(cancel.clone(), vec![task]));
    assert!(cancel.is_cancelled());
    assert!(tokio::time::timeout(Duration::from_secs(1), dropped_rx)
        .await?
        .is_err());
    Ok(())
}
