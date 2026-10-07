use std::sync::mpsc;
use std::time::Duration;

use evot::blocking::blocking_io;
use evot::blocking::cancelled;
use evot::error::EvotError;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn blocking_io_returns_worker_result() -> TestResult {
    let value = blocking_io("adder", |_| Ok(40 + 2)).await?;
    assert_eq!(value, 42);
    Ok(())
}

#[tokio::test]
async fn blocking_io_passes_worker_errors_through() -> TestResult {
    let result: evot::error::Result<()> =
        blocking_io("failing", |_| Err(EvotError::Store("boom".into()))).await;
    match result {
        Err(EvotError::Store(message)) => assert_eq!(message, "boom"),
        other => return Err(format!("expected worker error, got {other:?}").into()),
    }
    Ok(())
}

#[tokio::test]
async fn blocking_io_reports_worker_panic_with_label() -> TestResult {
    let result: evot::error::Result<()> = blocking_io("panicking", |_| {
        std::panic::panic_any("worker crashed");
    })
    .await;
    match result {
        Err(EvotError::Store(message)) => {
            assert!(message.starts_with("panicking task failed:"), "{message}");
        }
        other => return Err(format!("expected task failure, got {other:?}").into()),
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_blocking_io_future_cancels_worker() -> TestResult {
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (finished_tx, finished_rx) = mpsc::channel::<bool>();
    let future = blocking_io("spinner", move |cancel| {
        started_tx.send(()).map_err(|_| cancelled("spinner"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !cancel.is_cancelled() {
            if std::time::Instant::now() > deadline {
                finished_tx.send(false).map_err(|_| cancelled("spinner"))?;
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        finished_tx.send(true).map_err(|_| cancelled("spinner"))?;
        Ok(())
    });
    let handle = tokio::spawn(future);
    tokio::task::spawn_blocking(move || started_rx.recv()).await??;
    handle.abort();
    let saw_cancel =
        tokio::task::spawn_blocking(move || finished_rx.recv_timeout(Duration::from_secs(10)))
            .await??;
    assert!(
        saw_cancel,
        "worker should observe cancellation after the future is dropped"
    );
    Ok(())
}

#[test]
fn cancelled_error_carries_label() -> TestResult {
    match cancelled("session listing") {
        EvotError::Store(message) => assert_eq!(message, "session listing cancelled"),
        other => return Err(format!("unexpected error variant: {other:?}").into()),
    }
    Ok(())
}
