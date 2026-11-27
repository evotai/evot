//! `session/load` replays a stored conversation; `session/delete` removes one.

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol_schema::v1 as acp;
use evot::agent::ToolMode;
use evot::session::storage::fs::FsStorage;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use evot_engine::provider::MockToolCall;
use serde_json::json;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::acp_test::config;
use super::acp_test::message_text;
use super::acp_test::text_prompt;
use super::acp_test::updates;
use super::acp_test::Client;
use super::acp_test::TestResult;
use super::acp_test::WaitingProvider;

fn user_text(updates: &[acp::SessionNotification]) -> String {
    updates
        .iter()
        .filter_map(|update| match &update.update {
            acp::SessionUpdate::UserMessageChunk(chunk) => match &chunk.content {
                acp::ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn load_replays_the_conversation_before_answering() -> TestResult {
    let tmp = TempDir::new()?;
    std::fs::write(tmp.path().join("note.txt"), "fixture contents")?;
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "read".into(),
            arguments: json!({"path": tmp.path().join("note.txt")}),
        }]),
        MockResponse::Text("done".into()),
        MockResponse::Text("again".into()),
    ]);
    let (mut client, _) = Client::start(&tmp, ToolMode::Readonly, provider)?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .request("session/prompt", text_prompt(&session_id, "read the note"))
        .await?;
    client
        .request("session/close", json!({"sessionId": session_id}))
        .await?;

    let (response, notifications) = client
        .request(
            "session/load",
            json!({"sessionId": session_id, "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    let _: acp::LoadSessionResponse = serde_json::from_value(response["result"].clone())?;
    let replayed = updates(&notifications)?;
    assert!(replayed
        .iter()
        .all(|update| update.session_id.0.as_ref() == session_id));
    assert_eq!(user_text(&replayed), "read the note");
    assert_eq!(message_text(&replayed), "done");
    let calls: Vec<_> = replayed
        .iter()
        .filter_map(|update| match &update.update {
            acp::SessionUpdate::ToolCall(call) => Some(call),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 1, "{replayed:?}");
    assert_eq!(calls[0].kind, acp::ToolKind::Read);
    assert_eq!(calls[0].status, acp::ToolCallStatus::Completed);
    assert!(format!("{:?}", calls[0].content).contains("fixture contents"));

    // The loaded session takes prompts again, on the same connection.
    let (response, notifications) = client
        .request("session/prompt", text_prompt(&session_id, "once more"))
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(message_text(&updates(&notifications)?), "again");
    client.close().await
}

#[tokio::test]
async fn load_only_replays_history_after_clear() -> TestResult {
    let tmp = TempDir::new()?;
    let provider = MockProvider::new(vec![
        MockResponse::Text("old reply".into()),
        MockResponse::Text("new reply".into()),
    ]);
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, provider)?;
    let id = client.new_session(tmp.path()).await?;
    for text in ["old prompt", "/clear", "new prompt"] {
        let (response, _) = client
            .request("session/prompt", text_prompt(&id, text))
            .await?;
        assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    }
    let (response, frames) = client
        .request(
            "session/load",
            json!({"sessionId": id, "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    assert!(response.get("result").is_some(), "{response}");
    let replayed = updates(&frames)?;
    assert_eq!(user_text(&replayed), "new prompt");
    assert_eq!(message_text(&replayed), "new reply");
    client.close().await
}

#[tokio::test]
async fn failed_history_read_does_not_register_the_session() -> TestResult {
    let tmp = TempDir::new()?;
    let storage = Arc::new(FsStorage::new(tmp.path().into()));
    let (mut client, agent) = Client::start_with_storage(
        &tmp,
        config(&tmp),
        ToolMode::Chat,
        false,
        storage,
        MockProvider::text("ok"),
    )?;
    let id = agent.create_session("acp").await?.session_id;
    // Metadata exists, but opening the transcript as a regular file fails.
    std::fs::create_dir(
        tmp.path()
            .join("sessions")
            .join(&id)
            .join("transcript.jsonl"),
    )?;
    let (response, frames) = client
        .request(
            "session/load",
            json!({"sessionId": id, "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32603, "{response}");
    assert!(frames.is_empty());
    let (response, _) = client
        .request("session/close", json!({"sessionId": id}))
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");
    client.close().await
}

async fn running_prompt(tmp: &TempDir) -> Result<(Client, String), Box<dyn std::error::Error>> {
    let started = CancellationToken::new();
    let (mut client, _) = Client::start(tmp, ToolMode::Chat, WaitingProvider {
        started: started.clone(),
    })?;
    let id = client.new_session(tmp.path()).await?;
    client.send(json!({"jsonrpc":"2.0","id":"p","method":"session/prompt","params":text_prompt(&id, "wait")})).await?;
    tokio::time::timeout(Duration::from_secs(10), started.cancelled()).await?;
    Ok((client, id))
}

#[tokio::test]
async fn reopen_refuses_running_prompt_without_losing_cancellation() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, id) = running_prompt(&tmp).await?;
    for method in ["session/load", "session/resume"] {
        let (response, frames) = client
            .request(
                method,
                json!({"sessionId": id, "cwd": tmp.path(), "mcpServers": []}),
            )
            .await?;
        assert_eq!(response["error"]["code"], -32600, "{response}");
        assert!(
            user_text(&updates(&frames)?).is_empty(),
            "unexpected replay"
        );
    }
    client
        .send(json!({"jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId": id}}))
        .await?;
    loop {
        let frame = client.frame().await?;
        if frame["id"] == "p" {
            assert_eq!(frame["result"]["stopReason"], "cancelled", "{frame}");
            break;
        }
    }
    client.close().await
}

#[tokio::test]
async fn delete_stops_running_prompt_and_session_stays_deleted() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, id) = running_prompt(&tmp).await?;
    client.send(json!({"jsonrpc":"2.0","id":"delete","method":"session/delete","params":{"sessionId":id}})).await?;
    let (mut deleted, mut cancelled) = (false, false);
    while !deleted || !cancelled {
        let frame = client.frame().await?;
        match frame["id"].as_str() {
            Some("delete") => {
                assert!(frame.get("result").is_some(), "{frame}");
                deleted = true;
            }
            Some("p") => {
                assert_eq!(frame["result"]["stopReason"], "cancelled", "{frame}");
                cancelled = true;
            }
            _ => {}
        }
    }
    let (response, _) = client
        .request(
            "session/load",
            json!({"sessionId": id, "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");
    client.close().await
}

#[tokio::test]
async fn load_of_an_unknown_session_is_not_found() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, MockProvider::text("ok"))?;
    let (response, notifications) = client
        .request(
            "session/load",
            json!({"sessionId": "missing", "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");
    assert!(notifications.is_empty());
    client.close().await
}

#[tokio::test]
async fn delete_removes_the_session_from_list_and_this_connection() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, MockProvider::text("one"))?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .request("session/prompt", text_prompt(&session_id, "first"))
        .await?;

    let (response, _) = client
        .request("session/delete", json!({"sessionId": session_id}))
        .await?;
    let _: acp::DeleteSessionResponse = serde_json::from_value(response["result"].clone())?;
    let (response, _) = client
        .request("session/list", json!({"cwd": tmp.path()}))
        .await?;
    let list: acp::ListSessionsResponse = serde_json::from_value(response["result"].clone())?;
    assert!(!list
        .sessions
        .iter()
        .any(|info| info.session_id.0.as_ref() == session_id));
    let (response, _) = client
        .request("session/prompt", text_prompt(&session_id, "after delete"))
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");
    let (response, _) = client
        .request("session/delete", json!({"sessionId": session_id}))
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");
    client.close().await
}
