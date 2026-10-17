//! Session-scoped background process registries.
//!
//! One `ProcessManager` per interactive session survives per-turn tool
//! reconstruction. The registry owns admission (a bounded number of retained
//! managers, reclaiming idle ones first) and every lifecycle operation the
//! product exposes for background tasks. It never awaits while locked.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use evot_engine::tools::BackgroundReason;
use evot_engine::tools::ProcessManager;
use evot_engine::tools::ProcessStatus;
use evot_engine::tools::ProcessSummary;
use parking_lot::Mutex;

use crate::error::EvotError;
use crate::error::Result;

const PROCESS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SESSION_PROCESS_MANAGERS: usize = 256;

#[derive(Default)]
pub struct ProcessRegistry {
    managers: Mutex<HashMap<String, Arc<ProcessManager>>>,
    /// Sessions already told which transcript-announced tasks died with a
    /// previous process. Announcing once is enough; the notice stays in the
    /// context the model reads.
    orphans_announced: Mutex<HashSet<String>>,
}

impl Drop for ProcessRegistry {
    fn drop(&mut self) {
        self.terminate_all();
    }
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, session_id: &str) -> Option<Arc<ProcessManager>> {
        self.managers.lock().get(session_id).cloned()
    }

    /// Return the session's manager, creating one when the session has none.
    ///
    /// Idle managers nobody else references are dropped first; when the
    /// retained set is still full, reclaimable ones give up their outputs.
    pub fn acquire(&self, session_id: &str) -> Result<Arc<ProcessManager>> {
        let mut managers = self.managers.lock();
        managers.retain(|_, manager| !manager.is_idle() || Arc::strong_count(manager) > 1);
        if let Some(manager) = managers.get(session_id) {
            return Ok(manager.clone());
        }
        if managers.len() >= MAX_SESSION_PROCESS_MANAGERS {
            let reclaimable = managers
                .iter()
                .filter(|(_, manager)| Arc::strong_count(manager) == 1 && manager.is_reclaimable())
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            for reclaimable_id in reclaimable {
                if managers.len() < MAX_SESSION_PROCESS_MANAGERS {
                    break;
                }
                if let Some(manager) = managers.remove(&reclaimable_id) {
                    manager.cleanup_reclaimable_outputs();
                }
            }
        }
        if managers.len() >= MAX_SESSION_PROCESS_MANAGERS {
            return Err(EvotError::Run(format!(
                "too many sessions with retained background tasks (limit: {MAX_SESSION_PROCESS_MANAGERS}); inspect or clear completed tasks before starting another interactive session"
            )));
        }
        let manager = Arc::new(ProcessManager::new());
        managers.insert(session_id.to_string(), manager.clone());
        Ok(manager)
    }

    /// Record that `session_id` has been told about its orphaned tasks.
    /// Returns false when it already had been, so a notice is worded once.
    pub fn mark_orphans_announced(&self, session_id: &str) -> bool {
        self.orphans_announced.lock().insert(session_id.to_string())
    }

    /// Forget the session's manager and terminate everything it still runs.
    /// The caller holds the session lifecycle gate through this operation and
    /// any clear/delete that follows, so no new turn acquires a replacement.
    pub async fn retire(&self, session_id: &str) {
        self.orphans_announced.lock().remove(session_id);
        let manager = self.managers.lock().remove(session_id);
        if let Some(manager) = manager {
            manager
                .terminate_all_and_wait(PROCESS_SHUTDOWN_TIMEOUT)
                .await;
        }
    }

    /// Listing view of a session's background tasks. Uses the summary form so a
    /// polling caller never copies captured output.
    pub fn summaries(&self, session_id: &str) -> Vec<ProcessSummary> {
        self.get(session_id)
            .map(|manager| manager.summaries())
            .unwrap_or_default()
    }

    /// Stop one background task by id or unique id prefix.
    pub async fn stop_background(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<Option<ProcessSummary>> {
        let Some(manager) = self.get(session_id) else {
            return Ok(None);
        };
        let summaries = manager.summaries();
        let matches = summaries
            .iter()
            .filter(|summary| {
                matches!(&summary.status, ProcessStatus::RunningBackground(_))
                    && (summary.task_id == task_id || summary.task_id.starts_with(task_id))
            })
            .collect::<Vec<_>>();
        let resolved = match matches.as_slice() {
            [] => return Ok(None),
            [summary] => summary.task_id.clone(),
            _ => {
                return Err(EvotError::Run(format!(
                    "background task ID prefix is ambiguous: {task_id}"
                )))
            }
        };
        // The pending notification is deliberately left in place: the model has
        // to learn the user stopped this task, and `summaries()` below reports
        // the outcome to the caller.
        manager.stop_by_user(&resolved).await;
        Ok(manager
            .summaries()
            .into_iter()
            .find(|summary| summary.task_id == resolved))
    }

    /// Detach every foreground shell in a session, returning how many moved.
    pub fn background_foreground(&self, session_id: &str, reason: BackgroundReason) -> usize {
        self.get(session_id)
            .map(|manager| manager.background_all_foreground(reason).len())
            .unwrap_or(0)
    }

    /// Blocking `task_output` waits in flight for a session.
    pub fn blocking_waiters(&self, session_id: &str) -> usize {
        self.get(session_id)
            .map(|manager| manager.blocking_waiters())
            .unwrap_or(0)
    }

    /// End in-flight blocking waits, returning how many were released.
    pub fn release_blocking_waiters(&self, session_id: &str) -> usize {
        self.get(session_id)
            .map(|manager| manager.release_blocking_waiters())
            .unwrap_or(0)
    }

    /// Completion notices queued for a session but not yet delivered to a turn.
    pub fn pending_notifications(&self, session_id: &str) -> usize {
        self.get(session_id)
            .map(|manager| manager.pending_notifications())
            .unwrap_or(0)
    }

    pub fn pending_wake_notifications(&self, session_id: &str) -> usize {
        self.get(session_id)
            .map(|manager| manager.pending_wake_notifications())
            .unwrap_or_default()
    }

    pub async fn stop_all_background(&self, session_id: &str) -> Vec<ProcessSummary> {
        match self.get(session_id) {
            Some(manager) => manager.stop_all_background(PROCESS_SHUTDOWN_TIMEOUT).await,
            None => Vec::new(),
        }
    }

    /// Kill every background process across all sessions, synchronously.
    pub fn kill_all_now(&self) -> usize {
        let managers = self.managers.lock().values().cloned().collect::<Vec<_>>();
        managers.iter().map(|manager| manager.kill_all_now()).sum()
    }

    /// Request termination everywhere without waiting; used on drop paths.
    fn terminate_all(&self) {
        for manager in self.managers.lock().values() {
            manager.terminate_all();
        }
    }
}
