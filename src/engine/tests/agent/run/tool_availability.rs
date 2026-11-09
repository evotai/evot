//! Production regression: stopping /loop removes two host tools while their
//! calls and scheduling instructions remain in the session history.
use std::sync::Arc;

use evotengine::provider::MockProvider;
use evotengine::types::AgentContext;
use evotengine::*;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::fixtures::agent_harness::collect_events;
use crate::fixtures::agent_harness::make_config;
use crate::fixtures::agent_harness::MockTool;
use crate::fixtures::recording_provider::RecordingProvider;
use crate::fixtures::recording_provider::Reply;

fn history() -> Vec<AgentMessage> {
    vec![
        Message::user("Run a loop. End each pass with ScheduleWakeup.").into(),
        Message::Assistant {
            content: vec![Content::ToolCall {
                id: "wake".into(),
                name: "ScheduleWakeup".into(),
                arguments: serde_json::json!({"delay_seconds": 270}),
                metadata: None,
            }],
            stop_reason: StopReason::ToolUse,
            model: "mock".into(),
            provider: "test".into(),
            usage: Usage::default(),
            timestamp: 1,
            error_message: None,
            response_id: None,
        }
        .into(),
        Message::ToolResult {
            tool_call_id: "wake".into(),
            tool_name: "ScheduleWakeup".into(),
            content: vec![Content::Text {
                text: "Wakeup scheduled".into(),
            }],
            is_error: false,
            timestamp: 2,
            retention: Default::default(),
        }
        .into(),
    ]
}

fn context() -> AgentContext {
    AgentContext {
        system_prompt: "Follow the current user request.".into(),
        messages: history(),
        tools: vec![Box::new(MockTool::ok("Bash", "ok"))],
        cwd: std::path::PathBuf::new(),
        path_guard: Arc::new(PathGuard::open()),
        prompt_cache_key: None,
    }
}

fn availability_messages(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|message| {
            matches!(message,
        Message::User { provenance: Some(provenance), .. }
            if provenance.sources.iter().any(|source| matches!(source,
                InputSource::Runtime { kind, .. } if kind == "tool_availability")))
        })
        .count()
}

#[tokio::test]
async fn stopping_and_restarting_loop_updates_the_actual_model_request() {
    let provider = Arc::new(RecordingProvider::new(vec![Reply::text("ok"); 4]));
    let captured = provider.captured();
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider;
    let mut context = context();
    let original = context.messages.clone();

    // Active, stopped, another ordinary turn (or resumed session), restarted.
    for active in [true, false, false, true] {
        context.tools.retain(|tool| tool.name() == "Bash");
        if active {
            context.tools.push(Box::new(MockTool::ok("LoopPlan", "ok")));
            context
                .tools
                .push(Box::new(MockTool::ok("ScheduleWakeup", "ok")));
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let output = agent_loop(
            vec![Message::user("Continue my current task.").into()],
            &mut context,
            &config,
            tx,
            CancellationToken::new(),
        )
        .await;
        let events = collect_events(rx);
        let requests = captured.lock();
        let Some(request) = requests.last() else {
            panic!("missing model request");
        };
        assert_eq!(
            availability_messages(&request.messages),
            usize::from(!active)
        );
        assert_eq!(request.tools.len(), if active { 3 } else { 1 });
        assert!(events.iter().any(|event| matches!(event,
            AgentEvent::LlmCallStart { request: observed, .. }
                if observed.messages == request.messages)));
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolExecutionStart { .. })));
        assert!(output.iter().all(|message| match message {
            AgentMessage::Llm(message) => availability_messages(std::slice::from_ref(message)) == 0,
            _ => true,
        }));
    }

    // Only the model-facing projection changes. No synthetic user turns,
    // rewritten tool names, or repeated reminders are persisted in the session.
    assert_eq!(&context.messages[..original.len()], original.as_slice());
    let persisted: Vec<Message> = context
        .messages
        .iter()
        .filter_map(|m| m.as_llm().cloned())
        .collect();
    assert_eq!(availability_messages(&persisted), 0);
    assert_eq!(captured.lock().len(), 4);
}

