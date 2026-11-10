//! Background process control on `NapiAgent`.

use evot::api::BackgroundReason;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::agent::NapiAgent;

#[napi]
impl NapiAgent {
    #[napi]
    pub fn background_processes(&self, session_id: String) -> Result<String> {
        serialize_process_summaries(self.agent.background_processes(&session_id))
    }

    #[napi]
    pub async fn stop_background_process(
        &self,
        session_id: String,
        task_id: String,
    ) -> Result<Option<String>> {
        let summary = self
            .agent
            .stop_background_process(&session_id, &task_id)
            .await
            .map_err(|e| Error::from_reason(format!("stop background process: {e}")))?;
        summary.map(serialize_process_summary).transpose()
    }

    /// Detach every foreground shell in a session so the turn can be reclaimed.
    ///
    /// The processes keep running; only the waiting ends. Returns how many moved.
    #[napi]
    pub fn background_foreground_processes(&self, session_id: String) -> u32 {
        self.agent
            .background_foreground_processes(&session_id, BackgroundReason::UserRequested)
            as u32
    }

    /// Same detach, attributed to a queued message needing delivery.
    ///
    /// Steering is only inspected between tool calls, so a foreground shell
    /// holds a typed message until it finishes. Detaching lets the message land
    /// while the command keeps running.
    #[napi]
    pub fn background_foreground_processes_for_message(&self, session_id: String) -> u32 {
        self.agent
            .background_foreground_processes(&session_id, BackgroundReason::MessageDelivery)
            as u32
    }

    /// Blocking `task_output` waits in flight for this session.
    ///
    /// Such a wait holds the turn while the task it watches is already
    /// backgrounded, so no foreground shell exists to detach.
    #[napi]
    pub fn blocking_task_waits(&self, session_id: String) -> u32 {
        self.agent.blocking_task_waits(&session_id) as u32
    }

    /// End in-flight blocking waits, returning how many were released. The
    /// watched tasks keep running; only the waiting ends.
    #[napi]
    pub fn release_blocking_task_waits(&self, session_id: String) -> u32 {
        self.agent.release_blocking_task_waits(&session_id) as u32
    }

    /// Completion notices queued for this session but not yet delivered.
    ///
    /// Does not consume them: only a turn can carry them, so the UI polls this
    /// to decide whether to open one.
    #[napi]
    pub fn pending_process_notifications(&self, session_id: String) -> u32 {
        self.agent.pending_process_notifications(&session_id) as u32
    }

    #[napi]
    pub fn pending_process_wake_notifications(&self, session_id: String) -> u32 {
        self.agent.pending_process_wake_notifications(&session_id) as u32
    }

    #[napi]
    pub async fn stop_all_background_processes(&self, session_id: String) -> Result<String> {
        serialize_process_summaries(self.agent.stop_all_background_processes(&session_id).await)
    }

    /// Kill every background process across all sessions without awaiting.
    /// Safe to call immediately before `fastExit`, which skips async teardown.
    #[napi]
    pub fn kill_all_background_processes_now(&self) -> u32 {
        self.agent.kill_all_background_processes_now() as u32
    }
}

fn process_summary_json(summary: &evot_engine::tools::ProcessSummary) -> serde_json::Value {
    serde_json::json!({
        "task_id": summary.task_id,
        "command": summary.command,
        "description": summary.description,
        "recent_output": summary.recent_output,
        "quiet_for_ms": summary.quiet_for.as_millis(),
        "cwd": summary.cwd,
        "output_path": summary.output_path,
        "status": summary.status.as_str(),
        "exit_code": summary.exit_code,
        "elapsed_ms": summary.elapsed.as_millis(),
        "output_file_truncated": summary.output_file_truncated,
        "stopped_by_user": summary.stopped_by_user,
    })
}

fn serialize_process_summary(summary: evot_engine::tools::ProcessSummary) -> Result<String> {
    serde_json::to_string(&process_summary_json(&summary))
        .map_err(|e| Error::from_reason(format!("serialize background process: {e}")))
}

fn serialize_process_summaries(
    summaries: Vec<evot_engine::tools::ProcessSummary>,
) -> Result<String> {
    let values = summaries
        .iter()
        .map(process_summary_json)
        .collect::<Vec<_>>();
    serde_json::to_string(&values)
        .map_err(|e| Error::from_reason(format!("serialize background processes: {e}")))
}
