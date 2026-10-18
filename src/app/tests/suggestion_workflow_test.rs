use evot::suggestion::prompt_config;
use evot::suggestion::SuggestionEndpoint;
use evot::suggestion::SuggestionHints;
use evot::suggestion::SuggestionMessage;
use evot::suggestion::SuggestionRequest;
use evot::suggestion::SuggestionWorkflow;
use evot_engine::Content;
use evot_engine::Message;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn workflow() -> Result<Box<SuggestionWorkflow>, serde_json::Error> {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-workflow.json"
    ))?;
    request
        .into_parts()
        .1
        .workflow
        .ok_or_else(|| serde::de::Error::custom("missing workflow"))
}

fn endpoint() -> SuggestionEndpoint {
    SuggestionEndpoint {
        model: "test".into(),
        protocol: "openai".into(),
        base_url: "https://example.invalid".into(),
        api_key: "test".into(),
        context_window: 8192,
    }
}

#[test]
fn workflow_groups_depend_on_progress_not_the_resume_command() -> TestResult {
    let mut state = workflow()?;
    assert_eq!(state.intent_groups(), vec![
        "resume_recover",
        "respond",
        "advance_tasks",
        "start_redirect"
    ]);
    state.session = "active".into();
    assert_eq!(state.intent_groups()[0], "resume_recover");
    state.last_turn = "answered".into();
    assert_eq!(state.intent_groups(), vec![
        "respond",
        "advance_tasks",
        "review_follow_up",
        "start_redirect"
    ]);
    if let Some(tasks) = &mut state.tasks {
        tasks.pending = 0;
        tasks.in_progress = 0;
    }
    state.session = "resumed".into();
    assert!(!state.intent_groups().contains(&"resume_recover"));
    assert!(!state.intent_groups().contains(&"advance_tasks"));
    state.last_turn = "failed".into();
    state.runtime.execution = "running".into();
    assert_eq!(state.intent_groups()[0], "steer_wait");
    assert!(!state.recoverable());
    state.runtime.execution = "idle".into();
    state.runtime.queued_inputs = 1;
    assert_eq!(state.intent_groups()[0], "steer_wait");
    assert!(!state.recoverable());
    state.runtime.queued_inputs = 0;
    state.runtime.background_tasks = 1;
    assert!(!state.recoverable());
    Ok(())
}

#[test]
fn workflow_recovery_can_use_a_trailing_user_without_fabricating_an_assistant_answer() -> TestResult
{
    let messages = vec![SuggestionMessage {
        role: "user".into(),
        text: "Finish the migration".into(),
    }];
    let mut hints = SuggestionHints {
        workflow: Some(workflow()?),
        ..Default::default()
    };
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("missing recovery prompt")?;
    assert_eq!(config.messages.len(), 2);
    assert!(matches!(
        config.messages.first(),
        Some(Message::User { .. })
    ));
    let instruction = match config.messages.last() {
        Some(Message::User { content, .. }) => content.iter().find_map(|block| match block {
            Content::Text { text } => Some(text),
            _ => None,
        }),
        _ => None,
    }
    .ok_or("missing instruction")?;
    assert!(instruction.contains("resume_recover, respond, advance_tasks"));
    assert!(instruction.contains("Restoration alone is NOT evidence"));
    assert!(instruction.contains("A typed draft always wins"));
    assert!(instruction.contains("historical tool calls never prove a process is still running"));
    if let Some(state) = &mut hints.workflow {
        state.last_turn = "answered".into();
    }
    assert!(prompt_config(&endpoint(), &messages, &hints).is_none());
    assert!(prompt_config(&endpoint(), &[], &SuggestionHints {
        workflow: Some(workflow()?),
        ..Default::default()
    })
    .is_none());
    Ok(())
}

#[test]
fn workflow_request_preserves_legacy_fields_and_rejects_future_versions() -> TestResult {
    #[derive(serde::Deserialize)]
    struct LegacyRequest {
        messages: Vec<SuggestionMessage>,
        draft: Option<String>,
        rejected: Vec<String>,
    }
    let source = include_str!("fixtures/schema/suggestion-request-workflow.json");
    let current: SuggestionRequest = serde_json::from_str(source)?;
    let legacy: LegacyRequest = serde_json::from_str(&serde_json::to_string(&current)?)?;
    assert_eq!(legacy.messages.len(), 1);
    assert!(legacy.draft.is_none());
    assert!(legacy.rejected.is_empty());
    for old in [
        include_str!("fixtures/schema/suggestion-request-legacy.json"),
        include_str!("fixtures/schema/suggestion-request-explicit.json"),
        include_str!("fixtures/schema/suggestion-request-activity.json"),
    ] {
        let request: SuggestionRequest = serde_json::from_str(old)?;
        assert!(request.into_parts().1.workflow.is_none());
    }
    let mut future: serde_json::Value = serde_json::from_str(source)?;
    future["workflow"]["schema_version"] = 2.into();
    if let Err(error) = serde_json::from_value::<SuggestionRequest>(future) {
        assert!(error
            .to_string()
            .contains("unsupported suggestion workflow schema version: 2"));
    } else {
        return Err("future workflow schema accepted".into());
    }
    Ok(())
}

