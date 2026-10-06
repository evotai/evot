//! Bash tool — execute shell commands in the foreground or as resumable background tasks.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use tokio::process::Command;

use super::process::BackgroundReason;
use super::process::ProcessManager;
use super::process::ProcessSnapshot;
use super::process::ProcessStatus;
use super::process::StartProcess;
use super::process::PROGRESS_INTERVAL;
use super::process::UPDATE_INTERVAL;
use crate::types::*;

/// Type alias for command confirmation callback.
pub type ConfirmFn = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// Max lines to include in the final tool result.
const MAX_DISPLAY_LINES: usize = 2000;
/// Max bytes to include in the final tool result.
const MAX_DISPLAY_BYTES: usize = 50 * 1024;
/// Max bytes per single output line before truncation.
const MAX_LINE_BYTES: usize = 4096;
/// Foreground wait before a still-running command is yielded, when a host asks
/// for one.
///
/// Unset by default. A wait bound and a user-driven detach solve the same
/// problem, and the detach is the better half: `ctrl+b` and typing a message
/// both hand foreground shells to the background and release blocking waits, so
/// the turn is always one keypress away. Slicing on top of that did not add
/// safety, it split one wait into a series of them — the model was handed back
/// mid-wait, learned nothing new, and asked again.
///
/// `timeout` remains the bound that survives an absent user: it hands the
/// command back alive where backgrounding exists, and still kills where it does
/// not.
const NO_FOREGROUND_WAIT: Option<Duration> = None;

/// Execute shell commands. Short commands return normally; long commands can
/// yield into a session-scoped [`ProcessManager`] and be queried later.
pub struct BashTool {
    /// Working directory for commands.
    pub cwd: Option<String>,
    /// Default hard execution limit per command when none is requested.
    pub timeout: Duration,
    /// Hard ceiling on a model-requested timeout.
    pub max_timeout: Duration,
    /// Cap on the in-memory rolling tail. The output file remains complete.
    pub max_output_bytes: usize,
    /// Commands/patterns that are always blocked.
    pub deny_patterns: Vec<String>,
    /// Optional callback for confirming dangerous commands.
    pub confirm_fn: Option<ConfirmFn>,
    /// Environment variables injected into every bash subprocess.
    pub envs: Vec<(String, String)>,
    /// Directories the OS sandbox allows the child process to access.
    pub sandbox_dirs: Option<Vec<PathBuf>>,
    process_manager: Arc<ProcessManager>,
    background_enabled: bool,
    foreground_wait: Option<Duration>,
}

impl Default for BashTool {
    fn default() -> Self {
        Self {
            cwd: None,
            timeout: Duration::from_secs(600),
            max_timeout: Duration::from_secs(1800),
            max_output_bytes: 256 * 1024,
            deny_patterns: vec![
                "rm -rf /".into(),
                "rm -rf /*".into(),
                "mkfs".into(),
                "dd if=".into(),
                ":(){:|:&};:".into(),
            ],
            confirm_fn: None,
            envs: Vec::new(),
            sandbox_dirs: None,
            process_manager: Arc::new(ProcessManager::new()),
            background_enabled: false,
            foreground_wait: NO_FOREGROUND_WAIT,
        }
    }
}

impl BashTool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_max_timeout(mut self, max_timeout: Duration) -> Self {
        self.max_timeout = max_timeout;
        self
    }

    pub fn with_deny_patterns(mut self, patterns: Vec<String>) -> Self {
        self.deny_patterns = patterns;
        self
    }

    pub fn with_confirm(mut self, f: impl Fn(&str) -> bool + Send + Sync + 'static) -> Self {
        self.confirm_fn = Some(Box::new(f));
        self
    }

    pub fn with_envs(mut self, envs: impl IntoIterator<Item = (String, String)>) -> Self {
        self.envs = envs.into_iter().collect();
        self
    }

    pub fn with_sandbox_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.sandbox_dirs = Some(dirs);
        self
    }

    pub fn with_process_manager(mut self, manager: Arc<ProcessManager>) -> Self {
        self.process_manager = manager;
        self.background_enabled = true;
        self
    }

    /// Set a foreground-wait bound, which is unset by default.
    ///
    /// This is host configuration and is deliberately absent from the tool
    /// schema, so a tool call cannot extend or disable the bound. Tests use it
    /// to reach the yield path in milliseconds instead of waiting one out.
    pub fn with_foreground_wait(mut self, wait: Duration) -> Self {
        self.foreground_wait = Some(wait);
        self
    }
}