/// Resuming mid-turn (`agent_loop_continue`, history ending in a tool result)
/// is the other way a stopped loop's history reaches the model. The reminder
/// must still be appended, after the tool result, without re-running the tool.
#[tokio::test]
async fn continuing_after_a_tool_result_still_retires_withdrawn_tools() {
    let provider = Arc::new(RecordingProvider::new(vec![Reply::text("ok")]));
    let captured = provider.captured();
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider;
    let mut context = context();
    let original = context.messages.clone();
    let (tx, rx) = mpsc::unbounded_channel();
    agent_loop_continue(&mut context, &config, tx, CancellationToken::new()).await;

    let requests = captured.lock();
    assert_eq!(requests.len(), 1);
    let sent = &requests[0].messages;
    assert_eq!(availability_messages(sent), 1);
    // Order on the wire: ..., tool result, reminder. A provider that merges
    // same-role messages then sees the tool_result block before the text.
    assert!(
        matches!(&sent[sent.len() - 2], Message::ToolResult { tool_name, .. }
        if tool_name == "ScheduleWakeup")
    );
    assert!(matches!(sent.last(), Some(Message::User { content, .. })
        if matches!(content.as_slice(), [Content::Text { text }]
            if text.contains("ScheduleWakeup") && text.contains("not declared in this run"))));
    assert_eq!(requests[0].tools.len(), 1);
    assert!(!collect_events(rx)
        .iter()
        .any(|event| matches!(event, AgentEvent::ToolExecutionStart { .. })));
    assert_eq!(&context.messages[..original.len()], original.as_slice());
}

#[tokio::test]
async fn custom_history_conversion_cannot_bypass_tool_availability_sync() {
    let provider = Arc::new(RecordingProvider::new(vec![Reply::text("ok")]));
    let captured = provider.captured();
    let mut config = make_config(MockProvider::text("unused"));
    config.provider = provider;
    config.convert_to_llm = Some(Box::new(|_| {
        history()
            .iter()
            .filter_map(|m| m.as_llm().cloned())
            .collect()
    }));
    let mut context = context();
    context.messages.clear();
    let (tx, rx) = mpsc::unbounded_channel();
    agent_loop(
        vec![Message::user("Continue.").into()],
        &mut context,
        &config,
        tx,
        CancellationToken::new(),
    )
    .await;
    let requests = captured.lock();
    assert_eq!(requests.len(), 1);
    assert_eq!(availability_messages(&requests[0].messages), 1);
    assert!(
        matches!(requests[0].messages.last(), Some(Message::User { content, .. })
        if matches!(content.as_slice(), [Content::Text { text }]
            if text.contains("ScheduleWakeup") && text.contains("no longer active")))
    );
    assert!(!collect_events(rx)
        .iter()
        .any(|event| matches!(event, AgentEvent::ToolExecutionStart { .. })));
}

/// The Anthropic request builder merges adjacent same-role messages; after
/// the merge the reminder must sit behind the tool_result block, which the
/// API requires to lead its user message.
#[test]
fn anthropic_wire_shape_keeps_tool_result_before_the_reminder() {
    use evotengine::context::tool_availability_reminder;
    use evotengine::provider::anthropic::request::build_request_body;
    use evotengine::provider::StreamConfig;

    let tools: Vec<Box<dyn AgentTool>> = vec![Box::new(MockTool::ok("Bash", "ok"))];
    let mut messages: Vec<Message> = history()
        .iter()
        .filter_map(|m| m.as_llm().cloned())
        .collect();
    let Some(reminder) = tool_availability_reminder(&messages, &tools) else {
        panic!("reminder expected");
    };
    messages.push(reminder);
    let config = StreamConfig {
        model: "claude".into(),
        system_prompt: String::new(),
        messages,
        tools: Vec::new(),
        thinking_level: ThinkingLevel::Off,
        api_key: String::new(),
        max_tokens: None,
        model_config: None,
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        client: None,
    };
    let body = build_request_body(&config, false);
    let wire = body["messages"].as_array().cloned().unwrap_or_default();
    let Some(last) = wire.last() else {
        panic!("no messages on the wire");
    };
    assert_eq!(last["role"], "user");
    let blocks = last["content"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        blocks.len(),
        2,
        "tool_result and reminder merged into one user message"
    );
    assert_eq!(blocks[0]["type"], "tool_result");
    assert_eq!(blocks[1]["type"], "text");
    assert!(blocks[1]["text"]
        .as_str()
        .unwrap_or_default()
        .contains("<system-reminder>"));
}