#[test]
fn execution_after_prose_outweighs_an_old_proposal_but_not_a_new_question() -> TestResult {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-execution.json"
    ))?;
    let (messages, mut hints) = request.into_parts();
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    assert_eq!(state.intent_groups(), vec![
        "resume_recover",
        "start_redirect"
    ]);
    let instruction = state.instruction().ok_or("no instructions")?;
    assert!(instruction.contains("EXECUTION CHRONOLOGY"));
    assert!(instruction.contains("not a fresh request to approve work already performed"));
    assert!(instruction.contains("Inspect the remaining layout mismatch"));
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    state
        .progress
        .as_mut()
        .ok_or("missing progress")?
        .awaiting_input = true;
    assert!(state.intent_groups().contains(&"respond"));
    assert!(!state
        .instruction()
        .ok_or("no instructions")?
        .contains("EXECUTION CHRONOLOGY"));
    let progress = state.progress.as_mut().ok_or("missing progress")?;
    progress.awaiting_input = false;
    progress.since_last_reply = 0;
    state.last_turn = "answered".into();
    assert_eq!(state.intent_groups(), vec![
        "close",
        "respond",
        "review_follow_up",
        "start_redirect"
    ]);
    Ok(())
}

#[test]
fn progress_is_an_additive_contract_and_its_metadata_is_bounded() -> TestResult {
    #[derive(serde::Deserialize)]
    struct LegacyWorkflow {
        schema_version: u8,
        session: String,
        last_turn: String,
        pending_tools: usize,
    }
    let old = workflow()?;
    assert!(old.progress.is_none());
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-execution.json"
    ))?;
    let mut current = request.into_parts().1.workflow.ok_or("missing workflow")?;
    let legacy: LegacyWorkflow = serde_json::from_value(serde_json::to_value(&current)?)?;
    assert_eq!(legacy.schema_version, 1);
    assert_eq!(legacy.session, "resumed");
    assert_eq!(legacy.last_turn, "interrupted");
    assert_eq!(legacy.pending_tools, 0);
    let progress = current.progress.as_mut().ok_or("no progress")?;
    progress.recent = vec![
        evot::suggestion::SuggestionTool {
            name: "x".repeat(1000),
            status: "completed".into(),
            description: Some("y".repeat(1000))
        };
        100
    ];
    let instruction = current.instruction().ok_or("no instructions")?;
    assert!(!instruction.contains(&"x".repeat(81)));
    assert!(!instruction.contains(&"y".repeat(161)));
    assert!(instruction.len() < 5500);
    Ok(())
}

#[test]
fn structured_runtime_is_authoritative_over_legacy_activity() -> TestResult {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-execution.json"
    ))?;
    let (messages, mut hints) = request.into_parts();
    hints.activity = Some("waiting".into());
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("no prompt")?;
    let instructions = match config.messages.last() {
        Some(Message::User { content, .. }) => content.iter().find_map(|block| match block {
            Content::Text { text } => Some(text),
            _ => None,
        }),
        _ => None,
    }
    .ok_or("missing instruction")?;
    assert!(!instructions.contains("Current task state: waiting"));
    assert!(instructions.contains("resume_recover"));
    Ok(())
}

#[test]
fn active_work_targets_live_tasks_not_restart_or_unrelated_followups() -> TestResult {
    let source = include_str!("fixtures/schema/suggestion-request-active-work.json");
    let request: SuggestionRequest = serde_json::from_str(source)?;
    let (messages, mut hints) = request.into_parts();
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    assert_eq!(state.intent_groups(), vec!["steer_wait", "respond"]);
    assert!(!state.recoverable());
    let prompt = state.instruction().ok_or("missing prompt")?;
    assert!(prompt.contains("WORK IN FLIGHT"));
    assert!(prompt.contains("Run focused authentication tests"));
    assert!(prompt.contains("Waiting for a new CI result"));
    assert!(prompt.contains("No output and unchanged iterations alone do not prove"));
    assert!(prompt.contains("not an abandoned task to restart"));
    assert!(prompt.contains("not invented answers about progress"));
    state.runtime.execution = "idle".into();
    state.runtime.background_tasks = 0;
    assert_eq!(state.intent_groups()[0], "steer_wait"); // structured activities override legacy counters
    state.runtime.activities.clear();
    assert_eq!(state.intent_groups(), vec![
        "close",
        "respond",
        "review_follow_up",
        "start_redirect"
    ]);
    hints.draft = Some("Instead, explain the new design".into());
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
    Ok(())
}

