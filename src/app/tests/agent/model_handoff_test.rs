use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use async_trait::async_trait;
use evot::agent::Agent;
use evot::agent::ExecutionLimits;
use evot::agent::QueryRequest;
use evot::agent::Run;
use evot::agent::SubmitOutcome;
use evot::agent::ToolApproval;
use evot::agent::ToolApprovalRequest;
use evot::agent::ToolApprover;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::observability::CompactionResult;
use evot::session::conversation::RunEvent;
use evot::session::conversation::RunEventPayload;
use evot::session::storage::MemoryStorage;
use evot::types::TranscriptItem;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use evot_engine::provider::MockToolCall;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::Usage;
use parking_lot::Mutex;
use serde_json::json;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const START: &str = "claude-fable-5.2";
const NEXT: &str = "claude-opus-5.5";
const TARGET: &str = "implementation:claude-opus-5.5";
const PROMPT: &str =
    "Read the contributor guide, then switch to Opus 5.5 to summarize it in Spanish.";
const HANDOFF: &str = "Summarize the contributor guide in Spanish.";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
type Requests = Arc<Mutex<Vec<StreamConfig>>>;

struct Recorder {
    mock: MockProvider,
    requests: Requests,
    reject_first_target: AtomicBool,
}

#[async_trait]
impl StreamProvider for Recorder {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.requests.lock().push(config.clone());
        if config.model == NEXT && self.reject_first_target.swap(false, Ordering::Relaxed) {
            return Err(ProviderError::InvalidRequest(
                "target rejected the request".into(),
            ));
        }
        self.mock.stream(config, tx, cancel).await
    }
}

fn fixture(dir: &TempDir, responses: Vec<MockResponse>) -> TestResult<(Arc<Agent>, Requests)> {
    fixture_with_windows(dir, responses, None, None)
}

fn fixture_with_windows(
    dir: &TempDir,
    responses: Vec<MockResponse>,
    start_window: Option<u32>,
    target_window: Option<u32>,
) -> TestResult<(Arc<Agent>, Requests)> {
    build_agent(
        dir,
        &model_config(dir, start_window, target_window),
        responses,
        false,
    )
}

fn model_config(dir: &TempDir, start_window: Option<u32>, target_window: Option<u32>) -> Config {
    let mut config = Config::new(dir.path().to_path_buf());
    for (provider, model, protocol, context_window) in [
        ("analysis", START, Protocol::Anthropic, start_window),
        ("implementation", NEXT, Protocol::OpenAi, target_window),
    ] {
        config.providers.insert(provider.into(), ProviderProfile {
            protocol,
            api_key: "fixture-key".into(),
            base_url: "http://localhost".into(),
            models: vec![model.into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window,
            max_tokens: None,
            supports_image: None,
        });
    }
    config.llm.provider = "analysis".into();
    config
}

fn build_agent(
    dir: &TempDir,
    config: &Config,
    responses: Vec<MockResponse>,
    reject_first_target: bool,
) -> TestResult<(Arc<Agent>, Requests)> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new_with_provider_for_test(
        config,
        dir.path().display().to_string(),
        Arc::new(MemoryStorage::new()),
        Recorder {
            mock: MockProvider::new(responses),
            requests: requests.clone(),
            reject_first_target: AtomicBool::new(reject_first_target),
        },
    )?;
    Ok((agent, requests))
}

fn switch_to(model: &str) -> MockToolCall {
    MockToolCall {
        name: "handoff_model".into(),
        arguments: json!({"model": model, "handoff": HANDOFF}),
    }
}

fn target_reply() -> MockResponse {
    MockResponse::Text("Aquí está el resumen.".into())
}

async fn start(agent: &Arc<Agent>, request: QueryRequest) -> TestResult<Run> {
    match agent.submit(request).await? {
        SubmitOutcome::Run(run) => Ok(run),
        SubmitOutcome::Command(_) => Err("expected a run".into()),
    }
}

