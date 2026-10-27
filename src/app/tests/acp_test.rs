use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol_schema::v1 as acp;
use evot::acp::AcpOptions;
use evot::agent::Agent;
use evot::agent::ToolMode;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::observability::TranscriptStats;
use evot::storage::MemoryStorage;
use evot_engine::provider::MockProvider;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use serde_json::json;
use serde_json::Value;
use tempfile::TempDir;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::io::DuplexStream;
use tokio::io::Lines;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn config(tmp: &TempDir) -> Config {
    let mut config = Config::new(tmp.path().join("state"));
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://127.0.0.1:1".into(),
        models: vec!["alpha".into(), "beta".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    config
}

/// In-process ACP client speaking to `evot::acp::serve` over duplex pipes.
struct Client {
    input: DuplexStream,
    output: Lines<BufReader<DuplexStream>>,
    server: JoinHandle<evot::error::Result<()>>,
    next_id: u64,
}

impl Client {
    fn start(
        tmp: &TempDir,
        mode: ToolMode,
        provider: impl StreamProvider + 'static,
    ) -> Result<(Self, Arc<Agent>), Box<dyn std::error::Error>> {
        Self::start_with(tmp, mode, false, provider)
    }

    fn start_with(
        tmp: &TempDir,
        mode: ToolMode,
        ask_permission: bool,
        provider: impl StreamProvider + 'static,
    ) -> Result<(Self, Arc<Agent>), Box<dyn std::error::Error>> {
        let config = config(tmp);
        let agent = Agent::new_with_provider_for_test(
            &config,
            tmp.path().to_string_lossy(),
            Arc::new(MemoryStorage::new()),
            provider,
        )?;
        let (input, server_input) = tokio::io::duplex(1 << 20);
        let (server_output, output) = tokio::io::duplex(1 << 20);
        let options = AcpOptions {
            mode,
            ask_permission,
            ephemeral: true,
            agent_version: "9.9.9-test".into(),
        };
        let server = tokio::spawn(evot::acp::serve(
            agent.clone(),
            config,
            options,
            server_input,
            server_output,
        ));
        Ok((
            Self {
                input,
                output: BufReader::new(output).lines(),
                server,
                next_id: 0,
            },
            agent,
        ))
    }

    async fn send(&mut self, frame: Value) -> TestResult {
        let mut line = serde_json::to_vec(&frame)?;
        line.push(b'\n');
        self.input.write_all(&line).await?;
        Ok(())
    }

    async fn frame(&mut self) -> Result<Value, Box<dyn std::error::Error>> {
        let line = tokio::time::timeout(Duration::from_secs(10), self.output.next_line())
            .await??
            .ok_or("server closed output")?;
        let frame: Value = serde_json::from_str(&line)?;
        assert_eq!(frame["jsonrpc"], "2.0", "{frame}");
        Ok(frame)
    }

    /// Send a request and collect notifications until its response arrives.
    /// Agent → client requests fail the test; use [`Self::request_answering`].
    async fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(Value, Vec<Value>), Box<dyn std::error::Error>> {
        self.request_answering(method, params, |frame| {
            panic!("unexpected agent request: {frame}")
        })
        .await
    }

    /// Like [`Self::request`], answering each agent → client request with
    /// `answer(request)`. Answered requests are included in the returned frames.
    async fn request_answering(
        &mut self,
        method: &str,
        params: Value,
        mut answer: impl FnMut(&Value) -> Value,
    ) -> Result<(Value, Vec<Value>), Box<dyn std::error::Error>> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        let mut frames = Vec::new();
        loop {
            let frame = self.frame().await?;
            if frame.get("method").is_none() && frame["id"] == id {
                return Ok((frame, frames));
            }
            if frame.get("method").is_some() && frame.get("id").is_some() {
                let result = answer(&frame);
                self.send(json!({"jsonrpc": "2.0", "id": frame["id"], "result": result}))
                    .await?;
            }
            frames.push(frame);
        }
    }

    async fn new_session(
        &mut self,
        cwd: &std::path::Path,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let (response, _) = self
            .request("session/new", json!({"cwd": cwd, "mcpServers": []}))
            .await?;
        let response: acp::NewSessionResponse = serde_json::from_value(response["result"].clone())?;
        Ok(response.session_id.0.to_string())
    }

    async fn close(self) -> TestResult {
        drop(self.input);
        tokio::time::timeout(Duration::from_secs(10), self.server).await???;
        Ok(())
    }
}