#[async_trait]
impl AgentTool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "Bash".into())]
    }

    fn label(&self) -> &str {
        "Execute Command"
    }

    fn description(&self) -> &str {
        if self.background_enabled && self.foreground_wait.is_some() {
            "Execute a bash command. Commands start in the foreground and move to the background when the host's foreground-wait limit or timeout elapses, or the user requests it. They keep running. Use run_in_background only for intentionally independent work. Use {{task_stop}} to actually stop a task."
        } else if self.background_enabled {
            // `{{task_stop}}` resolves here because descriptions pass through
            // `resolve_tool_refs`. The schema below and BACKGROUND_GUIDANCE do
            // not, so those must keep literal names or the model would be shown
            // a raw `{{...}}`.
            "Execute a bash command. Short commands return normally. A long command holds the turn until it finishes, its timeout elapses, or the user moves it to the background; none of these stop it. Set run_in_background to return immediately. Use {{task_stop}} to actually stop one."
        } else {
            "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). The timeout parameter is the command's hard runtime limit."
        }
    }

    fn prompt_snippet(&self) -> Option<&str> {
        if self.background_enabled {
            Some("Execute bash commands (ls, grep, find, etc.), including background tasks")
        } else {
            Some("Execute bash commands (ls, grep, find, etc.)")
        }
    }

    fn prompt_guidelines(&self) -> Vec<&str> {
        if self.background_enabled {
            // `{{task_output}}` rather than the literal name: Claude models see
            // this tool as `TaskOutput`, so a hardcoded `task_output` names a
            // tool that does not exist for them.
            //
            // Both collection paths are named with what they are for. I wrote the
            // "only when" phrasing earlier in this same work, carrying over Claude
            // Code's stance that blocking is a misuse; it is not, it is what the
            // tool exists for.
            vec![
                "Start ordinary commands in the foreground. Reserve `run_in_background: true` for explicitly independent work, not merely commands expected to take time. Read the returned output path to check progress, or call {{task_output}} once to wait when a later step needs the result. Never poll a task with sleep loops or repeated {{task_output}} calls.",
                "Describe each command's subject and purpose in `description`. Background <task-notification> events report results, not new user requests. Match them to existing work using their task ID and description, while respecting the user's current request.",
            ]
        } else {
            Vec::new()
        }
    }

    fn parameters_schema(&self) -> serde_json::Value {
        let mut properties = serde_json::json!({
            "command": {
                "type": "string",
                "description": "Bash command to execute"
            },
            "description": {
                "type": "string",
                "description": "Optional short description naming the task or subject and purpose of this command. Saved at launch and included in background completion notices; use it to distinguish concurrent work. If omitted, the command itself identifies the task."
            },
            "timeout": {
                "type": "number",
                // Branch-specific because the behaviour is. With background
                // support the deadline hands the command back alive; without it
                // there is nowhere to hand it, so it still kills. One shared
                // sentence would be a lie in whichever half it did not describe,
                // and "it is never killed" is the more dangerous lie to tell.
                "description": if self.background_enabled {
                    "Deadline in seconds for bounding command execution (default 600, max 1800). When it elapses the command is handed back alive as a background task rather than killed, so it remains available to collect. No effect with run_in_background. Use task_stop to actually stop one."
                } else {
                    "Hard runtime limit in seconds (default 600, max 1800). The command is killed when it elapses, so set it above the time the command legitimately needs."
                }
            }
        });
        if self.background_enabled {
            if let Some(properties) = properties.as_object_mut() {
                properties.insert(
                    "run_in_background".into(),
                    serde_json::json!({
                        "type": "boolean",
                        "description": "Start the command and return a background task ID immediately. Only one background task may run at a time: wait for the current one with task_output, or end it with task_stop, before starting another."
                    }),
                );
            }
        }
        serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": ["command"]
        })
    }

    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        params["command"].as_str().map(str::to_string)
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let command_text = params["command"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'command' parameter".into()))?;
        let timeout = requested_timeout(&params, self.timeout, self.max_timeout);
        let run_in_background =
            self.background_enabled && params["run_in_background"].as_bool().unwrap_or(false);
        let yield_time = self.foreground_wait.filter(|_| self.background_enabled);

        for pattern in &self.deny_patterns {
            if command_text.contains(pattern.as_str()) {
                return Err(ToolError::Failed(format!(
                    "Command blocked by safety policy: contains '{pattern}'. This pattern is denied for safety."
                )));
            }
        }
        if let Some(confirm) = &self.confirm_fn {
            if !confirm(command_text) {
                return Err(ToolError::Failed(
                    "Command was not confirmed by the user.".into(),
                ));
            }
        }
        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // One deliberate background task at a time.
        //
        // Enforced here rather than in the manager because this is a policy about
        // *this entry point*, not an invariant of the task table. The manager
        // legitimately holds many live tasks: ctrl+b detaches every foreground
        // shell at once, and a yield or an elapsed deadline hands back a command
        // that is already running. Refusing those would kill live work or strand
        // the caller, so only an explicit request is capped.
        if run_in_background {
            let already_backgrounded = self.process_manager.summaries().iter().any(|summary| {
                matches!(
                    summary.status,
                    ProcessStatus::RunningBackground(BackgroundReason::Explicit)
                )
            });
            if already_backgrounded {
                return Err(ToolError::Failed(
                    "A background task is already running. Only one at a time is allowed: \
                     wait for it with task_output, or end it with task_stop, before starting \
                     another. To run this command now without backgrounding it, call bash \
                     without run_in_background."
                        .into(),
                ));
            }
        }

        let cwd = match self.cwd.as_ref() {
            Some(cwd) => PathBuf::from(cwd),
            None if !ctx.cwd.as_os_str().is_empty() => ctx.cwd.clone(),
            None => std::env::current_dir().map_err(|error| {
                ToolError::Failed(format!("Failed to resolve current directory: {error}"))
            })?,
        };
        let output_dir = process_output_dir(&ctx);
        let mut command = Command::new("bash");
        command.arg("-c").arg(command_text).current_dir(&cwd);
        if !self.envs.is_empty() {
            command.envs(self.envs.iter().map(|(key, value)| (key, value)));
        }
        if let Some(dirs) = &self.sandbox_dirs {
            super::sandbox::wrap_command(&mut command, dirs)
                .map_err(|error| ToolError::Failed(format!("Sandbox setup failed: {error}")))?;
        }

        let task_id = self
            .process_manager
            .start(StartProcess {
                command,
                command_text: command_text.to_string(),
                description: params["description"].as_str().map(str::to_string),
                tool_call_id: ctx.tool_call_id.clone(),
                cwd,
                timeout,
                output_dir,
                tail_bytes: self.max_output_bytes,
                background_reason: run_in_background.then_some(BackgroundReason::Explicit),
                // Only meaningful where background support exists. Without it
                // there is no yield, no task_output and no notification, so a
                // backgrounded command would be orphaned with nothing to collect
                // it — the deadline has to stay a kill.
                background_on_timeout: self.background_enabled,
            })
            .await?;

        if run_in_background {
            // No wait elapsed: backgrounding was the request, not an outcome.
            return background_result(
                &self.process_manager,
                &task_id,
                BackgroundReason::Explicit,
                None,
            );
        }

        let started = Instant::now();
        let mut last_progress = Instant::now();
        let mut last_update = Instant::now();
        let mut last_background_countdown = None;
        loop {
            if ctx.cancel.is_cancelled() {
                if let Some(snapshot) = self.process_manager.stop(&task_id).await {
                    remove_output_file(&snapshot.output_path);
                }
                self.process_manager.forget(&task_id);
                return Err(ToolError::Cancelled);
            }

            let snapshot = self
                .process_manager
                .snapshot(&task_id)
                .ok_or_else(|| ToolError::Failed(format!("Process task disappeared: {task_id}")))?;
            if snapshot.status.is_terminal() {
                let result = format_terminal_result(snapshot, self.sandbox_dirs.is_some());
                self.process_manager.forget(&task_id);
                return result;
            }
            // Someone outside this call moved the task to the background — the
            // user reclaiming the turn, or a queued message needing delivery.
            // Hand it back as a background result: the command keeps running, so
            // the only thing that ends here is the waiting.
            if let ProcessStatus::RunningBackground(reason) = snapshot.status {
                return background_result(&self.process_manager, &task_id, reason, yield_time);
            }

            let elapsed = started.elapsed();
            if yield_time.is_some_and(|limit| elapsed >= limit) {
                if self
                    .process_manager
                    .background(&task_id, BackgroundReason::YieldElapsed)
                {
                    return background_result(
                        &self.process_manager,
                        &task_id,
                        BackgroundReason::YieldElapsed,
                        yield_time,
                    );
                }
                return completed_result(
                    &self.process_manager,
                    &task_id,
                    self.sandbox_dirs.is_some(),
                );
            }

            if let Some(limit) = yield_time.map(|limit| limit.min(timeout)) {
                let remaining = limit.saturating_sub(elapsed).as_secs_f64().ceil() as u64;
                if last_background_countdown != Some(remaining) {
                    if let Some(on_progress) = &ctx.on_progress {
                        on_progress(format!(
                            "Moves to background in {remaining}s; command keeps running."
                        ));
                    }
                    last_background_countdown = Some(remaining);
                }
            } else if elapsed >= PROGRESS_INTERVAL && last_progress.elapsed() >= PROGRESS_INTERVAL {
                if let Some(on_progress) = &ctx.on_progress {
                    on_progress(format!("Running... {}s", elapsed.as_secs()));
                }
                last_progress = Instant::now();
            }
            if elapsed >= UPDATE_INTERVAL && last_update.elapsed() >= UPDATE_INTERVAL {
                if let Some(on_update) = &ctx.on_update {
                    if !snapshot.output.is_empty() {
                        on_update(ToolResult {
                            content: vec![Content::Text {
                                text: snapshot.output,
                            }],
                            details: serde_json::Value::Null,
                            retention: Retention::Normal,
                        });
                    }
                }
                last_update = Instant::now();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

fn requested_timeout(
    params: &serde_json::Value,
    default_timeout: Duration,
    max_timeout: Duration,
) -> Duration {
    match params["timeout"].as_f64() {
        Some(seconds) if seconds.is_finite() && seconds > 0.0 => {
            let upper_bound = max_timeout.max(default_timeout);
            Duration::try_from_secs_f64(seconds)
                .unwrap_or(upper_bound)
                .min(upper_bound)
        }
        _ => default_timeout,
    }
}

fn process_output_dir(ctx: &ToolContext) -> PathBuf {
    if let Some(spill) = &ctx.spill {
        let candidate = spill.path_for_key("process-output");
        if let Some(parent) = candidate.parent() {
            return parent.to_path_buf();
        }
    }
    std::env::temp_dir().join("evot").join("process-output")
}

fn background_result(
    manager: &ProcessManager,
    task_id: &str,
    reason: BackgroundReason,
    waited: Option<Duration>,
) -> Result<ToolResult, ToolError> {
    let snapshot = manager
        .snapshot(task_id)
        .ok_or_else(|| ToolError::Failed(format!("Process task disappeared: {task_id}")))?;
    let purpose = snapshot
        .description
        .as_deref()
        .map(|description| format!("Task: {description}\n"))
        .unwrap_or_default();
    let text = format!(
        "{}\n{}Task ID: {}\nOutput: {}\n{}",
        background_lede(reason, waited),
        purpose,
        snapshot.task_id,
        snapshot.output_path.display(),
        BACKGROUND_GUIDANCE,
    );
    Ok(ToolResult {
        content: vec![Content::Text { text }],
        details: serde_json::json!({
            "task_id": snapshot.task_id,
            "status": "running",
            "backgrounded": true,
            "background_reason": reason,
            "output_path": snapshot.output_path,
        }),
        retention: Retention::Normal,
    })
}

/// Opening line naming *why* the command is no longer in the foreground.
///
/// An explicit `run_in_background` needs no explanation, but a command the
/// harness moved on its own does: without the reason the model cannot tell an
/// intentional detach from one it should wait out.
///
/// `waited` is the wait that actually elapsed. It has to be passed in rather
/// than inferred from the default: a model that asked for
/// `yield_time_ms: 5000` must be told that its 5s foreground wait elapsed, not
/// that the full default elapsed.
fn background_lede(reason: BackgroundReason, waited: Option<Duration>) -> String {
    match reason {
        BackgroundReason::YieldElapsed => match waited {
            Some(waited) => format!(
                "Command did not finish within its {}s foreground wait and was moved to the background; it was not interrupted.",
                waited.as_secs()
            ),
            None => "Command did not finish within its foreground wait and was moved to the background; it was not interrupted.".to_string(),
        },
        // A timeout no longer kills, so the lede must not imply the work is over.
        // A model that reads "timed out" as "dead" would re-run a build that is
        // still going, which is the failure the old kill behaviour caused.
        BackgroundReason::TimeoutElapsed => concat!(
            "Command hit its timeout and was moved to the background; it was not interrupted and is still running. ",
            "The timeout bounded the wait, not the command.",
        )
        .to_string(),
        // The user moved this aside, which is not the same as abandoning it:
        // saying only "running in the background" would let the model treat the
        // result as unwanted and skip a step that still depends on it.
        BackgroundReason::UserRequested => concat!(
            "The user moved this command to the background so they could keep talking to you; ",
            "it was not interrupted and its result is still wanted. ",
            "Continue with whatever does not depend on it.",
        )
        .to_string(),
        BackgroundReason::MessageDelivery => concat!(
            "This command was moved to the background so a queued user message could reach you; ",
            "it was not interrupted and its result is still wanted. ",
            "Read the new message first, then continue.",
        )
        .to_string(),
        BackgroundReason::Explicit => "Command is running in the background.".to_string(),
    }
}

/// What the model must do next.
///
/// The dependency sentence is the load-bearing one. A yielded `cargo test` that
/// a later `git commit` depends on used to leave the model with three tool
/// options and no statement that waiting was required, so it could commit
/// against a suite that had not finished.
///
/// Both ways of collecting the result are stated with their costs, and neither
/// is disparaged. An earlier version ranked them — reading "costs nothing",
/// blocking "throws away the point of backgrounding" — which told a model that
/// waiting on a result it genuinely needs was a mistake. It is not; it is what
/// `task_output` is for.
///
/// Tool names stay literal here. This is a tool-result body, which never passes
/// through `resolve_tool_refs`, so a `{{task_output}}` placeholder would reach
/// the model raw. The names being canonical rather than per-model is harmless:
/// `matches_call_name` is case-insensitive and accepts every alias, so a Claude
/// model that reads `task_output` here and calls it still dispatches, even
/// though its own schema spells the tool `TaskOutput`.
/// What to do with a task that is now running outside the foreground.
///
/// This is a two-way choice, and both ways have to be spelled out. An earlier
/// version named only the blocking one and then added "never end your turn to
/// wait", which closed the only path that does not hold the turn: completion
/// notices are delivered into the next turn, so ending the turn is how an
/// independent task reports back. With that path forbidden the model had no
/// option but to block, get handed back at the wait bound, and block again —
/// one card and one decision per bound, for a single wait.
///
/// The anti-polling sentence is about `sleep` loops as much as repeated calls:
/// a `while ...; do sleep 30; done` poller is itself a long command that gets
/// backgrounded, so polling this way nests the very problem it tries to solve.
const BACKGROUND_GUIDANCE: &str = concat!(
    "You will be notified when it completes. ",
    "To check progress without waiting, use Read on the output path. ",
    "When a later step cannot proceed without this command's result, call task_output to wait for it ",
    "before that step: it holds the turn until the task ends, so the user cannot be answered meanwhile. ",
    "When nothing you can do next depends on it, carry on with other work or end your turn — ",
    "the result reaches you on its own once the task finishes. ",
    "Either way, do not poll: no sleep loops, and no repeated task_output calls to watch it progress. ",
    "Never treat a started task as a passed one. ",
    "Use task_stop to terminate it.",
);

fn completed_result(
    manager: &ProcessManager,
    task_id: &str,
    sandboxed: bool,
) -> Result<ToolResult, ToolError> {
    let snapshot = manager
        .snapshot(task_id)
        .ok_or_else(|| ToolError::Failed(format!("Process task disappeared: {task_id}")))?;
    let result = format_terminal_result(snapshot, sandboxed);
    manager.forget(task_id);
    result
}

fn format_terminal_result(
    snapshot: ProcessSnapshot,
    sandboxed: bool,
) -> Result<ToolResult, ToolError> {
    let exit_code = snapshot.exit_code.unwrap_or(-1);
    let display = tail_truncate(&truncate_long_lines(&snapshot.output)).0;

    if matches!(snapshot.status, ProcessStatus::TimedOut) {
        let mut message = format!("Command timed out after {}s", snapshot.elapsed.as_secs());
        if !display.is_empty() {
            message.push_str("\nLast output:\n");
            message.push_str(&display);
        }
        let was_truncated = snapshot.output_file_truncated
            || snapshot.output.len() > MAX_DISPLAY_BYTES
            || snapshot.total_lines > MAX_DISPLAY_LINES;
        if was_truncated {
            let label = if snapshot.output_file_truncated {
                "Output file capped at 10 MiB"
            } else {
                "Full output saved to"
            };
            message.push_str(&format!(
                "\n\n[{label}: {}]",
                snapshot.output_path.display()
            ));
        } else {
            remove_output_file(&snapshot.output_path);
        }
        return Err(ToolError::Failed(message));
    }
    if matches!(snapshot.status, ProcessStatus::Killed) {
        remove_output_file(&snapshot.output_path);
        return Err(ToolError::Cancelled);
    }

    let was_truncated = snapshot.output_file_truncated
        || snapshot.output.len() > MAX_DISPLAY_BYTES
        || snapshot.total_lines > MAX_DISPLAY_LINES;
    let mut output = display;
    if was_truncated {
        let shown_lines = output.lines().count();
        let start_line = snapshot.total_lines.saturating_sub(shown_lines) + 1;
        let file_label = if snapshot.output_file_truncated {
            "Output file capped at 10 MiB"
        } else {
            "Full output"
        };
        output.push_str(&format!(
            "\n\n[Showing lines {start_line}-{} of {}. {file_label}: {}]",
            snapshot.total_lines,
            snapshot.total_lines,
            snapshot.output_path.display()
        ));
    }
    if exit_code != 0 {
        output = format!("Exit code: {}\n{}", exit_code, output);
    }
    if sandboxed
        && exit_code != 0
        && (snapshot.output.contains("Operation not permitted")
            || snapshot.output.contains("Permission denied"))
    {
        output.push_str(
            "\n\n[Sandbox] This command failed due to OS-level sandbox restrictions. File access is limited to the allowed directories. Do not retry — the restriction is enforced by the kernel.",
        );
    }

    let full_output_path = if was_truncated {
        Some(snapshot.output_path.to_string_lossy().to_string())
    } else {
        remove_output_file(&snapshot.output_path);
        None
    };
    Ok(ToolResult {
        content: vec![Content::Text { text: output }],
        details: serde_json::json!({
            "exit_code": exit_code,
            "success": exit_code == 0,
            "full_output_path": full_output_path,
        }),
        retention: Retention::Normal,
    })
}

fn remove_output_file(path: &std::path::Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %path.display(), "bash output cleanup failed");
        }
    }
}

