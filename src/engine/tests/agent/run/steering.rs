//! Steering behavior: user messages injected mid-run and their accounting
//! in `LlmCallStart`.

use evotengine::agent::QueueMode;
use evotengine::provider::mock::*;
use evotengine::types::AgentContext;
use evotengine::*;

use super::common::ProgressTool;
use crate::fixtures::agent_harness::make_config;
use crate::fixtures::agent_harness::TestHarness;

#[tokio::test]
async fn follow_ups_wait_for_all_tools_and_enter_context_one_at_a_time() {
    use std::sync::Arc;
    let tool = || {
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "progress_tool".into(),
            arguments: serde_json::json!({}),
        }])
    };
    let mut config = make_config(MockProvider::new(vec![
        tool(),
        tool(),
        MockResponse::Text("A complete".into()),
        MockResponse::Text("B complete".into()),
        MockResponse::Text("C complete".into()),
    ]));
    let queue = PromptQueue::new();
    queue.enqueue(AgentMessage::Llm(Message::user("queue-B")));
    queue.enqueue(AgentMessage::Llm(Message::user("queue-C")));
    config.get_follow_up_messages = Some(Box::new(move || {
        queue.drain_messages(QueueMode::OneAtATime)
    }));
    let requests = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let recorded = requests.clone();
    config.before_turn = Some(Arc::new(move |messages, _| {
        recorded.lock().push(
            messages
                .iter()
                .filter_map(|message| match message {
                    AgentMessage::Llm(Message::User { content, .. }) => Some(
                        content
                            .iter()
                            .filter_map(|part| match part {
                                Content::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    _ => None,
                })
                .collect::<Vec<_>>(),
        );
        true
    }));
    let mut context = AgentContext {
        system_prompt: "fixture".into(),
        messages: Vec::new(),
        tools: vec![Box::new(ProgressTool)],
        cwd: std::path::PathBuf::new(),
        path_guard: Arc::new(PathGuard::open()),
        prompt_cache_key: None,
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    agent_loop(
        vec![AgentMessage::Llm(Message::user("queue-A"))],
        &mut context,
        &config,
        tx,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;
    assert_eq!(*requests.lock(), vec![
        vec!["queue-A"],
        vec!["queue-A"],
        vec!["queue-A"],
        vec!["queue-A", "queue-B"],
        vec!["queue-A", "queue-B", "queue-C"],
    ]);
}

// ---------------------------------------------------------------------------
// Steering tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_steering_messages_injected_into_context() {
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("I see your steering.".into())])
        .steering(vec![AgentMessage::Llm(Message::user("change direction"))])
        .run("Hi")
        .await;

    output.assert_completed();

    // Context should contain: steering msg + user prompt + assistant response
    let user_msgs: Vec<_> = output
        .context_messages
        .iter()
        .filter(|m| m.role() == "user")
        .collect();
    assert_eq!(
        user_msgs.len(),
        2,
        "Expected steering + prompt user messages"
    );
}

#[tokio::test]
async fn test_steering_count_reported_in_llm_call_start() {
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("Got it.".into())])
        .steering(vec![
            AgentMessage::Llm(Message::user("steer 1")),
            AgentMessage::Llm(Message::user("steer 2")),
        ])
        .run("Hi")
        .await;

    output.assert_completed();

    let counts = output.injected_counts();
    assert!(!counts.is_empty(), "Expected at least one LlmCallStart");
    assert_eq!(counts[0], 2, "Expected 2 injected messages");
}

#[tokio::test]
async fn test_no_steering_reports_zero() {
    let output = TestHarness::new()
        .responses(vec![MockResponse::Text("Hello.".into())])
        .run("Hi")
        .await;

    output.assert_completed();

    let counts = output.injected_counts();
    assert!(!counts.is_empty());
    assert_eq!(counts[0], 0, "Expected 0 injected messages");
}

// ---------------------------------------------------------------------------
// Follow-up delivery — the path background completion notices travel
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_follow_up_message_is_answered_inside_the_same_run() {
    // Completion notices for background tasks are appended to whatever the
    // follow-up queue returns, so this is the path they travel. It fires after
    // the model stops calling tools but before the run settles, which is what
    // makes "carry on, the result will reach you" true: the notice continues the
    // current run rather than waiting for a new one.
    //
    // Two responses, one prompt: a second provider call only happens if the
    // follow-up reopened the run.
    let output = TestHarness::new()
        .responses(vec![
            MockResponse::Text("Started the build.".into()),
            MockResponse::Text("Build finished, carrying on.".into()),
        ])
        .follow_up(vec![AgentMessage::Llm(Message::user(
            "<task-notification><task-id>abc</task-id><status>completed</status></task-notification>",
        ))])
        .run("Run the build")
        .await;

    output.assert_completed();

    let user_texts: Vec<String> = output
        .context_messages
        .iter()
        .filter(|m| m.role() == "user")
        .map(|m| format!("{m:?}"))
        .collect();
    assert!(
        user_texts
            .iter()
            .any(|text| text.contains("task-notification")),
        "notice never reached the context: {user_texts:?}"
    );

    // The model answered after receiving it, rather than the run ending first.
    let assistant_count = output
        .context_messages
        .iter()
        .filter(|m| m.role() == "assistant")
        .count();
    assert_eq!(
        assistant_count, 2,
        "expected a second turn prompted by the follow-up"
    );
}