async fn drain(run: &mut Run) -> Vec<RunEvent> {
    let mut events = Vec::new();
    while let Some(event) = run.next().await {
        assert_eq!(event.run_id, run.id);
        assert_eq!(event.session_id, run.session_id);
        events.push(event);
    }
    events
}

#[tokio::test]
async fn prompt_directed_handoff_resumes_same_run_and_keeps_the_new_selection() -> TestResult {
    let dir = TempDir::new()?;
    let (agent, requests) = fixture(&dir, vec![
        MockResponse::ToolCalls(vec![switch_to(TARGET)]),
        target_reply(),
        MockResponse::Text("next prompt".into()),
    ])?;
    let mut run = start(&agent, QueryRequest::text(PROMPT).allow_model_handoff()).await?;
    let events = drain(&mut run).await;
    let calls: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.payload {
            RunEventPayload::LlmCallStarted { model, turn, .. } => {
                Some((model.as_str(), *turn, event.turn))
            }
            _ => None,
        })
        .collect();
    assert_eq!(calls, [(START, 1, 1), (NEXT, 2, 2)]);
    assert!(events.iter().any(|event| matches!(&event.payload,
        RunEventPayload::LlmCallStarted { model, provider: Some(provider), thinking_level: Some(_), .. }
        if model == NEXT && provider == "implementation"
    )));
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.payload, RunEventPayload::RunStarted {}))
            .count(),
        1
    );
    assert!(
        matches!(events.last().map(|event| &event.payload), Some(RunEventPayload::RunFinished { turn_count: 2, text, .. }) if text == "Aquí está el resumen.")
    );
    assert!(!events
        .iter()
        .any(|e| matches!(e.payload, RunEventPayload::Error { .. })));
    {
        let requests = requests.lock();
        assert_eq!(
            requests[0]
                .system_prompt
                .matches("<name>model-handoff</name>")
                .count(),
            1
        );
        let tool = requests[0]
            .tools
            .iter()
            .find(|tool| tool.name == "handoff_model")
            .ok_or("handoff tool not offered")?;
        assert_eq!(
            tool.parameters["properties"]["model"]["enum"],
            json!([TARGET])
        );
        let received = &requests[1];
        assert_eq!(
            received.model_config.as_ref().map(|model| model.provider()),
            Some("implementation")
        );
        assert!(
            matches!(received.messages.as_slice(), [Message::User { content: user, .. }, Message::Assistant { .. }, Message::ToolResult { content: result, is_error: false, .. }]
            if matches!(user.as_slice(), [Content::Text { text }] if text == PROMPT)
            && matches!(result.as_slice(), [Content::Text { text }] if text.contains(HANDOFF)))
        );
    }
    let session = agent
        .load_session(&run.session_id)
        .await?
        .ok_or("missing session")?;
    assert!(session.transcript().await.iter().any(|item| matches!(item, TranscriptItem::ToolResult { tool_name, is_error: false, .. } if tool_name == "handoff_model")));
    let meta = session.meta().await;
    assert_eq!(meta.model, NEXT);
    assert_eq!(meta.provider, "implementation");
    assert_eq!(agent.llm().model, NEXT);
    assert_eq!(agent.llm().provider, "implementation");
    assert!(meta.thinking_level.is_none());
    let mut next = start(
        &agent,
        QueryRequest::text("One more question").session_id(Some(run.session_id.clone())),
    )
    .await?;
    drain(&mut next).await;
    let requests = requests.lock();
    assert_eq!(requests[2].model, NEXT);
    assert!(!requests[2]
        .tools
        .iter()
        .any(|tool| tool.name == "handoff_model"));
    Ok(())
}