#[test]
fn active_work_is_an_optional_addition_to_the_existing_workflow_schema() -> TestResult {
    #[derive(serde::Deserialize)]
    struct LegacyRuntime {
        execution: String,
        mode: String,
        queued_inputs: usize,
        background_tasks: usize,
    }
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-active-work.json"
    ))?;
    let mut state = request.into_parts().1.workflow.ok_or("missing workflow")?;
    let legacy: LegacyRuntime = serde_json::from_value(serde_json::to_value(&state.runtime)?)?;
    assert_eq!(legacy.execution, "waiting");
    assert_eq!(legacy.mode, "normal");
    assert_eq!(legacy.queued_inputs, 0);
    assert_eq!(legacy.background_tasks, 1);
    assert!(workflow()?.runtime.activities.is_empty());
    let activity = state
        .runtime
        .activities
        .first()
        .ok_or("missing activity")?
        .clone();
    state.runtime.activities = vec![activity; 100];
    for activity in &mut state.runtime.activities {
        activity.goal = Some("x".repeat(10000));
    }
    let prompt = state.instruction().ok_or("missing prompt")?;
    assert!(!prompt.contains(&"x".repeat(121)));
    assert!(prompt.len() < 9000);
    Ok(())
}

#[test]
fn closing_intent_checks_for_real_open_work_without_reasking_completed_requirements() -> TestResult
{
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-closed.json"
    ))?;
    let (messages, mut hints) = request.into_parts();
    let state = hints.workflow.as_ref().ok_or("no workflow")?;
    assert_eq!(state.intent_groups()[0], "close");
    let instruction = state.instruction().ok_or("no instruction")?;
    assert!(instruction.contains("return no candidates"));
    assert!(instruction.contains("Never ask the assistant to reconfirm"));
    assert!(messages
        .last()
        .is_some_and(|message| message.text.contains("227 tests passed")));
    assert!(prompt_config(&endpoint(), &messages, &hints).is_none());
    for (turn, execution, pending, input) in [
        ("interrupted", "idle", 0, false),
        ("answered", "running", 0, false),
        ("answered", "idle", 1, false),
        ("answered", "idle", 0, true),
    ] {
        let state = hints.workflow.as_mut().ok_or("no workflow")?;
        state.last_turn = turn.into();
        state.runtime.execution = execution.into();
        state.pending_tools = pending;
        state.progress.as_mut().ok_or("no progress")?.awaiting_input = input;
        assert!(!state.intent_groups().contains(&"close"));
    }
    Ok(())
}

#[test]
fn closure_is_conservative_but_keeps_real_questions_drafts_and_unfinished_work() -> TestResult {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-closed.json"
    ))?;
    let (mut messages, mut hints) = request.into_parts();
    for answer in [
        "Implemented and tested. Reload the extension to use it.",
        "All tests pass. Usage: `canStartImmediately()?`.",
        "Example:\n```text\nCan it update immediately?\n```\nThe fix is complete.",
        "> Can it update immediately?\nYes, that behavior is implemented and tested.",
    ] {
        if let Some(last) = messages.last_mut() {
            last.text = answer.into();
        }
        assert!(
            prompt_config(&endpoint(), &messages, &hints).is_none(),
            "{answer}"
        );
    }
    for question in [
        "Do you want to review the diff or commit?",
        "Which target should I deploy to?\nI will wait for your choice.",
        "Choose a validation scope:\n- Run the unit tests?\n- Run the integration tests?",
    ] {
        if let Some(last) = messages.last_mut() {
            last.text = question.into();
        }
        assert!(
            prompt_config(&endpoint(), &messages, &hints).is_some(),
            "{question}"
        );
    }
    if let Some(last) = messages.last_mut() {
        last.text = "All work is delivered and tested.".into();
    }
    hints.draft = Some("Explain the change ".into());
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
    hints.draft = None;
    let state = hints.workflow.as_mut().ok_or("no workflow")?;
    state.pending_tools = 1;
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
    let state = hints.workflow.as_mut().ok_or("no workflow")?;
    state.pending_tools = 0;
    state.last_turn = "interrupted".into();
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
    Ok(())
}

#[test]
fn workflow_direct_callers_have_bounded_task_evidence() -> TestResult {
    let mut state = workflow()?;
    if let Some(tasks) = &mut state.tasks {
        tasks.next = vec![
            evot::suggestion::SuggestionTask {
                text: "x".repeat(10000),
                status: "pending".into()
            };
            100
        ];
    }
    let instruction = state.instruction().ok_or("missing instruction")?;
    assert!(instruction.len() < 4000);
    assert!(!instruction.contains(&"x".repeat(121)));
    Ok(())
}
