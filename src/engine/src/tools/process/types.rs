use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

/// Interval between user-facing progress updates while a task is watched.
///
/// Shared by `bash`'s foreground wait and `task_output`'s blocking wait so a
/// watched task ticks at the same rate however it is being watched.
pub const PROGRESS_INTERVAL: Duration = Duration::from_secs(3);
/// Interval between partial output updates while a task is watched.
pub const UPDATE_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundReason {
    Explicit,
    YieldElapsed,
    /// The `timeout` deadline elapsed. Matches Claude Code, where a timeout
    /// auto-backgrounds rather than killing.
    TimeoutElapsed,
    UserRequested,
    MessageDelivery,
}

/// In-memory task state. Never persisted: the manager lives in
/// `Agent::process_managers`, so every task dies with the process that started
/// it. That is why there are no `Deserialize` impls here and no schema version —
/// there is no old data to read back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "reason")]
pub enum ProcessStatus {
    RunningForeground,
    RunningBackground(BackgroundReason),
    Completed,
    Failed,
    /// The deadline killed the command.
    ///
    /// Only reachable without background support: with a process manager the
    /// deadline backgrounds instead, so this is the headless/readonly outcome
    /// where the timeout is the only bound there is.
    TimedOut,
    Killed,
}

impl ProcessStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::TimedOut | Self::Killed
        )
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::RunningForeground => "running_foreground",
            Self::RunningBackground(_) => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
            Self::Killed => "killed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProcessSnapshot {
    pub task_id: String,
    pub tool_call_id: String,
    pub command: String,
    /// Purpose captured at launch, retained when a foreground command detaches.
    pub description: Option<String>,
    pub cwd: PathBuf,
    pub output_path: PathBuf,
    pub output: String,
    pub output_file_bytes: usize,
    pub output_file_truncated: bool,
    pub total_lines: usize,
    pub status: ProcessStatus,
    pub exit_code: Option<i32>,
    pub elapsed: Duration,
    /// How long the task has produced no output (since start when it never
    /// has). Frozen at the terminal instant like `elapsed`.
    ///
    /// A blocking wait uses this to tell a live build apart from a deadlocked
    /// test: both look identical from `status` alone.
    pub quiet_for: Duration,
    /// How many blocking waits on this task ended because it looked stalled.
    /// Each one lengthens the next stall threshold, so re-waiting cannot
    /// degrade into a poll loop.
    pub stall_wakes: u32,
    /// True when the stop came from the user (`/stop`, background panel) rather
    /// than from the model's own `task_stop` call.
    ///
    /// `Killed` alone does not say who killed it, which left the model guessing
    /// — and guessing wrong, e.g. blaming turn teardown for a task the user had
    /// stopped by hand.
    pub stopped_by_user: bool,
}

/// Listing-only view of a task. Deliberately excludes the captured output so
/// polling callers (the TUI footer) never copy megabytes of rolling tail just
/// to count what is running.
#[derive(Debug, Clone)]
pub struct ProcessSummary {
    pub task_id: String,
    pub command: String,
    pub cwd: PathBuf,
    pub output_path: PathBuf,
    pub status: ProcessStatus,
    pub exit_code: Option<i32>,
    pub elapsed: Duration,
    pub output_file_truncated: bool,
    /// See `ProcessSnapshot::stopped_by_user`.
    pub stopped_by_user: bool,
}

/// Compact width for the task label on a `task_output` / `task_stop` card.
const TASK_LABEL_MAX_CHARS: usize = 40;

/// Short label naming the task a card acts on.
///
/// The full command already appears on the `bash` card that started the task,
/// so echoing it verbatim on every poll printed the same long pipeline twice and
/// wrapped it across the terminal. A short head is all this label is for:
/// telling concurrent tasks apart.
pub fn task_label(command: &str) -> String {
    // Collapse whitespace runs first: a multi-line command would otherwise put
    // a newline into a single-line card headline.
    let collapsed = command.split_whitespace().collect::<Vec<_>>().join(" ");
    match collapsed.char_indices().nth(TASK_LABEL_MAX_CHARS) {
        // `char_indices` yields boundaries, so this cannot split a code point.
        Some((boundary, _)) => format!("{}…", &collapsed[..boundary]),
        None => collapsed,
    }
}

pub struct StartProcess {
    pub command: Command,
    pub command_text: String,
    pub description: Option<String>,
    pub tool_call_id: String,
    pub cwd: PathBuf,
    pub timeout: Duration,
    pub output_dir: PathBuf,
    pub tail_bytes: usize,
    pub background_reason: Option<BackgroundReason>,
    /// Whether the deadline may hand the command to the background.
    ///
    /// False when this runtime has no background support: with no yield, no
    /// `task_output` and no notification path, backgrounding would orphan the
    /// command and leave the caller nothing to collect. There the deadline is
    /// the only bound that exists, so it must still kill.
    pub background_on_timeout: bool,
}