#[tokio::test]
async fn target_request_rejection_does_not_revert_a_committed_selection() -> TestResult {
    let dir = TempDir::new()?;
    let config = model_config(&dir, None, None);
    let (agent, requests) = build_agent(
        &dir,
        &config,
        vec![
            MockResponse::ToolCalls(vec![switch_to(TARGET)]),
            target_reply(),
        ],
        true,
    )?;
    let mut run = start(&agent, QueryRequest::text(PROMPT).allow_model_handoff()).await?;
    let events = drain(&mut run).await;
    assert!(events.iter().any(|event| matches!(&event.payload, RunEventPayload::Error { message } if message.contains("target rejected the request"))));
    assert_eq!(agent.llm().model, NEXT);
    let session = agent
        .load_session(&run.session_id)
        .await?
        .ok_or("missing session")?;
    assert_eq!(session.meta().await.model, NEXT);
    let mut next = start(
        &agent,
        QueryRequest::text("Try again").session_id(Some(run.session_id.clone())),
    )
    .await?;
    drain(&mut next).await;
    assert_eq!(
        requests
            .lock()
            .iter()
            .map(|r| r.model.as_str())
            .collect::<Vec<_>>(),
        [START, NEXT, NEXT]
    );
    Ok(())
}

#[tokio::test]
async fn each_receiving_model_can_follow_a_multi_stage_prompt() -> TestResult {
    let dir = TempDir::new()?;
    let (agent, requests) = fixture(&dir, vec![
        MockResponse::ToolCalls(vec![switch_to(TARGET)]),
        MockResponse::ToolCalls(vec![switch_to(&format!("analysis:{START}"))]),
        MockResponse::Text("Cross-check complete".into()),
    ])?;
    let mut run = start(
        &agent,
        QueryRequest::text(
            "Switch to Opus to compare the APIs, then switch back to cross-check its conclusions.",
        )
        .allow_model_handoff(),
    )
    .await?;
    let events = drain(&mut run).await;
    assert!(
        matches!(events.last().map(|event| &event.payload), Some(RunEventPayload::RunFinished { turn_count: 3, text, .. }) if text == "Cross-check complete")
    );
    assert_eq!(
        requests
            .lock()
            .iter()
            .map(|r| r.model.as_str())
            .collect::<Vec<_>>(),
        [START, NEXT, START]
    );
    Ok(())
}

#[tokio::test]
async fn handoff_to_a_smaller_window_compacts_before_the_target_request() -> TestResult {
    let dir = TempDir::new()?;
    let (agent, requests) = fixture_with_windows(
        &dir,
        vec![
            MockResponse::ToolCalls(vec![switch_to(TARGET)]),
            MockResponse::Text("Summary of the old conversation".into()),
            target_reply(),
        ],
        None,
        Some(32_768),
    )?;
    let meta = agent.create_session("test").await?;
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or("missing session")?;
    let mut history = Vec::new();
    for _ in 0..4 {
        history.push(TranscriptItem::User {
            text: "details about the original interface. ".repeat(6_000),
            content: vec![],
            provenance: None,
        });
        history.push(TranscriptItem::Assistant {
            content: vec![evot::types::AssistantBlock::Text {
                text: "Noted.".into(),
            }],
            stop_reason: "stop".into(),
            usage: Default::default(),
            model: START.into(),
            provider: "analysis".into(),
            timestamp: evot_engine::now_ms(),
            error_message: None,
        });
    }
    session.write_items(history).await?;
    let SubmitOutcome::Run(mut run) = agent
        .submit_to_session(QueryRequest::text(PROMPT).allow_model_handoff(), session)
        .await?
    else {
        return Err("expected a run".into());
    };
    let events = drain(&mut run).await;
    let compact = events
        .iter()
        .position(|e| {
            matches!(
                e.payload,
                RunEventPayload::ContextCompactionCompleted { .. }
            )
        })
        .ok_or("handoff did not compact")?;
    let target = events.iter().position(|e| matches!(&e.payload, RunEventPayload::LlmCallStarted { model, .. } if model == NEXT)).ok_or("target did not start")?;
    assert!(compact < target);
    let requests = requests.lock();
    assert_eq!(
        requests
            .iter()
            .map(|r| r.model.as_str())
            .collect::<Vec<_>>(),
        [START, START, NEXT]
    );
    assert!(requests[2].messages.iter().any(|message| matches!(message, Message::ToolResult { is_error: false, content, .. } if matches!(content.as_slice(), [Content::Text { text }] if text.contains(HANDOFF)))));
    Ok(())
}

