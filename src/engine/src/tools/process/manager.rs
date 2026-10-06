use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;
use std::time::Instant;

use parking_lot::Mutex;
use parking_lot::RwLock;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::spawn::kill_process_group;
use super::spawn::SpawnedChild;
use super::types::BackgroundReason;
use super::types::ProcessSnapshot;
use super::types::ProcessStatus;
use super::types::ProcessSummary;
use super::types::StartProcess;
use crate::types::ToolError;

const IO_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RUNNING_TASKS: usize = 32;
const MAX_GLOBAL_RUNNING_TASKS: usize = 128;
const MAX_TRACKED_TASKS: usize = 96;
const MAX_RETAINED_TERMINAL_TASKS: usize = 64;
/// How many reaped task ids keep a tombstone.
///
/// Cheap by design — an id, an outcome, and a path — so this can outlive the
/// task records themselves and still answer "what happened to X?".
const MAX_TOMBSTONES: usize = 256;
const MAX_OUTPUT_FILE_BYTES: usize = 10 * 1024 * 1024;

static GLOBAL_PROCESS_PERMITS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_GLOBAL_RUNNING_TASKS)));

#[derive(Clone)]
pub struct ProcessManager {
    inner: Arc<ProcessManagerInner>,
}

struct ProcessManagerInner {
    /// Blocking `task_output` waits currently in flight.
    ///
    /// A blocking wait occupies the whole turn while the task it watches is
    /// already backgrounded, so no foreground shell exists for the user to
    /// detach. Without this count the UI cannot tell that state apart from an
    /// ordinary model call, and ctrl+b would look inert exactly when it is the
    /// key that helps.
    blocking_waiters: AtomicUsize,
    /// Bumped to tell in-flight blocking waits to give up the turn.
    ///
    /// A generation rather than a flag: a release must free the waits that
    /// existed when the user asked, without arming the next one.
    wait_release_generation: AtomicU64,
    tasks: RwLock<HashMap<String, Arc<ProcessTask>>>,
    /// Outcomes of tasks whose records have been reaped, oldest first.
    ///
    /// Without these, querying a finished-and-reaped task reported "No
    /// background task found", which reads as "it never ran" — so the work gets
    /// pointlessly repeated. A tombstone lets the answer say it finished.
    tombstones: Mutex<VecDeque<ProcessTombstone>>,
    notifications: Mutex<Vec<ProcessNotification>>,
    lifecycle: Mutex<()>,
    closed: AtomicBool,
}

/// Minimal record of a task that is gone: enough to explain it, not enough to
/// matter for memory.
#[derive(Clone)]
struct ProcessTombstone {
    task_id: String,
    command: String,
    status: ProcessStatus,
    exit_code: Option<i32>,
    output_path: PathBuf,
    /// False once the output file has been deleted along with the record.
    output_retained: bool,
}

struct ProcessNotification {
    task_id: String,
    text: String,
    wakes_agent: bool,
}

/// Who asked for a stop. Only the attribution differs; the kill path is shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopOrigin {
    /// The model's own `task_stop` call — it already knows, so no attribution.
    Model,
    /// `/stop` or the background panel. The model must be told.
    User,
}

/// Keeps the blocking-wait count accurate even if the wait exits by `?`.
pub(super) struct BlockingWaitGuard {
    inner: Arc<ProcessManagerInner>,
}

impl Drop for BlockingWaitGuard {
    fn drop(&mut self) {
        self.inner.blocking_waiters.fetch_sub(1, Ordering::AcqRel);
    }
}

struct ProcessTask {
    id: String,
    tool_call_id: String,
    command: String,
    description: Option<String>,
    cwd: PathBuf,
    output_path: PathBuf,
    started_at: Instant,
    /// Process-group id of the spawned leader. Kept so a synchronous killer can
    /// signal the whole group on exit paths that never run async code.
    pgid: Option<u32>,
    output: Arc<Mutex<ProcessOutput>>,
    state: Mutex<ProcessState>,
    cancel: CancellationToken,
}

