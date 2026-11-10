//! Background tasks announced by a previous evot process must be called out
//! once, so a resumed session stops reporting dead watchers as running.

use evot::agent::orphaned_tasks::announced_tasks;
use evot::agent::orphaned_tasks::orphan_notice;
use evot::agent::orphaned_tasks::orphaned_tasks;
use evot::agent::orphaned_tasks::AnnouncedTask;
use evot_engine::tools::ProcessManager;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::Message;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn bash_result(text: &str) -> AgentMessage {
    tool_result("Bash", text)
}

fn tool_result(tool_name: &str, text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::ToolResult {
        tool_call_id: "call".into(),
        tool_name: tool_name.into(),
        content: vec![Content::Text { text: text.into() }],
        is_error: false,
        timestamp: 0,
        retention: Default::default(),
    })
}

/// The exact shape `bash.rs::background_result` writes.
fn announcement(task_id: &str, description: Option<&str>) -> String {
    let purpose = description
        .map(|d| format!("Task: {d}\n"))
        .unwrap_or_default();
    format!(
        "Command is running in the background.\n{purpose}Task ID: {task_id}\nOutput: /tmp/out/{task_id}.log\nYou will be notified when it completes."
    )
}

#[test]
fn announcements_are_parsed_from_bash_results_only() {
    let messages = vec![
        AgentMessage::Llm(Message::user("watch the PR")),
        bash_result(&announcement(
            "96e7d776-111d-49b0-a11f-8e112f3759ce",
            Some("等待人工评审、新评论、合并或新线程"),
        )),
        bash_result(&announcement("4d2de14b-0000-0000-0000-000000000000", None)),
        // The same task mentioned again, and by another tool: not a new announcement.
        bash_result(&announcement(
            "96e7d776-111d-49b0-a11f-8e112f3759ce",
            Some("duplicate"),
        )),
        tool_result(
            "task_output",
            &announcement("deadbeef-0000-0000-0000-000000000000", None),
        ),
        // Prose quoting an id, and a result missing the Output line, are ignored.
        bash_result("Task ID: cafebabe-0000-0000-0000-000000000000 was mentioned in a log"),
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::Text {
                text: "Task ID: 11111111-0000-0000-0000-000000000000\nOutput: nope".into(),
            }],
            stop_reason: evot_engine::StopReason::Stop,
            model: String::new(),
            provider: String::new(),
            usage: Default::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }),
    ];
    assert_eq!(announced_tasks(&messages), vec![
        AnnouncedTask {
            task_id: "96e7d776-111d-49b0-a11f-8e112f3759ce".into(),
            description: Some("等待人工评审、新评论、合并或新线程".into()),
        },
        AnnouncedTask {
            task_id: "4d2de14b-0000-0000-0000-000000000000".into(),
            description: None,
        },
    ]);
}

fn notification(task_id: &str, status: &str) -> String {
    format!(
        "<task-notification>\n<task-id>{task_id}</task-id>\n<status>{status}</status>\n<summary>Task done</summary>\n<output-file>/tmp/{task_id}.log</output-file>\n</task-notification>"
    )
}

fn user(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::user(text))
}

#[test]
fn tasks_the_transcript_saw_end_are_not_orphans() {
    // Four announced tasks; three reach a terminal state through each of the
    // channels the transcript can carry, one never does.
    let messages = vec![
        bash_result(&announcement("aaaaaaaa-1", Some("clippy"))),
        bash_result(&announcement("bbbbbbbb-2", Some("tests"))),
        bash_result(&announcement("cccccccc-3", Some("export"))),
        bash_result(&announcement("dddddddd-4", Some("PR watcher"))),
        // Completion notices are appended to the next user turn, possibly
        // several in one text, possibly alongside the user's own words.
        user(&format!(
            "status?\n{}\n{}",
            notification("aaaaaaaa-1", "completed"),
            notification("bbbbbbbb-2", "failed")
        )),
        // A task_output read that found the task already finished.
        tool_result(
            "task_output",
            "Task ID: cccccccc-3\nStatus: completed\nOutput file: /tmp/c.log\nExit code: 0\n\nall good",
        ),
    ];
    let ids: Vec<_> = announced_tasks(&messages)
        .into_iter()
        .map(|task| task.task_id)
        .collect();
    assert_eq!(ids, vec!["dddddddd-4"]);
}

