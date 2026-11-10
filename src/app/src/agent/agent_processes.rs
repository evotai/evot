//! Background process control on the agent.

use super::agent::Agent;
use crate::base::error::Result;

impl Agent {
    /// Listing view of a session's background tasks. Uses the summary form so a
    /// polling caller never copies captured output.
    pub fn background_processes(
        &self,
        session_id: &str,
    ) -> Vec<evot_engine::tools::ProcessSummary> {
        self.assembler.processes.summaries(session_id)
    }

    pub async fn stop_background_process(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<Option<evot_engine::tools::ProcessSummary>> {
        self.assembler
            .processes
            .stop_background(session_id, task_id)
            .await
    }

    /// Detach every foreground shell in a session, returning how many moved.
    ///
    /// The processes keep running; only the waiting ends. Used when the user
    /// wants the turn back without discarding work in flight.
    pub fn background_foreground_processes(
        &self,
        session_id: &str,
        reason: evot_engine::tools::BackgroundReason,
    ) -> usize {
        self.assembler
            .processes
            .background_foreground(session_id, reason)
    }

    /// Blocking `task_output` waits in flight for a session.
    ///
    /// Such a wait holds the whole turn while the task it watches is already
    /// backgrounded, so there is no foreground shell to detach — the UI needs
    /// this count to know ctrl+b has something to release.
    pub fn blocking_task_waits(&self, session_id: &str) -> usize {
        self.assembler.processes.blocking_waiters(session_id)
    }

    /// End in-flight blocking waits, returning how many were released.
    ///
    /// The watched tasks keep running; only the waiting ends.
    pub fn release_blocking_task_waits(&self, session_id: &str) -> usize {
        self.assembler
            .processes
            .release_blocking_waiters(session_id)
    }

    /// Completion notices queued for a session but not yet delivered to a turn.
    ///
    /// Non-consuming: the caller is deciding *whether* to open a turn, and a
    /// turn is the only thing that can actually carry these. `build_turn`
    /// drains them via `take_notifications`.
    pub fn pending_process_notifications(&self, session_id: &str) -> usize {
        self.assembler.processes.pending_notifications(session_id)
    }

    pub fn pending_process_wake_notifications(&self, session_id: &str) -> usize {
        self.assembler
            .processes
            .pending_wake_notifications(session_id)
    }

    pub async fn stop_all_background_processes(
        &self,
        session_id: &str,
    ) -> Vec<evot_engine::tools::ProcessSummary> {
        self.assembler
            .processes
            .stop_all_background(session_id)
            .await
    }

    /// Kill every background process across all sessions, synchronously.
    ///
    /// Used on process-exit paths that bypass async teardown, where waiting is
    /// not possible and orphaned children are the failure mode.
    pub fn kill_all_background_processes_now(&self) -> usize {
        self.assembler.processes.kill_all_now()
    }
}