#[tokio::test]
async fn rejected_target_and_mixed_batch_do_not_switch_or_execute_other_tools() -> TestResult {
    let dir = TempDir::new()?;
    let path = dir.path().join("should-not-exist");
    let (agent, requests) = fixture(&dir, vec![
        MockResponse::ToolCalls(vec![switch_to("implementation:unlisted")]),
        MockResponse::ToolCalls(vec![switch_to(TARGET), MockToolCall {
            name: "write".into(),
            arguments: json!({"path": path, "content": "no"}),
        }]),
        MockResponse::Text("Handoff did not run".into()),
    ])?;
    let mut run = start(&agent, QueryRequest::text(PROMPT).allow_model_handoff()).await?;
    let events = drain(&mut run).await;
    let errors: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.payload {
            RunEventPayload::ToolFinished {
                is_error: true,
                content,
                ..
            } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(errors.len(), 3);
    assert_eq!(
        errors
            .iter()
            .filter(|text| text.contains("must be called alone"))
            .count(),
        2
    );
    assert!(!path.exists());
    assert_eq!(agent.llm().model, START);
    assert_eq!(
        requests
            .lock()
            .iter()
            .map(|r| r.model.as_str())
            .collect::<Vec<_>>(),
        [START, START, START]
    );
    Ok(())
}

struct ApprovalGate {
    entered: Notify,
    release: Notify,
}

#[async_trait]
impl ToolApprover for ApprovalGate {
    async fn approve(&self, request: ToolApprovalRequest) -> ToolApproval {
        assert_eq!(request.tool_name, "handoff_model");
        self.entered.notify_one();
        self.release.notified().await;
        ToolApproval::Allow
    }
}

#[tokio::test]
async fn steering_during_handoff_reaches_the_receiving_model() -> TestResult {
    let dir = TempDir::new()?;
    let (agent, requests) = fixture(&dir, vec![
        MockResponse::ToolCalls(vec![switch_to(TARGET)]),
        target_reply(),
    ])?;
    let approval = Arc::new(ApprovalGate {
        entered: Notify::new(),
        release: Notify::new(),
    });
    let mut run = start(
        &agent,
        QueryRequest::text(PROMPT)
            .allow_model_handoff()
            .approver(approval.clone()),
    )
    .await?;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        approval.entered.notified(),
    )
    .await?;
    run.handle()
        .steer(AgentMessage::Llm(Message::user("Keep it short.")));
    approval.release.notify_one();
    drain(&mut run).await;
    let requests = requests.lock();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].model, NEXT);
    assert!(
        matches!(requests[1].messages.last(), Some(Message::User { content, .. }) if matches!(content.as_slice(), [Content::Text { text }] if text == "Keep it short."))
    );
    Ok(())
}