fn text_prompt(session_id: &str, text: &str) -> Value {
    json!({"sessionId": session_id, "prompt": [{"type": "text", "text": text}]})
}

/// Every update must be a valid ACP v1 `session/update` notification.
fn updates(
    notifications: &[Value],
) -> Result<Vec<acp::SessionNotification>, Box<dyn std::error::Error>> {
    notifications
        .iter()
        .map(|frame| {
            assert_eq!(frame["method"], "session/update", "{frame}");
            Ok(serde_json::from_value(frame["params"].clone())?)
        })
        .collect()
}

fn message_text(updates: &[acp::SessionNotification]) -> String {
    updates
        .iter()
        .filter_map(|update| match &update.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
                acp::ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn initialize_reports_v1_capabilities_and_version() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, MockProvider::text("ok"))?;
    let (response, notifications) = client
        .request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "test", "version": "1"}}),
        )
        .await?;
    assert!(notifications.is_empty());
    let result: acp::InitializeResponse = serde_json::from_value(response["result"].clone())?;
    assert_eq!(
        result.protocol_version,
        agent_client_protocol_schema::ProtocolVersion::V1
    );
    let info = result.agent_info.ok_or("missing agentInfo")?;
    assert_eq!(
        (info.name.as_str(), info.version.as_str()),
        ("evot", "9.9.9-test")
    );
    assert!(!result.agent_capabilities.load_session);
    let sessions = &result.agent_capabilities.session_capabilities;
    assert!(sessions.list.is_some() && sessions.resume.is_some() && sessions.close.is_some());
    client.close().await
}

#[tokio::test]
async fn chat_prompt_streams_answer_without_tools() -> TestResult {
    let tmp = TempDir::new()?;
    std::fs::write(tmp.path().join("AGENTS.md"), "PROJECT-RULE-MARKER")?;
    let (mut client, agent) =
        Client::start(&tmp, ToolMode::Chat, MockProvider::text("hello from evot"))?;
    let session_id = client.new_session(tmp.path()).await?;

    let (response, notifications) = client
        .request("session/prompt", text_prompt(&session_id, "say hello"))
        .await?;
    let result: acp::PromptResponse = serde_json::from_value(response["result"].clone())?;
    assert_eq!(result.stop_reason, acp::StopReason::EndTurn);
    let updates = updates(&notifications)?;
    assert!(updates
        .iter()
        .all(|update| update.session_id.0.as_ref() == session_id));
    assert_eq!(message_text(&updates), "hello from evot");
    assert!(!updates.iter().any(|update| matches!(
        update.update,
        acp::SessionUpdate::ToolCall(_) | acp::SessionUpdate::ToolCallUpdate(_)
    )));

    // The model was offered no tools at all.
    let transcript = agent.sessions().transcript(&session_id).await?;
    let started = transcript
        .iter()
        .find_map(TranscriptStats::try_from_item)
        .and_then(|stats| match stats {
            TranscriptStats::LlmCallStarted(started) => Some(started),
            _ => None,
        })
        .ok_or("missing llm call")?;
    assert!(
        started.tool_definitions.is_empty(),
        "{:?}",
        started.tool_definitions
    );
    // Coding-harness project instructions are not part of a tool-free turn.
    assert!(!started.system_prompt.contains("PROJECT-RULE-MARKER"));
    client.close().await
}