#[test]
fn a_stop_result_ends_a_task_but_a_running_read_does_not() {
    let messages = vec![
        bash_result(&announcement("aaaaaaaa-1", None)),
        bash_result(&announcement("bbbbbbbb-2", None)),
        bash_result(&announcement("cccccccc-3", None)),
        tool_result("task_stop", "Task aaaaaaaa-1 is killed. Output: /tmp/a.log"),
        // Still running at read time: not evidence of an end.
        tool_result(
            "task_output",
            "Task ID: bbbbbbbb-2\nStatus: running\nOutput file: /tmp/b.log\n\npolling",
        ),
        user(&notification("cccccccc-3", "running")),
        // Prose with the right words is not a structured status.
        user("I think Task cccccccc-3 is completed by now, right?"),
    ];
    let ids: Vec<_> = announced_tasks(&messages)
        .into_iter()
        .map(|task| task.task_id)
        .collect();
    assert_eq!(ids, vec!["bbbbbbbb-2", "cccccccc-3"]);
}

#[test]
fn the_notice_caps_the_list_and_counts_the_rest() {
    let orphans: Vec<_> = (0..8)
        .map(|i| AnnouncedTask {
            task_id: format!("{i}{i}{i}{i}{i}{i}{i}{i}-x"),
            description: None,
        })
        .collect();
    let text = orphan_notice(&orphans).unwrap_or_default();
    assert!(text.contains(
        "Background tasks from a previous evot process: 00000000, 11111111, 22222222, 33333333, 44444444 and 3 more."
    ));
    assert!(!text.contains("55555555"));
    let five = orphan_notice(&orphans[..5]).unwrap_or_default();
    assert!(!five.contains("more"));
}

#[tokio::test]
async fn only_tasks_unknown_to_this_process_are_orphans() -> TestResult {
    let dir = tempfile::tempdir()?;
    let manager = ProcessManager::new();
    let mut command = tokio::process::Command::new("bash");
    command.args(["-c", "printf done"]);
    let live_id = manager
        .start(evot_engine::tools::process::StartProcess {
            command,
            command_text: "printf done".into(),
            description: None,
            tool_call_id: "fixture".into(),
            cwd: dir.path().to_path_buf(),
            timeout: std::time::Duration::from_secs(3),
            output_dir: dir.path().join("output"),
            tail_bytes: 4096,
            background_reason: Some(evot_engine::tools::BackgroundReason::Explicit),
            background_on_timeout: true,
        })
        .await?;
    manager
        .wait(&live_id, std::time::Duration::from_secs(3))
        .await
        .ok_or("missing process")?;
    let messages = vec![
        bash_result(&announcement(&live_id, None)),
        bash_result(&announcement(
            "96e7d776-111d-49b0-a11f-8e112f3759ce",
            Some("PR watcher"),
        )),
    ];
    // Running or finished in this process: known. The uuid from an earlier
    // process: never seen here, so it is the only orphan.
    let orphans = orphaned_tasks(&messages, &manager);
    assert_eq!(orphans.len(), 1);
    assert_eq!(orphans[0].task_id, "96e7d776-111d-49b0-a11f-8e112f3759ce");
    assert!(orphan_notice(&[]).is_none());
    Ok(())
}

#[test]
fn the_notice_names_each_task_and_forbids_calling_it_a_watcher() {
    let one = orphan_notice(&[AnnouncedTask {
        task_id: "96e7d776-111d-49b0-a11f-8e112f3759ce".into(),
        description: Some("PR watcher".into()),
    }])
    .unwrap_or_default();
    assert!(one.starts_with("<system-reminder>"));
    assert!(one.contains("Background task from a previous evot process: 96e7d776 (PR watcher)."));
    assert!(one.contains("the task is no longer running"));
    assert!(one.contains("Do not report it as a running watcher."));
    assert!(one.contains("start a new background command"));

    let two = orphan_notice(&[
        AnnouncedTask {
            task_id: "aaaaaaaa-1".into(),
            description: None,
        },
        AnnouncedTask {
            task_id: "bbbbbbbb-2".into(),
            description: Some("ci".into()),
        },
    ])
    .unwrap_or_default();
    assert!(two.contains("Background tasks from a previous evot process: aaaaaaaa, bbbbbbbb (ci)."));
    assert!(two.contains("the tasks are no longer running"));
    assert!(two.contains("Do not report them as a running watcher."));
}