#[tokio::test]
async fn next_prompt_compacts_after_an_explicit_switch_to_the_smaller_model() -> TestResult {
    const SMALL_WINDOW: u32 = 65_536;
    let dir = TempDir::new()?;
    let (agent, requests) = fixture_with_windows(
        &dir,
        vec![
            MockResponse::ToolCalls(vec![switch_to(TARGET)]),
            MockResponse::Text("Ready to review the notes.".into()),
            MockResponse::Text("Noted the first section.".into()),
            MockResponse::Text("Noted the second section.".into()),
            MockResponse::TextWithUsage {
                text: "Received all three sections.".into(),
                usage: Usage {
                    input: 75_000,
                    output: 10,
                    ..Default::default()
                },
            },
            MockResponse::Text("Summary of the detailed input".into()),
            MockResponse::Text("Smaller model answered.".into()),
        ],
        Some(SMALL_WINDOW),
        Some(256_000),
    )?;
    let approval = Arc::new(ApprovalGate {
        entered: Notify::new(),
        release: Notify::new(),
    });
    let mut handoff = start(
        &agent,
        QueryRequest::text(PROMPT)
            .allow_model_handoff()
            .approver(approval.clone()),
    )
    .await?;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        approval.entered.notified(),
    )
    .await?;
    // Grow the context only after handoff, across compactable message boundaries.
    for section in ["one", "two", "three"] {
        handoff
            .handle()
            .follow_up(AgentMessage::Llm(Message::user(format!(
                "Section {section}: {}",
                "Detailed interface notes. ".repeat(3_800)
            ))));
    }
    approval.release.notify_one();
    let events = drain(&mut handoff).await;
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        RunEventPayload::LlmCallStarted { model, estimated_context_tokens: tokens, .. }
            if model == NEXT && *tokens > SMALL_WINDOW as usize
    )));
    assert_eq!(requests.lock().len(), 5);
    assert_eq!(agent.llm().model, NEXT);

    let config = model_config(&dir, Some(SMALL_WINDOW), Some(256_000));
    agent.set_model_by_spec(&config, &format!("analysis:{START}"))?;
    let mut next = start(
        &agent,
        QueryRequest::text("One more question").session_id(Some(handoff.session_id.clone())),
    )
    .await?;
    let events = drain(&mut next).await;
    let compact = events
        .iter()
        .position(|event| {
            matches!(event.payload, RunEventPayload::ContextCompactionCompleted {
                result: CompactionResult::Compacted { .. },
                ..
            })
        })
        .ok_or("switch to the smaller model did not compact")?;
    let call = events
        .iter()
        .position(|event| matches!(event.payload, RunEventPayload::LlmCallStarted { .. }))
        .ok_or("smaller model did not start")?;
    assert!(compact < call);
    assert!(matches!(
        &events[call].payload,
        RunEventPayload::LlmCallStarted { model, estimated_context_tokens: tokens, .. }
            if model == START && *tokens < SMALL_WINDOW as usize
    ));
    assert!(matches!(events.last().map(|event| &event.payload),
        Some(RunEventPayload::RunFinished { text, .. }) if text == "Smaller model answered."
    ));
    Ok(())
}

#[tokio::test]
async fn cancellation_during_handoff_does_not_start_the_target() -> TestResult {
    let dir = TempDir::new()?;
    let (agent, requests) = fixture(&dir, vec![
        MockResponse::ToolCalls(vec![switch_to(TARGET)]),
        target_reply(),
    ])?;
    let approval = Arc::new(ApprovalGate {
        entered: Notify::new(),
        release: Notify::new(),
    });
    let mut run = start(
        &agent,
        QueryRequest::text(PROMPT)
            .allow_model_handoff()
            .approver(approval.clone()),
    )
    .await?;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        approval.entered.notified(),
    )
    .await?;
    run.abort();
    drain(&mut run).await;
    assert_eq!(requests.lock().len(), 1);
    assert_eq!(agent.llm().model, START);
    Ok(())
}

#[tokio::test]
async fn handoff_cannot_reset_a_run_budget() -> TestResult {
    let dir = TempDir::new()?;
    let (agent, requests) = fixture(&dir, vec![
        MockResponse::ToolCalls(vec![switch_to(TARGET)]),
        target_reply(),
    ])?;
    let agent = agent.with_limits(ExecutionLimits {
        max_turns: 1,
        ..Default::default()
    });
    let mut run = start(&agent, QueryRequest::text(PROMPT).allow_model_handoff()).await?;
    let events = drain(&mut run).await;
    assert!(events.iter().any(|e| matches!(&e.payload, RunEventPayload::Error { message } if message.contains("Max turns reached"))));
    assert_eq!(requests.lock().len(), 1);
    assert_eq!(agent.llm().model, START);
    Ok(())
}