#[tokio::test]
async fn tool_calls_are_projected() -> TestResult {
    let tmp = TempDir::new()?;
    std::fs::write(tmp.path().join("note.txt"), "fixture contents")?;
    let provider = MockProvider::new(vec![
        evot_engine::provider::MockResponse::ToolCalls(vec![evot_engine::provider::MockToolCall {
            name: "read".into(),
            arguments: json!({"path": tmp.path().join("note.txt")}),
        }]),
        evot_engine::provider::MockResponse::Text("done".into()),
    ]);
    let (mut client, _) = Client::start(&tmp, ToolMode::Readonly, provider)?;
    let session_id = client.new_session(tmp.path()).await?;
    let (response, notifications) = client
        .request("session/prompt", text_prompt(&session_id, "read the note"))
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    let updates = updates(&notifications)?;
    let started = updates
        .iter()
        .find_map(|update| match &update.update {
            acp::SessionUpdate::ToolCall(call) => Some(call.clone()),
            _ => None,
        })
        .ok_or("missing tool_call")?;
    assert_eq!(started.kind, acp::ToolKind::Read);
    let finished = updates
        .iter()
        .find_map(|update| match &update.update {
            acp::SessionUpdate::ToolCallUpdate(update) => Some(update.clone()),
            _ => None,
        })
        .ok_or("missing tool_call_update")?;
    assert_eq!(finished.tool_call_id, started.tool_call_id);
    assert_eq!(finished.fields.status, Some(acp::ToolCallStatus::Completed));
    assert!(serde_json::to_string(&finished.fields.content)?.contains("fixture contents"));
    assert_eq!(message_text(&updates), "done");
    client.close().await
}

#[tokio::test]
async fn invalid_requests_return_jsonrpc_errors() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, MockProvider::text("ok"))?;

    let (response, _) = client
        .request(
            "session/new",
            json!({"cwd": "relative/dir", "mcpServers": []}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32602, "{response}");

    let (response, _) = client
        .request("session/prompt", text_prompt("not-a-session", "hi"))
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");

    let session_id = client.new_session(tmp.path()).await?;
    let (response, _) = client
        .request(
            "session/prompt",
            json!({"sessionId": session_id, "prompt": [{"type": "image", "mimeType": "image/png", "data": "AA=="}]}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32602, "{response}");

    let (response, _) = client.request("evot/unknown", json!({})).await?;
    assert_eq!(response["error"]["code"], -32601, "{response}");

    client.send(json!("not an object")).await?;
    client.input.write_all(b"{broken json\n").await?;
    let frame = client.frame().await?;
    assert_eq!(frame["error"]["code"], -32600, "{frame}");
    let frame = client.frame().await?;
    assert_eq!(frame["error"]["code"], -32700, "{frame}");
    client.close().await
}

#[tokio::test]
async fn model_config_option_is_per_session() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, agent) = Client::start(&tmp, ToolMode::Chat, MockProvider::text("ok"))?;
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    let session_id = response["result"]["sessionId"]
        .as_str()
        .ok_or("sessionId")?
        .to_string();
    let option = &response["result"]["configOptions"][0];
    assert_eq!(option["id"], "model");
    assert_eq!(option["category"], "model");
    assert_eq!(option["currentValue"], "test:alpha");

    let (response, _) = client
        .request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "model", "value": "test:beta"}),
        )
        .await?;
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"], "test:beta",
        "{response}"
    );
    // The process-wide selection is untouched.
    assert_eq!(agent.llm().model, "alpha");

    let (response, _) = client
        .request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "model", "value": "missing:model"}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32602, "{response}");
    client.close().await
}

