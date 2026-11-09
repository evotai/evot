use std::sync::Arc;

use evotengine::context::tool_availability_reminder;
use evotengine::host::HostBridge;
use evotengine::host::HostError;
use evotengine::host::HostTool;
use evotengine::host::HostToolCall;
use evotengine::host::HostToolResponse;
use evotengine::host::HostToolSpec;
use evotengine::AgentTool;
use evotengine::Content;
use evotengine::InputSource;
use evotengine::Message;
use evotengine::StopReason;
use evotengine::ToolContext;
use evotengine::ToolError;
use evotengine::ToolResult;
use evotengine::Usage;

use crate::fixtures::agent_harness::MockTool;

fn calls(names: &[&str]) -> Message {
    Message::Assistant {
        content: names
            .iter()
            .enumerate()
            .map(|(index, name)| Content::ToolCall {
                id: format!("call-{index}"),
                name: (*name).into(),
                arguments: serde_json::json!({}),
                metadata: None,
            })
            .collect(),
        stop_reason: StopReason::ToolUse,
        model: "claude".into(),
        provider: "test".into(),
        usage: Usage::default(),
        timestamp: 1,
        error_message: None,
        response_id: None,
    }
}

fn tools(names: &[&str]) -> Vec<Box<dyn AgentTool>> {
    names
        .iter()
        .map(|name| Box::new(MockTool::ok(name, "ok")) as Box<dyn AgentTool>)
        .collect()
}

fn reminder_text(message: &Message) -> String {
    match message {
        Message::User { content, .. } => content
            .iter()
            .filter_map(|block| match block {
                Content::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect(),
        _ => panic!("expected a runtime user message"),
    }
}

#[test]
fn loop_stop_retires_historical_tools_without_changing_history() {
    let history = vec![
        Message::user("End every loop tick with ScheduleWakeup."),
        calls(&["ScheduleWakeup", "Bash", "LoopPlan", "ScheduleWakeup"]),
        Message::user("Continue the current task."),
    ];
    let original = history.clone();
    let Some(reminder) = tool_availability_reminder(&history, &tools(&["Bash"])) else {
        panic!("revoked loop tools must be explained to the model");
    };
    let text = reminder_text(&reminder);
    assert!(text.contains("[\"LoopPlan\",\"ScheduleWakeup\"]"));
    assert!(!text.contains("\"Bash\""));
    assert!(text.contains("not declared in this run"));
    // No causal claim: the same text must also fit tools this run never had.
    assert!(!text.contains("has changed"));
    assert!(text.contains("Earlier instructions"));
    assert!(text.contains("no longer active"));
    assert!(text.contains("Do not call them, emulate them"));
    assert!(text.contains("let them re-enable it"));
    assert!(
        matches!(&reminder, Message::User { provenance: Some(provenance), .. }
        if matches!(&provenance.sources[..], [InputSource::Runtime { kind, display: None }]
            if kind == "tool_availability"))
    );
    assert_eq!(history, original);
}

#[test]
fn active_or_restarted_loop_does_not_receive_a_stale_stop_reminder() {
    let history = vec![calls(&["LoopPlan", "ScheduleWakeup", "Bash"])];
    let available = tools(&["Bash", "LoopPlan", "ScheduleWakeup"]);
    assert!(tool_availability_reminder(&history, &available).is_none());
    assert!(tool_availability_reminder(&history, &tools(&["Bash"])).is_some());
    assert!(tool_availability_reminder(&history, &available).is_none());
}

#[test]
fn ordinary_text_and_tool_output_do_not_imply_a_revoked_capability() {
    let history = vec![
        Message::user("Example: ScheduleWakeup"),
        Message::ToolResult {
            tool_call_id: "old".into(),
            tool_name: "LoopPlan".into(),
            content: vec![Content::Text {
                text: "ScheduleWakeup".into(),
            }],
            is_error: false,
            timestamp: 0,
            retention: Default::default(),
        },
    ];
    assert!(tool_availability_reminder(&history, &[]).is_none());
    assert!(tool_availability_reminder(&[], &[]).is_none());
}

#[test]
fn readonly_runs_also_explain_that_past_tools_are_unavailable() {
    let Some(reminder) = tool_availability_reminder(&[calls(&["Bash", "Edit"])], &[]) else {
        panic!("empty current tool set must not authorize historical tools");
    };
    assert!(reminder_text(&reminder).contains("[\"Bash\",\"Edit\"]"));
}

struct AliasedTool;

#[async_trait::async_trait]
impl AgentTool for AliasedTool {
    fn name(&self) -> &str {
        "task_output"
    }
    fn label(&self) -> &str {
        "Task output"
    }
    fn description(&self) -> &str {
        "Read task output"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }
    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "TaskOutput".into())]
    }
    async fn execute(&self, _: serde_json::Value, _: ToolContext) -> Result<ToolResult, ToolError> {
        Err(ToolError::Cancelled)
    }
}

#[test]
fn model_aliases_and_case_changes_are_not_treated_as_tool_removal() {
    let available: Vec<Box<dyn AgentTool>> = vec![Box::new(AliasedTool)];
    let history = vec![calls(&["task_output", "TaskOutput", "TASKOUTPUT"])];
    assert!(tool_availability_reminder(&history, &available).is_none());
}

/// The loop tools are host tools built from JS specs, not engine tools: the
/// alias `LoopPlan` lives in `HostToolSpec::name_aliases` and must reach
/// `matches_call_name` through the real `HostTool` wrapper.
struct NeverCalled;

#[async_trait::async_trait]
impl HostBridge for NeverCalled {
    async fn execute_tool(&self, _: HostToolCall) -> Result<HostToolResponse, HostError> {
        Err(HostError::Closed)
    }
}

fn host_tool(name: &str, alias: &str) -> Box<dyn AgentTool> {
    let spec = HostToolSpec {
        name: name.into(),
        label: name.into(),
        description: "host tool".into(),
        parameters_schema: serde_json::json!({"type": "object"}),
        prompt_snippet: None,
        name_aliases: vec![("claude".into(), alias.into())],
        ends_turn: false,
    };
    Box::new(HostTool::new(spec, Arc::new(NeverCalled)))
}

#[test]
fn real_host_tools_match_history_by_spec_alias_and_are_retired_when_withdrawn() {
    // Claude history uses the alias spelling; GPT history uses the canonical one.
    let history = vec![calls(&["LoopPlan", "schedule_wakeup", "Bash"])];
    let mut active = tools(&["Bash"]);
    active.push(host_tool("loop_plan", "LoopPlan"));
    active.push(host_tool("schedule_wakeup", "ScheduleWakeup"));
    assert!(tool_availability_reminder(&history, &active).is_none());

    // `/loop stop` drops only the host extension; the reminder names both
    // spellings as they appear in history, nothing else.
    let Some(reminder) = tool_availability_reminder(&history, &tools(&["Bash"])) else {
        panic!("withdrawn host tools must be reported");
    };
    assert!(reminder_text(&reminder).contains("[\"LoopPlan\",\"schedule_wakeup\"]"));
}

#[test]
fn historical_names_are_quoted_as_data() {
    let Some(reminder) = tool_availability_reminder(&[calls(&["old\"\ntool"])], &[]) else {
        panic!("removed tool should be reported");
    };
    assert!(reminder_text(&reminder).contains("[\"old\\\"\\ntool\"]"));
}
