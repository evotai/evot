//! Block the only worker deterministically: ACP must keep reading frames while
//! image preparation is queued, without timing a real decoder or using sleeps.

use std::time::Duration;

use serde_json::json;
use tempfile::TempDir;

use super::acp_image_test::image_prompt;
use super::acp_image_test::new_session;
use super::acp_image_test::start;
use super::acp_image_test::PNG;
use super::acp_test::TestResult;

#[tokio::test]
async fn image_admission_precedes_immediate_cancel_in_the_same_wire_batch() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session = new_session(&mut client, &tmp).await?;
    client.send_batch(&[
        json!({"jsonrpc": "2.0", "id": "image", "method": "session/prompt", "params": image_prompt(&session, PNG)}),
        json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}),
    ]).await?;
    let response = client.frame().await?;
    assert_eq!(response["id"], "image", "{response}");
    assert_eq!(response["result"]["stopReason"], "cancelled", "{response}");
    assert!(calls.lock().is_empty());
    client.close().await
}

enum Stop {
    Cancel,
    Close,
    Disconnect,
}

#[test]
fn queued_image_preparation_can_be_cancelled_and_session_reused() -> TestResult {
    runtime()?.block_on(blocked_preparation(Stop::Cancel))
}

#[test]
fn queued_image_preparation_can_be_closed() -> TestResult {
    runtime()?.block_on(blocked_preparation(Stop::Close))
}

#[test]
fn disconnect_does_not_wait_for_queued_image_preparation() -> TestResult {
    runtime()?.block_on(blocked_preparation(Stop::Disconnect))
}

fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
}

async fn blocked_preparation(stop: Stop) -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session = new_session(&mut client, &tmp).await?;
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    let blocker = tokio::spawn(evot::base::blocking::blocking_io(
        "hold image worker",
        move |_| {
            let _ = started.send(());
            // Dropping `release` also unblocks this worker on test failure.
            let _ = held.recv_timeout(Duration::from_secs(10));
            Ok(())
        },
    ));
    waiting.await?;

    // This recognizable but truncated JPEG would fail validation if it ran.
    // Cancellation must win while preparation waits for the blocking pool.
    client.send(json!({"jsonrpc": "2.0", "id": "image", "method": "session/prompt", "params": image_prompt(&session, "/9j/")})).await?;
    let (response, frames) = client
        .request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
        )
        .await?;
    assert!(response.get("result").is_some(), "{response}");
    assert!(
        !frames.iter().any(|frame| frame["id"] == "image"),
        "{frames:?}"
    );

    // Admission is already reserved even though the worker has not run.
    let (response, frames) = client
        .request("session/prompt", image_prompt(&session, PNG))
        .await?;
    assert_eq!(response["error"]["code"], -32600, "{response}");
    assert!(
        !frames.iter().any(|frame| frame["id"] == "image"),
        "{frames:?}"
    );

    match stop {
        Stop::Cancel => {
            client.send(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}})).await?;
        }
        Stop::Close => {
            // Both responses are collected explicitly below, in either order.
            client.send(json!({"jsonrpc": "2.0", "id": "close", "method": "session/close", "params": {"sessionId": session}})).await?;
        }
        Stop::Disconnect => {
            // The occupied pool is not released until serve() has exited.
            client.close().await?;
            assert!(calls.lock().is_empty());
            drop(release);
            blocker.await??;
            return Ok(());
        }
    }
    let mut image_finished = false;
    let mut close_finished = !matches!(stop, Stop::Close);
    while !image_finished || !close_finished {
        let response = client.frame().await?;
        if response["id"] == "image" {
            assert_eq!(response["result"]["stopReason"], "cancelled", "{response}");
            image_finished = true;
        } else if response["id"] == "close" {
            assert!(response.get("result").is_some(), "{response}");
            close_finished = true;
        }
    }
    assert!(calls.lock().is_empty());
    drop(release);
    blocker.await??;

    if matches!(stop, Stop::Cancel) {
        let (response, _) = client
            .request("session/prompt", image_prompt(&session, PNG))
            .await?;
        assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
        assert_eq!(calls.lock().len(), 1);
    }
    client.close().await
}