#[tokio::test]
async fn sessions_can_be_listed_resumed_and_closed() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, _) = Client::start(
        &tmp,
        ToolMode::Chat,
        MockProvider::texts(vec!["one", "two"]),
    )?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .request("session/prompt", text_prompt(&session_id, "first"))
        .await?;

    let (response, _) = client
        .request("session/list", json!({"cwd": tmp.path()}))
        .await?;
    let list: acp::ListSessionsResponse = serde_json::from_value(response["result"].clone())?;
    assert!(list
        .sessions
        .iter()
        .any(|info| info.session_id.0.as_ref() == session_id));

    let (response, _) = client
        .request("session/close", json!({"sessionId": session_id}))
        .await?;
    assert!(response.get("result").is_some(), "{response}");
    let (response, _) = client
        .request("session/prompt", text_prompt(&session_id, "after close"))
        .await?;
    assert_eq!(response["error"]["code"], -32002, "{response}");

    let (response, _) = client
        .request(
            "session/resume",
            json!({"sessionId": session_id, "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    assert!(response.get("result").is_some(), "{response}");
    let (response, notifications) = client
        .request("session/prompt", text_prompt(&session_id, "second"))
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(message_text(&updates(&notifications)?), "two");
    client.close().await
}

struct WaitingProvider {
    started: CancellationToken,
}

#[async_trait::async_trait]
impl StreamProvider for WaitingProvider {
    async fn stream(
        &self,
        _config: StreamConfig,
        _tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.started.cancel();
        cancel.cancelled().await;
        Err(ProviderError::Cancelled)
    }
}

#[tokio::test]
async fn cancel_ends_prompt_with_cancelled() -> TestResult {
    let tmp = TempDir::new()?;
    let started = CancellationToken::new();
    let provider = WaitingProvider {
        started: started.clone(),
    };
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, provider)?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .send(json!({"jsonrpc": "2.0", "id": "p", "method": "session/prompt", "params": text_prompt(&session_id, "wait")}))
        .await?;
    tokio::time::timeout(Duration::from_secs(10), started.cancelled()).await?;
    client
        .send(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}}))
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
async fn disconnect_cancels_running_prompt_and_returns() -> TestResult {
    let tmp = TempDir::new()?;
    let started = CancellationToken::new();
    let provider = WaitingProvider {
        started: started.clone(),
    };
    let (mut client, _) = Client::start(&tmp, ToolMode::Chat, provider)?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .send(json!({"jsonrpc": "2.0", "id": "p", "method": "session/prompt", "params": text_prompt(&session_id, "wait")}))
        .await?;
    tokio::time::timeout(Duration::from_secs(10), started.cancelled()).await?;
    client.close().await
}

fn write_call(path: &std::path::Path) -> evot_engine::provider::MockResponse {
    evot_engine::provider::MockResponse::ToolCalls(vec![evot_engine::provider::MockToolCall {
        name: "write".into(),
        arguments: json!({"path": path, "content": "written"}),
    }])
}

fn selected(option_id: &str) -> Value {
    json!({"outcome": {"outcome": "selected", "optionId": option_id}})
}

fn permission_requests(frames: &[Value]) -> Vec<&Value> {
    frames
        .iter()
        .filter(|frame| frame["method"] == "session/request_permission")
        .collect()
}

fn session_updates(frames: &[Value]) -> Vec<acp::SessionNotification> {
    let notifications: Vec<Value> = frames
        .iter()
        .filter(|frame| frame["method"] == "session/update")
        .cloned()
        .collect();
    updates(&notifications).expect("valid session/update frames")
}

