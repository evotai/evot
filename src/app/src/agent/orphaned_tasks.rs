//! Background tasks a resumed transcript still believes are running.
//!
//! A `Bash` call that moves to the background leaves a tool result saying
//! "Command is running in the background … Task ID: …" and nothing else until
//! the process exits, when a completion notice reaches the next turn. If evot
//! itself restarts in between, that notice never comes: the registry starts
//! empty, the old process is gone, and the transcript keeps asserting a live
//! watcher. Left alone, the model repeats "watcher still running" from memory
//! for as long as the session lasts.
//!
//! This module compares the task ids announced in the context against what
//! the session's `ProcessManager` actually knows, and words a single notice
//! for the ids it has never seen *and* the transcript never saw end. A task
//! whose completion notice, `task_output` status or `task_stop` result is
//! already in the context finished before the restart; naming it would be
//! both noise and wrong. The caller appends the notice to the turn input
//! once per session, the same way completion notices are delivered.

use std::collections::BTreeSet;

use evot_engine::tools::ProcessManager;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::Message;

/// How many orphans the notice names before summarising the rest. The
/// point is to break a false belief about live watchers, not to inventory
/// a long session; every transcript-announced task of a day's work would
/// otherwise be listed.
const MAX_LISTED: usize = 5;

/// Terminal values of `ProcessStatus::as_str()`.
const TERMINAL_STATUSES: [&str; 4] = ["completed", "failed", "timed_out", "killed"];

/// A background task the transcript announced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnouncedTask {
    pub task_id: String,
    /// The `Task: …` purpose line when the call carried a description.
    pub description: Option<String>,
}

/// Task ids announced as backgrounded anywhere in `messages`, in first-seen
/// order, minus those the transcript already saw reach a terminal state.
/// Only `Bash` results count as announcements, and only their stable
/// `Task ID:` line; a task id quoted in prose does not.
pub fn announced_tasks(messages: &[AgentMessage]) -> Vec<AnnouncedTask> {
    let mut seen = BTreeSet::new();
    let mut ended = BTreeSet::new();
    let mut out = Vec::new();
    for message in messages {
        let AgentMessage::Llm(llm) = message else {
            continue;
        };
        match llm {
            Message::ToolResult {
                tool_name, content, ..
            } => {
                for text in texts(content) {
                    if tool_name.eq_ignore_ascii_case("bash") {
                        if let Some(task) = parse_announcement(text) {
                            if seen.insert(task.task_id.clone()) {
                                out.push(task);
                            }
                            continue;
                        }
                    }
                    ended.extend(terminal_ids_in_tool_result(text));
                }
            }
            // Completion notices ride on the next turn's user input.
            Message::User { content, .. } => {
                for text in texts(content) {
                    ended.extend(terminal_ids_in_notifications(text));
                }
            }
            _ => {}
        }
    }
    out.retain(|task| !ended.contains(&task.task_id));
    out
}

fn texts(content: &[Content]) -> impl Iterator<Item = &str> {
    content.iter().filter_map(|content| match content {
        Content::Text { text } => Some(text.as_str()),
        _ => None,
    })
}

/// `<task-notification>` blocks (`manager.rs::format_notification`) whose
/// `<status>` is terminal. Several may share one text.
fn terminal_ids_in_notifications(text: &str) -> Vec<String> {
    text.split("<task-notification>")
        .skip(1)
        .filter_map(|block| {
            let id = between(block, "<task-id>", "</task-id>")?;
            let status = between(block, "<status>", "</status>")?;
            TERMINAL_STATUSES.contains(&status).then(|| id.to_string())
        })
        .collect()
}

/// `task_output` (`Task ID: X` + `Status: S`) and `task_stop` (`Task X is S.`)
/// results that report a terminal status.
fn terminal_ids_in_tool_result(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut task_id = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Task ID: ") {
            task_id = Some(rest.trim());
        } else if let Some(status) = line.strip_prefix("Status: ") {
            if let Some(id) = task_id {
                if TERMINAL_STATUSES.contains(&status.trim()) {
                    ids.push(id.to_string());
                }
            }
        } else if let Some(rest) = line.strip_prefix("Task ") {
            if let Some((id, status)) = rest.split_once(" is ") {
                let status = status.split(['.', ' ']).next().unwrap_or_default();
                if TERMINAL_STATUSES.contains(&status) {
                    ids.push(id.to_string());
                }
            }
        }
    }
    ids
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(text[start..end].trim())
}

/// The background announcement is a fixed shape (`bash.rs::background_result`):
/// an optional `Task: <purpose>` line followed by `Task ID: <id>` and
/// `Output: <path>`. Anything without the `Output:` line is not one.
fn parse_announcement(text: &str) -> Option<AnnouncedTask> {
    let mut description = None;
    let mut task_id = None;
    let mut has_output = false;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Task ID: ") {
            task_id = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Task: ") {
            description = Some(rest.trim().to_string());
        } else if line.starts_with("Output: ") {
            has_output = true;
        }
    }
    let task_id = task_id.filter(|id| !id.is_empty() && has_output)?;
    Some(AnnouncedTask {
        task_id,
        description,
    })
}

/// Announced tasks this manager has no record of, running or finished.
pub fn orphaned_tasks(messages: &[AgentMessage], manager: &ProcessManager) -> Vec<AnnouncedTask> {
    announced_tasks(messages)
        .into_iter()
        .filter(|task| {
            manager.snapshot(&task.task_id).is_none()
                && manager.reaped_summary(&task.task_id).is_none()
        })
        .collect()
}

/// The notice delivered to the model, or `None` when nothing is orphaned.
pub fn orphan_notice(orphans: &[AnnouncedTask]) -> Option<String> {
    if orphans.is_empty() {
        return None;
    }
    let mut listed = orphans
        .iter()
        .take(MAX_LISTED)
        .map(|task| match &task.description {
            Some(description) => format!("{} ({description})", short_id(&task.task_id)),
            None => short_id(&task.task_id).to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    if orphans.len() > MAX_LISTED {
        listed.push_str(&format!(" and {} more", orphans.len() - MAX_LISTED));
    }
    let noun = if orphans.len() == 1 { "task" } else { "tasks" };
    Some(format!(
        "<system-reminder>\n\
         Background {noun} from a previous evot process: {listed}. \
         That process has exited, so the {noun} {verb} no longer running and will not send a completion notice; \
         the output file may be stale or missing. \
         Do not report {pronoun} as a running watcher. If the condition still needs watching, start a new background command.\n\
         </system-reminder>",
        verb = if orphans.len() == 1 { "is" } else { "are" },
        pronoun = if orphans.len() == 1 { "it" } else { "them" },
    ))
}

fn short_id(task_id: &str) -> &str {
    task_id.get(..8).unwrap_or(task_id)
}