/// Tail-truncate output: keep the last display-sized section.
fn tail_truncate(text: &str) -> (String, bool, usize) {
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();
    if text.len() <= MAX_DISPLAY_BYTES && total_lines <= MAX_DISPLAY_LINES {
        return (text.to_string(), false, total_lines);
    }

    let mut collected = Vec::new();
    let mut byte_count = 0_usize;
    for line in lines.iter().rev() {
        let line_bytes = line.len() + 1;
        if byte_count + line_bytes > MAX_DISPLAY_BYTES || collected.len() >= MAX_DISPLAY_LINES {
            break;
        }
        collected.push(*line);
        byte_count += line_bytes;
    }
    collected.reverse();
    (collected.join("\n"), true, total_lines)
}

fn truncate_long_lines(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            result.push('\n');
        }
        if line.len() <= MAX_LINE_BYTES {
            result.push_str(line);
            continue;
        }
        let half = MAX_LINE_BYTES / 2;
        let head_end = line.floor_char_boundary(half);
        let tail_start = line.ceil_char_boundary(line.len().saturating_sub(half));
        let omitted = line.len() - head_end - (line.len() - tail_start);
        result.push_str(&line[..head_end]);
        result.push_str(&format!(" ... ({omitted} bytes truncated) ... "));
        result.push_str(&line[tail_start..]);
    }
    result
}