struct ProcessState {
    status: ProcessStatus,
    exit_code: Option<i32>,
    requested_status: Option<ProcessStatus>,
    notify_on_completion: bool,
    notification_claimed: bool,
    /// Set when the stop was user-initiated, so the completion notification can
    /// say who stopped the task instead of leaving the model to guess.
    stopped_by_user: bool,
    /// When the task reached a terminal status. Elapsed time freezes here so a
    /// finished task does not keep ticking in `/ps`.
    finished_at: Option<Instant>,
    /// Blocking waits that gave up on this task because it looked stalled.
    /// See `ProcessSnapshot::stall_wakes`.
    stall_wakes: u32,
    global_permit: Option<OwnedSemaphorePermit>,
}

struct ProcessOutput {
    file: Option<File>,
    file_bytes: usize,
    file_truncated: bool,
    tail: Vec<u8>,
    tail_bytes: usize,
    newlines: usize,
    open_line: bool,
    /// Last time any byte arrived; the task's start until then.
    last_activity: Instant,
}

impl ProcessOutput {
    fn new(file: File, tail_bytes: usize) -> Self {
        Self {
            file: Some(file),
            file_bytes: 0,
            file_truncated: false,
            tail: Vec::with_capacity(4096),
            tail_bytes: tail_bytes.max(4096),
            newlines: 0,
            open_line: false,
            last_activity: Instant::now(),
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.last_activity = Instant::now();
        self.newlines += bytes.iter().filter(|byte| **byte == b'\n').count();
        self.open_line = bytes.last() != Some(&b'\n');
        if let Some(file) = self.file.as_mut() {
            let remaining = MAX_OUTPUT_FILE_BYTES.saturating_sub(self.file_bytes);
            let persisted = bytes.len().min(remaining);
            if persisted > 0 {
                if let Err(error) = file.write_all(&bytes[..persisted]) {
                    tracing::warn!(%error, "background process output write failed");
                    self.file = None;
                    self.file_truncated = true;
                } else {
                    self.file_bytes = self.file_bytes.saturating_add(persisted);
                }
            }
            if persisted < bytes.len() {
                self.file_truncated = true;
            }
        } else if self.file_bytes >= MAX_OUTPUT_FILE_BYTES {
            self.file_truncated = true;
        }
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > self.tail_bytes.saturating_mul(2) {
            let target = self.tail.len().saturating_sub(self.tail_bytes);
            let drain_to = self.tail[target..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(target, |position| target + position + 1);
            self.tail.drain(..drain_to);
        }
    }

    fn finish(&mut self) {
        if let Some(mut file) = self.file.take() {
            if let Err(error) = file.flush() {
                tracing::warn!(%error, "background process output flush failed");
            }
            if let Err(error) = file.sync_all() {
                tracing::warn!(%error, "background process output sync failed");
            }
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.tail).to_string()
    }

    fn total_lines(&self) -> usize {
        self.newlines + usize::from(self.open_line)
    }
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ProcessManagerInner {
                blocking_waiters: AtomicUsize::new(0),
                wait_release_generation: AtomicU64::new(0),
                tasks: RwLock::new(HashMap::new()),
                tombstones: Mutex::new(VecDeque::new()),
                notifications: Mutex::new(Vec::new()),
                lifecycle: Mutex::new(()),
                closed: AtomicBool::new(false),
            }),
        }
    }

    pub async fn start(&self, mut request: StartProcess) -> Result<String, ToolError> {
        let _lifecycle = self.inner.lifecycle.lock();
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(ToolError::Failed(
                "Background process manager is closed for this session".into(),
            ));
        }
        self.prune_claimed_terminal_tasks();

        let tasks = self.inner.tasks.read();
        let running = tasks
            .values()
            .filter(|task| !task.state.lock().status.is_terminal())
            .count();
        if running >= MAX_RUNNING_TASKS {
            return Err(ToolError::Failed(format!(
                "Too many running background processes (limit: {MAX_RUNNING_TASKS}). \
                 Use task_stop on tasks you no longer need before starting more."
            )));
        }
        if tasks.len() >= MAX_TRACKED_TASKS {
            return Err(ToolError::Failed(format!(
                "Too many retained background tasks (limit: {MAX_TRACKED_TASKS}). Read completed task output before starting more commands."
            )));
        }
        drop(tasks);

        // Both running limits name a remedy now. A timeout used to reclaim slots
        // on its own by killing the process; it backgrounds instead, so nothing
        // frees a slot except an explicit stop or session teardown. A bare
        // "limit reached" would leave the model with no move to make.
        let global_permit = GLOBAL_PROCESS_PERMITS
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ToolError::Failed(format!(
                    "Too many running processes across sessions (limit: {MAX_GLOBAL_RUNNING_TASKS}). \
                     Other sessions hold some of these; use task_stop on tasks this session no longer needs."
                ))
            })?;
        let task_id = Uuid::new_v4().to_string();
        let output_path = request
            .output_dir
            .join(format!("{}-bash-output.txt", task_id));
        std::fs::create_dir_all(&request.output_dir).map_err(|error| {
            ToolError::Failed(format!(
                "Failed to create process output directory {}: {error}",
                request.output_dir.display()
            ))
        })?;
        let file = File::create(&output_path).map_err(|error| {
            ToolError::Failed(format!(
                "Failed to create process output file {}: {error}",
                output_path.display()
            ))
        })?;

        request.command.stdin(std::process::Stdio::null());
        request.command.stdout(std::process::Stdio::piped());
        request.command.stderr(std::process::Stdio::piped());
        let mut child = match SpawnedChild::spawn(&mut request.command) {
            Ok(child) => child,
            Err(error) => {
                if let Err(remove_error) = std::fs::remove_file(&output_path) {
                    if remove_error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(%remove_error, path = %output_path.display(), "failed to clean process output after spawn error");
                    }
                }
                return Err(ToolError::Failed(format!("Failed to execute: {error}")));
            }
        };
        let stdout = child.stdout();
        let stderr = child.stderr();
        // A spawned child leads its own session, so the leader pid is also the
        // pgid to signal on exit paths.
        let pgid = child.pgid();

        let task = Arc::new(ProcessTask {
            id: task_id.clone(),
            tool_call_id: request.tool_call_id,
            command: request.command_text,
            description: request.description.and_then(|description| {
                let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
                (!description.is_empty()).then_some(description)
            }),
            cwd: request.cwd,
            output_path,
            started_at: Instant::now(),
            pgid,
            output: Arc::new(Mutex::new(ProcessOutput::new(file, request.tail_bytes))),
            state: Mutex::new(ProcessState {
                status: request.background_reason.map_or(
                    ProcessStatus::RunningForeground,
                    ProcessStatus::RunningBackground,
                ),
                exit_code: None,
                requested_status: None,
                notify_on_completion: request.background_reason.is_some(),
                notification_claimed: false,
                stopped_by_user: false,
                finished_at: None,
                stall_wakes: 0,
                global_permit: Some(global_permit),
            }),
            cancel: CancellationToken::new(),
        });
        self.inner
            .tasks
            .write()
            .insert(task_id.clone(), Arc::clone(&task));

        let stdout_task = stdout.map(|pipe| {
            let output = Arc::clone(&task.output);
            tokio::spawn(read_output(pipe, output))
        });
        let stderr_task = stderr.map(|pipe| {
            let output = Arc::clone(&task.output);
            tokio::spawn(read_output(pipe, output))
        });
        let weak_inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let timeout = tokio::time::sleep(request.timeout);
            tokio::pin!(timeout);
            let mut timed_out = false;
            let (wait_result, forced_status) = loop {
                tokio::select! {
                    result = child.wait() => break (result, None),
                    _ = task.cancel.cancelled() => {
                        let requested = task.state.lock().requested_status.clone()
                            .unwrap_or(ProcessStatus::Killed);
                        let _ = child.kill().await;
                        break (child.wait().await, Some(requested));
                    }
                    // The deadline hands the command to the background instead of
                    // killing it. A `timeout` that destroyed work made the
                    // parameter a trap: a model setting one to bound its own wait
                    // was sentencing its build to death. Killing stays an explicit
                    // act — task_stop, or the user.
                    //
                    // Unless this runtime cannot background at all, in which case
                    // the deadline is the only bound there is and still kills.
                    _ = &mut timeout, if !timed_out => {
                        timed_out = true;
                        if !request.background_on_timeout {
                            let _ = child.kill().await;
                            break (child.wait().await, Some(ProcessStatus::TimedOut));
                        }
                        let mut state = task.state.lock();
                        if matches!(state.status, ProcessStatus::RunningForeground) {
                            state.status = ProcessStatus::RunningBackground(
                                BackgroundReason::TimeoutElapsed,
                            );
                            // The caller stops waiting, so completion has to
                            // arrive as a notification or the result is lost.
                            state.notify_on_completion = true;
                        }
                    }
                }
            };

            let _ = tokio::time::timeout(IO_DRAIN_TIMEOUT, async {
                if let Some(handle) = stdout_task {
                    let _ = handle.await;
                }
                if let Some(handle) = stderr_task {
                    let _ = handle.await;
                }
            })
            .await;
            task.output.lock().finish();

            let exit_code = match wait_result {
                Ok(status) => status.code().map_or(-1, |code| code),
                Err(error) => {
                    tracing::warn!(%error, task_id = %task.id, "background process wait failed");
                    -1
                }
            };
            {
                let mut state = task.state.lock();
                state.exit_code = Some(exit_code);
                state.status = forced_status
                    .or_else(|| state.requested_status.clone())
                    .unwrap_or(if exit_code == 0 {
                        ProcessStatus::Completed
                    } else {
                        ProcessStatus::Failed
                    });
                state.finished_at = Some(Instant::now());
                state.global_permit.take();
            }

            if let Some(inner) = weak_inner.upgrade() {
                let snapshot = task.snapshot();
                let mut notifications = inner.notifications.lock();
                let state = task.state.lock();
                if state.notify_on_completion && !state.notification_claimed {
                    notifications.push(ProcessNotification {
                        task_id: task.id.clone(),
                        text: format_notification(&snapshot),
                        wakes_agent: !state.stopped_by_user,
                    });
                }
            }
        });

        Ok(task_id)
    }

    pub fn background(&self, task_id: &str, reason: BackgroundReason) -> bool {
        let Some(task) = self.inner.tasks.read().get(task_id).cloned() else {
            return false;
        };
        let mut state = task.state.lock();
        if !matches!(state.status, ProcessStatus::RunningForeground) {
            return false;
        }
        state.status = ProcessStatus::RunningBackground(reason);
        state.notify_on_completion = true;
        true
    }

    /// Detach every foreground task, returning the ids that moved.
    ///
    /// This is how a user reclaims the turn without destroying work: the
    /// processes keep running and their output files stay put, so the only thing
    /// that ends is the waiting. The `bash` foreground loop re-reads each task's
    /// status every tick, so flipping it here is enough to make that loop hand
    /// the task back as a background result — no cancellation involved.
    ///
    /// Already-background and terminal tasks are skipped, so calling this twice
    /// is harmless.
    pub fn background_all_foreground(&self, reason: BackgroundReason) -> Vec<String> {
        let tasks = self
            .inner
            .tasks
            .read()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut moved = Vec::new();
        for task in tasks {
            let mut state = task.state.lock();
            if !matches!(state.status, ProcessStatus::RunningForeground) {
                continue;
            }
            state.status = ProcessStatus::RunningBackground(reason);
            state.notify_on_completion = true;
            moved.push(task.id.clone());
        }
        moved
    }

    /// Blocking `task_output` waits currently in flight.
    pub fn blocking_waiters(&self) -> usize {
        self.inner.blocking_waiters.load(Ordering::Acquire)
    }

    /// Tell in-flight blocking waits to give up the turn, returning how many
    /// were released.
    ///
    /// The tasks they watch keep running; only the waiting ends. This is the
    /// counterpart to detaching a foreground shell, for the case where the shell
    /// is already backgrounded and a `task_output` call is what holds the turn.
    pub fn release_blocking_waiters(&self) -> usize {
        let waiting = self.blocking_waiters();
        if waiting > 0 {
            self.inner
                .wait_release_generation
                .fetch_add(1, Ordering::AcqRel);
        }
        waiting
    }

    /// Generation marker a wait captures when it starts.
    pub(super) fn wait_release_generation(&self) -> u64 {
        self.inner.wait_release_generation.load(Ordering::Acquire)
    }

    /// Registers a blocking wait for the lifetime of the returned guard.
    pub(super) fn enter_blocking_wait(&self) -> BlockingWaitGuard {
        self.inner.blocking_waiters.fetch_add(1, Ordering::AcqRel);
        BlockingWaitGuard {
            inner: Arc::clone(&self.inner),
        }
    }

    pub fn snapshot(&self, task_id: &str) -> Option<ProcessSnapshot> {
        self.inner
            .tasks
            .read()
            .get(task_id)
            .map(|task| task.snapshot())
    }

    /// Record that a blocking wait ended because the task looked stalled.
    /// Returns the new count, which the next wait uses to back off.
    pub(super) fn record_stall_wake(&self, task_id: &str) -> u32 {
        let Some(task) = self.inner.tasks.read().get(task_id).cloned() else {
            return 0;
        };
        let mut state = task.state.lock();
        state.stall_wakes = state.stall_wakes.saturating_add(1);
        state.stall_wakes
    }

    /// Listing view of one task. Unlike `snapshot`, this skips the captured
    /// output, so callers that only need to name a task (a card headline) do
    /// not copy its rolling tail.
    pub fn summary(&self, task_id: &str) -> Option<ProcessSummary> {
        self.inner
            .tasks
            .read()
            .get(task_id)
            .map(|task| task.summary())
    }

    pub fn snapshots(&self) -> Vec<ProcessSnapshot> {
        let mut snapshots = self
            .inner
            .tasks
            .read()
            .values()
            .map(|task| task.snapshot())
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| snapshot.elapsed);
        snapshots
    }

    /// Listing view for pollers. Skips the captured output entirely, so the
    /// per-call cost stays proportional to the task count, not output size.
    pub fn summaries(&self) -> Vec<ProcessSummary> {
        let mut summaries = self
            .inner
            .tasks
            .read()
            .values()
            .map(|task| task.summary())
            .collect::<Vec<_>>();
        summaries.sort_by_key(|summary| summary.elapsed);
        summaries
    }

    pub async fn wait(&self, task_id: &str, timeout: Duration) -> Option<ProcessSnapshot> {
        let started = Instant::now();
        loop {
            let snapshot = self.snapshot(task_id)?;
            if snapshot.status.is_terminal() || started.elapsed() >= timeout {
                return Some(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn stop(&self, task_id: &str) -> Option<ProcessSnapshot> {
        self.stop_with_origin(task_id, StopOrigin::Model).await
    }

    /// Stop a task on the user's behalf (`/stop`, background panel).
    ///
    /// Records the origin so the completion notification can name it. Without
    /// that the model sees a bare `killed` and has to guess why — and it guesses
    /// wrong, e.g. blaming turn teardown for a hand-stopped task.
    pub async fn stop_by_user(&self, task_id: &str) -> Option<ProcessSnapshot> {
        self.stop_with_origin(task_id, StopOrigin::User).await
    }

    async fn stop_with_origin(&self, task_id: &str, origin: StopOrigin) -> Option<ProcessSnapshot> {
        let task = self.inner.tasks.read().get(task_id).cloned()?;
        let terminal = {
            let mut state = task.state.lock();
            if state.status.is_terminal() {
                true
            } else {
                state.requested_status = Some(ProcessStatus::Killed);
                state.stopped_by_user = origin == StopOrigin::User;
                false
            }
        };
        if terminal {
            return Some(task.snapshot());
        }
        task.cancel.cancel();
        self.wait(task_id, Duration::from_secs(5)).await
    }

    /// Stop every background task and report what was asked to stop.
    ///
    /// Only reached from the user path (`/stop`, background panel), so every
    /// stop here is attributed to the user.
    ///
    /// Notifications are never suppressed. Swallowing them hid the stop from the
    /// model entirely, which left it inferring a cause from process tables and
    /// file timestamps — and inferring wrong. A task still non-terminal when
    /// `timeout` expires additionally must keep its notification so it is not
    /// marked reclaimable while the process is still writing its output file.
    pub async fn stop_all_background(&self, timeout: Duration) -> Vec<ProcessSummary> {
        let tasks = self
            .inner
            .tasks
            .read()
            .values()
            .filter(|task| {
                matches!(
                    task.state.lock().status,
                    ProcessStatus::RunningBackground(_)
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        for task in &tasks {
            let mut state = task.state.lock();
            if state.status.is_terminal() {
                continue;
            }
            state.requested_status = Some(ProcessStatus::Killed);
            state.stopped_by_user = true;
            task.cancel.cancel();
        }

        let started = Instant::now();
        while started.elapsed() < timeout {
            if tasks
                .iter()
                .all(|task| task.state.lock().status.is_terminal())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tasks.iter().map(|task| task.summary()).collect()
    }

    /// Signal every still-running process group without awaiting anything.
    ///
    /// Exit paths that call `std::process::exit` never run `Drop` impls and
    /// never poll another future, so cancellation tokens cannot be relied on
    /// there. Signalling the group directly is the only thing that reliably
    /// prevents orphaned children on `/exit`, Ctrl+C, Ctrl+D and SIGTERM.
    pub fn kill_all_now(&self) -> usize {
        self.inner.closed.store(true, Ordering::Release);
        let targets = self
            .inner
            .tasks
            .read()
            .values()
            .filter_map(|task| {
                let mut state = task.state.lock();
                if state.status.is_terminal() {
                    return None;
                }
                state.requested_status = Some(ProcessStatus::Killed);
                task.cancel.cancel();
                task.pgid
            })
            .collect::<Vec<_>>();
        let mut killed = 0;
        for pgid in targets {
            if kill_process_group(pgid) {
                killed += 1;
            }
        }
        killed
    }

    pub fn is_idle(&self) -> bool {
        self.inner.tasks.read().is_empty()
    }

    /// A manager can be evicted once every task is terminal and its completion
    /// has already been delivered or explicitly queried.
    pub fn is_reclaimable(&self) -> bool {
        self.inner.tasks.read().values().all(|task| {
            let state = task.state.lock();
            state.status.is_terminal() && state.notification_claimed
        })
    }

    /// Remove files owned by terminal tasks whose result was already claimed.
    /// Call only after the manager has been detached from the session registry.
    pub fn cleanup_reclaimable_outputs(&self) {
        let paths = self
            .inner
            .tasks
            .read()
            .values()
            .filter_map(|task| {
                let state = task.state.lock();
                (state.status.is_terminal() && state.notification_claimed)
                    .then(|| task.output_path.clone())
            })
            .collect::<Vec<_>>();
        for path in paths {
            remove_output_file(&path);
        }
    }

    /// Record what became of a task whose record is about to be dropped.
    ///
    /// `output_retained` says whether the output file survives the removal, so a
    /// later query can tell "read it there" from "it is gone".
    fn entomb(&self, task: &ProcessTask, output_retained: bool) {
        let (status, exit_code) = {
            let state = task.state.lock();
            (state.status.clone(), state.exit_code)
        };
        let mut tombstones = self.inner.tombstones.lock();
        // An id is never reused, so a repeat means the same task was reaped
        // twice; keep the newest view of it.
        tombstones.retain(|existing| existing.task_id != task.id);
        tombstones.push_back(ProcessTombstone {
            task_id: task.id.clone(),
            command: task.command.clone(),
            status,
            exit_code,
            output_path: task.output_path.clone(),
            output_retained,
        });
        while tombstones.len() > MAX_TOMBSTONES {
            tombstones.pop_front();
        }
    }

    /// Explain a task id that is no longer tracked, if it was seen before.
    pub fn reaped_summary(&self, task_id: &str) -> Option<String> {
        let tombstone = self
            .inner
            .tombstones
            .lock()
            .iter()
            .find(|entry| entry.task_id == task_id)
            .cloned()?;
        let command = tombstone.command.replace(['<', '>'], "");
        let outcome = match tombstone.exit_code {
            Some(code) => format!("{} (exit {code})", tombstone.status.as_str()),
            None => tombstone.status.as_str().to_string(),
        };
        // Lead with the fact it ran: the previous "not found" wording read as
        // "never started", which invites re-running finished work.
        let mut text = format!(
            "Task {task_id} already finished and its record was released.\nCommand: {command}\nOutcome: {outcome}"
        );
        if tombstone.output_retained {
            text.push_str(&format!(
                "\nOutput file: {}",
                tombstone.output_path.display()
            ));
        } else {
            text.push_str("\nIts output file has been cleaned up.");
        }
        text.push_str("\nDo not re-run the command solely to recover this result.");
        Some(text)
    }

    /// Explain an id that is not currently tracked.
    ///
    /// Falls back to the plain not-found wording only when the id was never
    /// seen, so a genuine typo still reads as a typo.
    pub fn missing_task_message(&self, task_id: &str) -> String {
        self.reaped_summary(task_id)
            .unwrap_or_else(|| format!("No background task found with ID: {task_id}"))
    }

    pub fn forget(&self, task_id: &str) {
        let removed = self.inner.tasks.write().remove(task_id);
        if let Some(task) = removed {
            // `forget` is the caller-consumed path: the result was just returned
            // to the model, and the output file is left in place.
            self.entomb(&task, true);
        }
        self.inner
            .notifications
            .lock()
            .retain(|notification| notification.task_id != task_id);
    }

    fn prune_claimed_terminal_tasks(&self) {
        let mut tasks = self.inner.tasks.write();
        let terminal_count = tasks
            .values()
            .filter(|task| task.state.lock().status.is_terminal())
            .count();
        let remove_count = terminal_count.saturating_sub(MAX_RETAINED_TERMINAL_TASKS);
        if remove_count == 0 {
            return;
        }

        let mut candidates = tasks
            .values()
            .filter_map(|task| {
                let state = task.state.lock();
                (state.status.is_terminal() && state.notification_claimed)
                    .then_some((task.started_at, task.id.clone()))
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(started_at, _)| *started_at);
        let removed = candidates
            .into_iter()
            .take(remove_count)
            .filter_map(|(_, task_id)| tasks.remove(&task_id))
            .collect::<Vec<_>>();
        drop(tasks);
        for task in &removed {
            // The output file goes with the record here, so the tombstone must
            // say the output is gone rather than point at a deleted path.
            self.entomb(task, false);
            remove_output_file(&task.output_path);
        }
    }

    pub fn claim_notification(&self, task_id: &str) {
        if let Some(task) = self.inner.tasks.read().get(task_id).cloned() {
            task.state.lock().notification_claimed = true;
        }
        self.inner
            .notifications
            .lock()
            .retain(|notification| notification.task_id != task_id);
    }

    pub fn take_notifications(&self) -> Vec<String> {
        let notifications = std::mem::take(&mut *self.inner.notifications.lock());
        for notification in &notifications {
            if let Some(task) = self.inner.tasks.read().get(&notification.task_id).cloned() {
                task.state.lock().notification_claimed = true;
            }
        }
        notifications
            .into_iter()
            .map(|notification| notification.text)
            .collect()
    }

    /// Notifications queued but not yet delivered to a turn.
    ///
    /// Read-only on purpose: an idle UI polls this to decide whether a task
    /// finished with nobody left to receive its result. Consuming here instead
    /// would drop the text on the floor, since a poll has no turn to put it in.
    pub fn pending_notifications(&self) -> usize {
        self.inner.notifications.lock().len()
    }

    pub fn pending_wake_notifications(&self) -> usize {
        self.inner
            .notifications
            .lock()
            .iter()
            .filter(|notification| notification.wakes_agent)
            .count()
    }

    pub async fn terminate_all_and_wait(&self, timeout: Duration) {
        self.terminate_all();
        let started = Instant::now();
        loop {
            let all_terminal = self
                .inner
                .tasks
                .read()
                .values()
                .all(|task| task.state.lock().status.is_terminal());
            if all_terminal {
                return;
            }
            if started.elapsed() >= timeout {
                tracing::warn!("timed out waiting for background processes to terminate");
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub fn terminate_all(&self) {
        let _lifecycle = self.inner.lifecycle.lock();
        self.inner.closed.store(true, Ordering::Release);
        for task in self.inner.tasks.read().values() {
            let mut state = task.state.lock();
            if state.status.is_terminal() {
                continue;
            }
            state.requested_status = Some(ProcessStatus::Killed);
            task.cancel.cancel();
        }
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            self.terminate_all();
        }
    }
}

impl ProcessTask {
    /// Wall-clock runtime. Frozen at the terminal instant so a finished task
    /// reports a stable duration instead of ticking forever.
    fn elapsed(&self, state: &ProcessState) -> Duration {
        match state.finished_at {
            Some(finished_at) => finished_at.saturating_duration_since(self.started_at),
            None => self.started_at.elapsed(),
        }
    }

    fn summary(&self) -> ProcessSummary {
        let state = self.state.lock();
        let output_file_truncated = self.output.lock().file_truncated;
        ProcessSummary {
            task_id: self.id.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            output_path: self.output_path.clone(),
            status: state.status.clone(),
            exit_code: state.exit_code,
            elapsed: self.elapsed(&state),
            output_file_truncated,
            stopped_by_user: state.stopped_by_user,
        }
    }

    /// Time since the last output byte, frozen with `elapsed` once terminal.
    fn quiet_for(&self, state: &ProcessState, output: &ProcessOutput) -> Duration {
        match state.finished_at {
            Some(finished_at) => finished_at.saturating_duration_since(output.last_activity),
            None => output.last_activity.elapsed(),
        }
    }

    fn snapshot(&self) -> ProcessSnapshot {
        let state = self.state.lock();
        let output = self.output.lock();
        let quiet_for = self.quiet_for(&state, &output);
        ProcessSnapshot {
            task_id: self.id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            command: self.command.clone(),
            description: self.description.clone(),
            cwd: self.cwd.clone(),
            output_path: self.output_path.clone(),
            output: output.text(),
            output_file_bytes: output.file_bytes,
            output_file_truncated: output.file_truncated,
            total_lines: output.total_lines(),
            status: state.status.clone(),
            exit_code: state.exit_code,
            elapsed: self.elapsed(&state),
            quiet_for,
            stall_wakes: state.stall_wakes,
            stopped_by_user: state.stopped_by_user,
        }
    }
}

async fn read_output<R>(mut reader: R, output: Arc<Mutex<ProcessOutput>>)
where R: AsyncRead + Unpin {
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => output.lock().append(&buffer[..read]),
            Err(error) => {
                tracing::warn!(%error, "background process output read failed");
                break;
            }
        }
    }
}

fn remove_output_file(path: &std::path::Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %path.display(), "background process output cleanup failed");
        }
    }
}

fn format_notification(snapshot: &ProcessSnapshot) -> String {
    format!(
        "<task-notification>\n<task-id>{}</task-id>\n<status>{}</status>\n{}{}<summary>{}</summary>\n<output-file>{}</output-file>\n</task-notification>",
        snapshot.task_id,
        snapshot.status.as_str(),
        snapshot
            .exit_code
            .map(|code| format!("<exit-code>{code}</exit-code>\n"))
            .unwrap_or_default(),
        if snapshot.output_file_truncated {
            "<output-truncated>true</output-truncated>\n"
        } else {
            ""
        },
        notification_summary(snapshot),
        snapshot.output_path.display(),
    )
}

fn notification_summary(snapshot: &ProcessSnapshot) -> String {
    // Keep the published single-line envelope intact, even for multiline scripts
    // and descriptions containing XML-like text.
    let command = notification_text(&snapshot.command);
    let outcome = match snapshot.status {
        ProcessStatus::Completed => format!("Command \"{}\" completed", command),
        ProcessStatus::Failed => format!("Command \"{}\" failed", command),
        // Unreachable in practice: notifications are only armed when a task is
        // backgrounded, and a runtime that backgrounds never lets the deadline
        // kill. Kept as a named arm so the fallback below stays reserved for a
        // genuinely unexpected state rather than describing a timeout vaguely.
        ProcessStatus::TimedOut => format!("Command \"{}\" timed out", command),
        // Cancelled, not merely stopped: the work is void. Mirrors Claude
        // Code's phrasing for a user-stopped agent — "won't be resumed" plus a
        // single explicit-ask carve-out, which closes the re-run loophole
        // without lecturing.
        ProcessStatus::Killed if snapshot.stopped_by_user => format!(
            "Command \"{}\" was cancelled by the user and won't be resumed. \
             Treat its work as cancelled; only re-run it if the user explicitly asks",
            command
        ),
        ProcessStatus::Killed => format!("Command \"{}\" was stopped", command),
        _ => format!("Command \"{}\" changed state", command),
    };
    match snapshot.description.as_deref() {
        Some(description) => format!("Task \"{}\": {outcome}", notification_text(description)),
        None => outcome,
    }
}

fn notification_text(text: &str) -> String {
    text.replace(['<', '>'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
