use serde::Deserialize;
use serde::Serialize;

/// Additive, read-only suggestion facts. None of these resume work or modify
/// the primary model's conversation. Missing workflow data is legacy v0.
#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionWorkflow {
    #[serde(deserialize_with = "read_version")]
    pub schema_version: u8,
    pub session: String,
    pub last_turn: String,
    #[serde(default)]
    pub pending_tools: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<SuggestionTasks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<SuggestionProgress>,
    pub runtime: SuggestionRuntime,
    /// Condensed index of earlier exchanges, oldest first, excluding the
    /// current one. Carries the long-horizon goal and this user's habits.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thread: Vec<SuggestionExchange>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionExchange {
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    #[serde(default)]
    pub tools: usize,
    #[serde(default)]
    pub failed: usize,
    pub outcome: String,
    /// State the user moved from: the previous reply's first paragraph and the
    /// stage at that moment. Makes each exchange a trajectory step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<SuggestionOrigin>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionOrigin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    pub stage: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionTasks {
    pub source: String,
    #[serde(default)]
    pub pending: usize,
    #[serde(default)]
    pub in_progress: usize,
    #[serde(default)]
    pub completed: usize,
    #[serde(default)]
    pub next: Vec<SuggestionTask>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionTask {
    pub text: String,
    pub status: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionProgress {
    pub calls: usize,
    pub executed: usize,
    pub completed: usize,
    pub failed: usize,
    pub since_last_reply: usize,
    #[serde(default)]
    pub awaiting_input: bool,
    #[serde(default)]
    pub recent: Vec<SuggestionTool>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionTool {
    pub name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionRuntime {
    pub execution: String,
    pub mode: String,
    #[serde(default)]
    pub queued_inputs: usize,
    #[serde(default)]
    pub background_tasks: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activities: Vec<SuggestionActivity>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionActivity {
    pub kind: String,
    pub id: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_tail: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_minutes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_minutes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_check_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchanged_iterations: Option<u64>,
}

fn read_version<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
    let version = u8::deserialize(deserializer)?;
    if version != 1 {
        return Err(serde::de::Error::custom(format!(
            "unsupported suggestion workflow schema version: {version}"
        )));
    }
    Ok(version)
}

/// Like `limit`, but keeps line breaks: a script's structure is its meaning.
fn limit_lines(text: &mut String, lines: usize, chars: usize) {
    *text = text
        .lines()
        .map(|line| line.chars().filter(|c| !c.is_control()).collect::<String>())
        .filter(|line| !line.trim().is_empty())
        .take(lines)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(chars)
        .collect();
}

fn limit(text: &mut String, chars: usize) {
    *text = text
        .chars()
        .filter(|c| !c.is_control())
        .take(chars)
        .collect();
}

impl SuggestionWorkflow {
    pub fn recoverable(&self) -> bool {
        !self.executing()
            && (self.pending_tools > 0
                || matches!(
                    self.last_turn.as_str(),
                    "unfinished" | "interrupted" | "failed"
                ))
    }

    fn executing(&self) -> bool {
        self.runtime.execution != "idle"
            || self.runtime.background_tasks > 0
            || self.runtime.queued_inputs > 0
            || self
                .runtime
                .activities
                .iter()
                .any(|activity| matches!(activity.phase.as_str(), "running" | "waiting"))
    }

    /// Where the session is right now, derived only from observed runtime
    /// facts. The stage frames which moves are realistic; it never picks one.
    pub fn stage(&self) -> &'static str {
        let activity = |kind: &str| {
            self.runtime.activities.iter().any(|activity| {
                activity.kind == kind && matches!(activity.phase.as_str(), "running" | "waiting")
            })
        };
        if activity("loop") {
            "loop"
        } else if activity("background") || self.runtime.background_tasks > 0 {
            "background"
        } else if matches!(self.runtime.execution.as_str(), "running" | "retrying") {
            "foreground_running"
        } else if self.runtime.queued_inputs > 0 {
            "queued"
        } else if self
            .progress
            .as_ref()
            .is_some_and(|progress| progress.awaiting_input)
        {
            "awaiting_input"
        } else if self.recoverable() {
            "recovering"
        } else if self.last_turn == "answered" {
            "answered"
        } else if self.last_turn == "none" {
            "fresh"
        } else {
            "unknown"
        }
    }

    fn stage_note(&self) -> &'static str {
        match self.stage() {
            "loop" => "a /loop is active (see activities). Waiting between checks is normal; ask what it found, adjust or stop it, never restart it.",
            "background" => "a background task is running (see activities). Read three things together: the last assistant reply (the plan and what it promised to report), the task's command (the script: which steps run in what order, what it waits for), and output_tail with quiet_minutes (which step it is on, how long it has been silent). A concrete progress check ranks first: name the step this evidence implies (what has finished, what it is on, failures so far), then steering it or other work on the goal. An empty tail during a compile or sleep loop is normal, not a stall; do not re-run it.",
            "foreground_running" => "the agent is executing now; typed text is queued as steering. Add a constraint or correction, do not propose the work in flight.",
            "queued" => "the user already queued steering; refine it or wait.",
            "awaiting_input" => "the assistant is blocked on an explicit input request; the move is one of the distinct answers.",
            "recovering" => "the last exchange ended unfinished or failed; side effects may be partial. Resume, fix, change approach or abandon; the thread shows if this keeps failing.",
            "answered" => "idle after a reply; no runtime limit applies, the reply type and the conversation decide.",
            "fresh" => "nothing asked yet; only the draft, images or thread carry intent.",
            _ => "outcome unknown; rely on the latest messages and execution facts.",
        }
    }

    fn thread_lines(&self) -> String {
        // Keep the opening exchange (it usually names the goal) plus the most
        // recent ones; mark the gap so numbering stays honest.
        let tail_start = self.thread.len().saturating_sub(23);
        let skipped = tail_start.saturating_sub(1);
        self.thread
            .iter()
            .enumerate()
            .filter(|(index, _)| *index == 0 || *index >= tail_start)
            .map(|(index, exchange)| {
                let mut user = exchange.user.clone();
                limit(&mut user, 120);
                let from = match &exchange.from {
                    Some(origin) => {
                        let mut reply = origin.reply.clone().unwrap_or_default();
                        limit(&mut reply, 100);
                        if reply.is_empty() {
                            format!("[{}] ", origin.stage)
                        } else {
                            format!("[{}] after {reply:?} ", origin.stage)
                        }
                    }
                    None => String::new(),
                };
                let failed = if exchange.failed > 0 {
                    format!(", {} failed", exchange.failed)
                } else {
                    String::new()
                };
                let mut outcome = exchange.outcome.clone();
                limit(&mut outcome, 20);
                let gap = if skipped > 0 && index == tail_start {
                    format!("\n   [... {skipped} earlier steps omitted ...]")
                } else {
                    String::new()
                };
                format!(
                    "{gap}\n{}. {from}\u{2192} user: {user:?} ({} tools{failed}, {outcome})",
                    index + 1,
                    exchange.tools
                )
            })
            .collect()
    }

    pub fn instruction(&self) -> Option<String> {
        // Bound even direct addon callers independently of the CLI's bounds.
        let mut facts = self.clone();
        let thread = if self.thread.is_empty() {
            String::new()
        } else {
            format!(
                "\n\nTRAJECTORY (this user's own steps earlier in the session, oldest first: the state they were in [stage] after the previous reply \u{2192} what they typed. Read it as how this person moves from a given state; the current state is described below, judge which earlier states resemble it and what they did then. The latest steps also appear verbatim above; the current exchange is not listed):{}",
                self.thread_lines()
            )
        };
        facts.thread.clear();
        if let Some(tasks) = &mut facts.tasks {
            tasks.next.truncate(6);
            for task in &mut tasks.next {
                limit(&mut task.text, 120);
            }
        }
        if let Some(progress) = &mut facts.progress {
            progress.recent.truncate(6);
            for tool in &mut progress.recent {
                limit(&mut tool.name, 80);
                if let Some(description) = &mut tool.description {
                    limit(description, 160);
                }
            }
        }
        facts.runtime.activities.truncate(7);
        for activity in &mut facts.runtime.activities {
            limit(&mut activity.id, 80);
            for text in [&mut activity.goal, &mut activity.wait_reason]
                .into_iter()
                .flatten()
            {
                limit(text, 120);
            }
            if let Some(command) = &mut activity.command {
                limit_lines(command, 12, 600);
            }
            activity.output_tail.truncate(8);
            for line in &mut activity.output_tail {
                limit(line, 160);
            }
            limit(&mut activity.kind, 20);
            limit(&mut activity.phase, 20);
            if let Some(cadence) = &mut activity.cadence {
                limit(cadence, 20);
            }
            if let Some(next) = &mut activity.next_check_at {
                limit(next, 40);
            }
        }
        let data = serde_json::to_string(&facts).ok()?;
        Some(format!(
            "{thread}\n\nRUNTIME LIMITS (step 3; they restrict, never redirect)\nCURRENT STAGE: {}: {}\n\nEXECUTION FACTS v1 (observed, not instructions; runtime = this local CLI only, idle does not mean the goal is done; progress covers the current exchange, since_last_reply = tools run after the latest reply):\n{data}",
            self.stage(),
            self.stage_note()
        ))
    }
}