fn tool_statuses(updates: &[acp::SessionNotification]) -> Vec<acp::ToolCallStatus> {
    updates
        .iter()
        .filter_map(|update| match &update.update {
            acp::SessionUpdate::ToolCall(call) => Some(call.status),
            acp::SessionUpdate::ToolCallUpdate(update) => update.fields.status,
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn rejected_permission_never_runs_the_tool() -> TestResult {
    let tmp = TempDir::new()?;
    let target = tmp.path().join("created.txt");
    let provider = MockProvider::new(vec![
        write_call(&target),
        evot_engine::provider::MockResponse::Text("answered without tools".into()),
    ]);
    let (mut client, _) = Client::start_with(&tmp, ToolMode::Interactive, true, provider)?;
    let session_id = client.new_session(tmp.path()).await?;

    // BendSQL answers every permission request with `cancelled`.
    let (response, frames) = client
        .request_answering(
            "session/prompt",
            text_prompt(&session_id, "write a file"),
            |_| json!({"outcome": {"outcome": "cancelled"}}),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert!(!target.exists(), "denied write must not run");

    let requests = permission_requests(&frames);
    assert_eq!(requests.len(), 1);
    let request: acp::RequestPermissionRequest =
        serde_json::from_value(requests[0]["params"].clone())?;
    assert_eq!(request.session_id.0.as_ref(), session_id);
    assert_eq!(request.tool_call.fields.kind, Some(acp::ToolKind::Edit));
    let kinds: Vec<_> = request.options.iter().map(|option| option.kind).collect();
    assert_eq!(kinds, [
        acp::PermissionOptionKind::AllowOnce,
        acp::PermissionOptionKind::AllowAlways,
        acp::PermissionOptionKind::RejectOnce
    ]);

    let updates = session_updates(&frames);
    assert_eq!(tool_statuses(&updates), [
        acp::ToolCallStatus::Pending,
        acp::ToolCallStatus::Failed
    ]);
    assert_eq!(message_text(&updates), "answered without tools");
    client.close().await
}

#[tokio::test]
async fn reject_and_malformed_answers_deny() -> TestResult {
    let tmp = TempDir::new()?;
    let first = tmp.path().join("first.txt");
    let second = tmp.path().join("second.txt");
    let provider = MockProvider::new(vec![
        write_call(&first),
        evot_engine::provider::MockResponse::Text("one".into()),
        write_call(&second),
        evot_engine::provider::MockResponse::Text("two".into()),
    ]);
    let (mut client, _) = Client::start_with(&tmp, ToolMode::Interactive, true, provider)?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .request_answering("session/prompt", text_prompt(&session_id, "a"), |_| {
            selected("reject")
        })
        .await?;
    client
        .request_answering(
            "session/prompt",
            text_prompt(&session_id, "b"),
            |_| json!({"unexpected": true}),
        )
        .await?;
    assert!(!first.exists() && !second.exists());
    client.close().await
}

#[tokio::test]
async fn allowed_permission_runs_and_allow_always_is_remembered() -> TestResult {
    let tmp = TempDir::new()?;
    let first = tmp.path().join("first.txt");
    let second = tmp.path().join("second.txt");
    let provider = MockProvider::new(vec![
        write_call(&first),
        evot_engine::provider::MockResponse::Text("one".into()),
        write_call(&second),
        evot_engine::provider::MockResponse::Text("two".into()),
    ]);
    let (mut client, _) = Client::start_with(&tmp, ToolMode::Interactive, true, provider)?;
    let session_id = client.new_session(tmp.path()).await?;

    let (_, frames) = client
        .request_answering("session/prompt", text_prompt(&session_id, "a"), |_| {
            selected("allow_always")
        })
        .await?;
    assert_eq!(std::fs::read_to_string(&first)?, "written");
    assert_eq!(permission_requests(&frames).len(), 1);
    assert_eq!(tool_statuses(&session_updates(&frames)), [
        acp::ToolCallStatus::Pending,
        acp::ToolCallStatus::InProgress,
        acp::ToolCallStatus::Completed
    ]);

    // The same tool now runs without asking for the rest of the session.
    let (_, frames) = client
        .request("session/prompt", text_prompt(&session_id, "b"))
        .await?;
    assert_eq!(std::fs::read_to_string(&second)?, "written");
    assert!(permission_requests(&frames).is_empty());
    client.close().await
}

#[tokio::test]
async fn disconnect_while_awaiting_permission_denies() -> TestResult {
    let tmp = TempDir::new()?;
    let target = tmp.path().join("created.txt");
    let provider = MockProvider::new(vec![
        write_call(&target),
        evot_engine::provider::MockResponse::Text("never".into()),
    ]);
    let (mut client, _) = Client::start_with(&tmp, ToolMode::Interactive, true, provider)?;
    let session_id = client.new_session(tmp.path()).await?;
    client
        .send(json!({"jsonrpc": "2.0", "id": "p", "method": "session/prompt", "params": text_prompt(&session_id, "write")}))
        .await?;
    loop {
        let frame = client.frame().await?;
        if frame["method"] == "session/request_permission" {
            break;
        }
    }
    client.close().await?;
    assert!(!target.exists());
    Ok(())
}
