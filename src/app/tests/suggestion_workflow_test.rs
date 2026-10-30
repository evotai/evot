use evot::suggestion::prompt_config;
use evot::suggestion::SuggestionHints;
use evot::suggestion::SuggestionMessage;
use evot::suggestion::SuggestionModel;
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

fn endpoint() -> SuggestionModel {
    SuggestionModel {
        route: evot::suggestion::SuggestionRoute::Cloud,
        config: evot::conf::resolve_model_config(
            evot::conf::Protocol::OpenAi,
            "evot-suggestion",
            "test",
            Some("https://example.invalid"),
            Default::default(),
            Default::default(),
            Some(8192),
            None,
            Some(true),
        ),
        api_key: "test".into(),
    }
}

fn workflow_facts(instruction: &str) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    instruction
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| "missing workflow facts".into())
}

#[test]
fn workflow_recovery_depends_on_observed_progress_not_the_resume_command() -> TestResult {
    let mut state = workflow()?;
    assert!(state.recoverable());
    state.session = "active".into();
    assert!(state.recoverable());
    state.last_turn = "answered".into();
    assert!(!state.recoverable());
    state.session = "resumed".into();
    assert!(!state.recoverable());
    assert_eq!(
        workflow_facts(&state.instruction().ok_or("no facts")?)?,
        serde_json::to_value(&state)?
    );
    state.last_turn = "failed".into();
    state.runtime.execution = "running".into();
    assert!(!state.recoverable());
    state.runtime.execution = "idle".into();
    state.runtime.queued_inputs = 1;
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
    assert_eq!(
        workflow_facts(instruction)?,
        serde_json::to_value(&hints.workflow)?
    );
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
fn automatic_tool_wait_can_use_a_user_goal_without_a_final_assistant_answer() -> TestResult {
    let messages = vec![SuggestionMessage {
        role: "user".into(),
        text: "Run the benchmark and report the results".into(),
    }];
    let mut state = workflow()?;
    state.session = "active".into();
    state.last_turn = "unfinished".into();
    state.pending_tools = 1;
    state.runtime.execution = "waiting".into();
    state.runtime.background_tasks = 1;
    let mut hints = SuggestionHints {
        workflow: Some(state),
        ..Default::default()
    };
    assert!(!hints.is_explicit());
    let config = prompt_config(&endpoint(), &messages, &hints).ok_or("missing tool wait prompt")?;
    // Keep the actual user goal plus the prediction instruction, not a fabricated answer.
    assert_eq!(config.messages.len(), 2);
    assert!(config
        .messages
        .iter()
        .all(|message| matches!(message, Message::User { .. })));
    let instruction = match config.messages.last() {
        Some(Message::User { content, .. }) => content.iter().find_map(|block| match block {
            Content::Text { text } => Some(text),
            _ => None,
        }),
        _ => None,
    }
    .ok_or("missing instruction")?;
    assert_eq!(
        workflow_facts(instruction)?,
        serde_json::to_value(&hints.workflow)?
    );
    assert!(prompt_config(&endpoint(), &[], &hints).is_none());
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    state.runtime.execution = "running".into();
    assert!(prompt_config(&endpoint(), &messages, &hints).is_none());
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    state.runtime.execution = "waiting".into();
    state.pending_tools = 0;
    assert!(prompt_config(&endpoint(), &messages, &hints).is_none());
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
    let instruction = state.instruction().ok_or("no instructions")?;
    let facts = workflow_facts(&instruction)?;
    assert_eq!(facts, serde_json::to_value(&state)?);
    assert_eq!(facts["progress"]["since_last_reply"], 3);
    assert_eq!(facts["progress"]["awaiting_input"], false);
    assert_eq!(
        facts["progress"]["recent"][2]["description"],
        "Inspect the remaining layout mismatch"
    );
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    state
        .progress
        .as_mut()
        .ok_or("missing progress")?
        .awaiting_input = true;
    assert_eq!(
        workflow_facts(&state.instruction().ok_or("no instructions")?)?["progress"]
            ["awaiting_input"],
        true
    );
    let progress = state.progress.as_mut().ok_or("missing progress")?;
    progress.awaiting_input = false;
    progress.since_last_reply = 0;
    state.last_turn = "answered".into();
    assert_eq!(
        workflow_facts(&state.instruction().ok_or("no instructions")?)?["progress"]
            ["since_last_reply"],
        0
    );
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
    assert_eq!(
        workflow_facts(instructions)?,
        serde_json::to_value(&hints.workflow)?
    );
    Ok(())
}

#[test]
fn active_work_targets_live_tasks_not_restart_or_unrelated_followups() -> TestResult {
    let source = include_str!("fixtures/schema/suggestion-request-active-work.json");
    let request: SuggestionRequest = serde_json::from_str(source)?;
    let (messages, mut hints) = request.into_parts();
    let state = hints.workflow.as_mut().ok_or("missing workflow")?;
    assert!(!state.recoverable());
    let facts = workflow_facts(&state.instruction().ok_or("missing prompt")?)?;
    assert_eq!(facts, serde_json::to_value(&state)?);
    assert_eq!(
        facts["runtime"]["activities"][0]["goal"],
        "Run focused authentication tests"
    );
    assert_eq!(
        facts["runtime"]["activities"][1]["wait_reason"],
        "Waiting for a new CI result"
    );
    state.runtime.execution = "idle".into();
    state.runtime.background_tasks = 0;
    state.last_turn = "interrupted".into();
    assert!(!state.recoverable()); // Live activities override legacy counters.
    state.runtime.activities.clear();
    assert!(state.recoverable());
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
fn answered_turns_require_semantic_assessment_not_a_completion_assumption() -> TestResult {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-closed.json"
    ))?;
    let (messages, mut hints) = request.into_parts();
    let state = hints.workflow.as_ref().ok_or("no workflow")?;
    let instruction = state.instruction().ok_or("no instruction")?;
    assert_eq!(workflow_facts(&instruction)?, serde_json::to_value(state)?);
    assert!(!instruction.contains("INTENT GROUPS"));
    assert!(messages
        .last()
        .is_some_and(|message| message.text.contains("227 tests passed")));
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());
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
        assert_eq!(
            workflow_facts(&state.instruction().ok_or("no facts")?)?,
            serde_json::to_value(&state)?
        );
    }
    Ok(())
}

#[test]
fn punctuation_is_not_an_eligibility_rule_for_contextual_suggestions() -> TestResult {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-closed.json"
    ))?;
    let (mut messages, mut hints) = request.into_parts();
    for answer in [
        "Implemented and tested. Reload the extension to use it.",
        "All tests pass. Usage: `canStartImmediately()?`.",
        "Example:\n```text\nCan it update immediately?\n```\nThe fix is complete.",
        "> Can it update immediately?\nYes, that behavior is implemented and tested.",
        "The image build has started. Its tag will be posted when it completes.",
        "The report identifies two remaining changes before the rollout can proceed.",
    ] {
        if let Some(last) = messages.last_mut() {
            last.text = answer.into();
        }
        assert!(
            prompt_config(&endpoint(), &messages, &hints).is_some(),
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

#[tokio::test]
async fn remote_work_can_generate_while_completed_work_can_abstain() -> TestResult {
    use std::sync::Arc;

    use evot::suggestion::sample_outcome;
    use evot::suggestion::SuggestionStatus;
    use evot_engine::provider::MockProvider;
    use tokio_util::sync::CancellationToken;
    let pending: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-external-work.json"
    ))?;
    let (messages, hints) = pending.into_parts();
    let state = hints.workflow.as_ref().ok_or("no workflow")?;
    assert_eq!(state.runtime.execution, "idle");
    assert_eq!(state.pending_tools, 0);
    let config =
        prompt_config(&endpoint(), &messages, &hints).ok_or("remote work was suppressed")?;
    assert_eq!(config.messages.len(), messages.len() + 1);
    let outcome = sample_outcome(
        &endpoint(),
        &messages,
        &hints,
        Arc::new(MockProvider::text(
            r#"["Check the image build progress","Show the resulting image tag"]"#,
        )),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.status, SuggestionStatus::Ready);
    assert_eq!(outcome.candidates, vec![
        "Check the image build progress",
        "Show the resulting image tag"
    ]);
    let closed: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-closed.json"
    ))?;
    let (messages, mut hints) = closed.into_parts();
    for explicit in [true, false] {
        hints.explicit = explicit;
        hints.suffix = explicit.then(String::new);
        let outcome = sample_outcome(
            &endpoint(),
            &messages,
            &hints,
            Arc::new(MockProvider::text("[]")),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome.status, SuggestionStatus::Empty);
        assert!(outcome.candidates.is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn ready_handoffs_are_new_intentions_not_unfinished_tasks() -> TestResult {
    use std::sync::Arc;

    use evot::suggestion::sample_outcome;
    use evot::suggestion::SuggestionStatus;
    use evot_engine::provider::MockProvider;
    use tokio_util::sync::CancellationToken;

    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-handoff.json"
    ))?;
    let (messages, mut hints) = request.into_parts();
    let state = hints.workflow.as_ref().ok_or("no workflow")?;
    assert_eq!(state.last_turn, "answered");
    assert_eq!(state.runtime.execution, "idle");
    assert!(!state.recoverable());
    assert_eq!(state.pending_tools, 0);
    assert!(state.tasks.is_none());
    for explicit in [true, false] {
        hints.explicit = explicit;
        hints.suffix = explicit.then(String::new);
        let config = prompt_config(&endpoint(), &messages, &hints).ok_or("handoff suppressed")?;
        assert_eq!(config.messages.len(), messages.len() + 1);
        let response = if explicit {
            r#"["Commit the documentation changes","Commit and push the changes"]"#
        } else {
            "Commit the documentation changes\nCommit and push the changes"
        };
        let outcome = sample_outcome(
            &endpoint(),
            &messages,
            &hints,
            Arc::new(MockProvider::text(response)),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome.status, SuggestionStatus::Ready);
        assert_eq!(outcome.candidates, vec![
            "Commit the documentation changes",
            "Commit and push the changes"
        ]);
    }
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

#[test]
fn stage_is_derived_from_runtime_facts_in_priority_order() -> TestResult {
    let mut state = workflow()?;
    assert_eq!(state.stage(), "recovering");
    state.last_turn = "answered".into();
    assert_eq!(state.stage(), "answered");
    state.last_turn = "none".into();
    assert_eq!(state.stage(), "fresh");
    state.last_turn = "answered".into();
    state.progress = Some(evot::suggestion::SuggestionProgress {
        calls: 1,
        executed: 1,
        completed: 0,
        failed: 0,
        since_last_reply: 0,
        awaiting_input: true,
        recent: Vec::new(),
    });
    assert_eq!(state.stage(), "awaiting_input");
    state.runtime.queued_inputs = 1;
    assert_eq!(state.stage(), "queued");
    state.runtime.execution = "running".into();
    assert_eq!(state.stage(), "foreground_running");
    state.runtime.background_tasks = 1;
    assert_eq!(state.stage(), "background");
    state
        .runtime
        .activities
        .push(evot::suggestion::SuggestionActivity {
            kind: "loop".into(),
            id: "loop:1".into(),
            phase: "waiting".into(),
            goal: None,
            elapsed_minutes: None,
            quiet_minutes: None,
            iteration: Some(2),
            cadence: None,
            interval_ms: None,
            next_check_at: None,
            wait_reason: None,
            unchanged_iterations: None,
        });
    assert_eq!(state.stage(), "loop");
    // A finished loop entry is history, not a stage.
    if let Some(activity) = state.runtime.activities.last_mut() {
        activity.phase = "finished".into();
    }
    assert_eq!(state.stage(), "background");
    Ok(())
}

#[test]
fn thread_index_is_rendered_bounded_and_kept_out_of_the_json_facts() -> TestResult {
    let request: SuggestionRequest = serde_json::from_str(include_str!(
        "fixtures/schema/suggestion-request-thread.json"
    ))?;
    let (messages, hints) = request.into_parts();
    let state = hints.workflow.as_ref().ok_or("no workflow")?;
    assert_eq!(state.thread.len(), 6);
    assert_eq!(state.stage(), "answered");
    let instruction = state.instruction().ok_or("no instruction")?;
    assert!(instruction.contains("TRAJECTORY"));
    assert!(instruction.contains("1. \u{2192} user: \"Add a size limit to the uploader.\""));
    assert!(instruction.contains("6. [answered] after \"Diff shown.\" \u{2192} user: \"Commit.\""));
    assert!(instruction.contains("RUNTIME LIMITS (step 3; they restrict, never redirect)"));
    assert!(instruction.contains("CURRENT STAGE: answered"));
    assert!(instruction
        .contains("no runtime limit applies, the reply type and the conversation decide"));
    // Runtime facts come after the trajectory: they limit, they do not anchor.
    assert!(instruction.find("TRAJECTORY") < instruction.find("RUNTIME LIMITS"));
    let facts = workflow_facts(&instruction)?;
    assert!(facts.get("thread").is_none());
    assert_eq!(facts["last_turn"], "answered");
    assert!(prompt_config(&endpoint(), &messages, &hints).is_some());

    // Oversized direct-caller input is bounded, not rejected.
    let mut big = state.clone();
    big.thread = (0..200)
        .map(|index| evot::suggestion::SuggestionExchange {
            user: format!("{index} {}", "u".repeat(5_000)),
            assistant: Some("a".repeat(5_000)),
            tools: 1,
            failed: 1,
            outcome: "x".repeat(500),
            from: None,
        })
        .collect();
    let bounded = big.instruction().ok_or("no instruction")?;
    assert!(bounded.len() < 20_000);
    assert!(bounded.contains("1. \u{2192} user: \"0 "));
    assert!(bounded.contains("[... 176 earlier steps omitted ...]"));
    assert!(bounded.contains("178. \u{2192} user: \"177 "));
    assert!(bounded.contains("200. \u{2192} user: \"199 "));
    assert!(!bounded.contains("2. \u{2192} user: \"1 "));
    Ok(())
}

#[test]
fn thread_is_additive_and_legacy_readers_ignore_it() -> TestResult {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyRuntime {
        execution: String,
        mode: String,
        queued_inputs: usize,
        background_tasks: usize,
    }
    #[derive(serde::Deserialize)]
    struct LegacyWorkflow {
        schema_version: u8,
        session: String,
        last_turn: String,
        runtime: LegacyRuntime,
    }
    let source = include_str!("fixtures/schema/suggestion-request-thread.json");
    let request: SuggestionRequest = serde_json::from_str(source)?;
    let written = serde_json::to_value(&request)?;
    let legacy: LegacyWorkflow = serde_json::from_value(written["workflow"].clone())?;
    assert_eq!(legacy.schema_version, 1);
    assert_eq!(legacy.session, "resumed");
    assert_eq!(legacy.last_turn, "answered");
    assert_eq!(legacy.runtime.execution, "idle");
    assert_eq!(legacy.runtime.mode, "normal");
    assert_eq!(legacy.runtime.queued_inputs, 0);
    assert_eq!(legacy.runtime.background_tasks, 0);
    assert_eq!(
        written["workflow"]["thread"].as_array().map(Vec::len),
        Some(6)
    );
    // Old writers without a thread still parse and render.
    let old = workflow()?;
    assert!(old.thread.is_empty());
    let value = serde_json::to_value(&old)?;
    assert!(value.get("thread").is_none());
    assert!(!old
        .instruction()
        .ok_or("no instruction")?
        .contains("SESSION THREAD"));
    Ok(())
}

#[test]
fn trajectory_steps_carry_origin_state_and_stay_additive() -> TestResult {
    let source = include_str!("fixtures/schema/suggestion-request-thread.json");
    let request: SuggestionRequest = serde_json::from_str(source)?;
    let (_, hints) = request.into_parts();
    let state = hints.workflow.as_ref().ok_or("no workflow")?;
    // Mixed: older writers omit `from`; newer ones include it.
    assert!(state.thread[0].from.is_none());
    let last = state
        .thread
        .last()
        .and_then(|step| step.from.as_ref())
        .ok_or("no origin")?;
    assert_eq!(last.stage, "answered");
    assert_eq!(last.reply.as_deref(), Some("Diff shown."));
    let instruction = state.instruction().ok_or("no instruction")?;
    assert!(instruction.contains("[answered] after \"Diff shown.\" \u{2192} user: \"Commit.\""));
    assert!(instruction.contains("[recovering] \u{2192} user: \"Diff please.\""));
    // Strict legacy reader of a step without `from` still works on current output.
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyStep {
        user: String,
        assistant: Option<String>,
        tools: usize,
        failed: usize,
        outcome: String,
    }
    let written = serde_json::to_value(&state.thread[0])?;
    let legacy: LegacyStep = serde_json::from_value(written)?;
    assert_eq!(legacy.user, "Add a size limit to the uploader.");
    assert_eq!(legacy.tools, 4);
    assert!(legacy.assistant.is_some());
    assert_eq!(legacy.failed, 0);
    assert_eq!(legacy.outcome, "answered");
    Ok(())
}
