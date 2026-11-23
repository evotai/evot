//! RunControl — app-level control plane for a Run.
//!
//! Lives across multiple internal engine turns. Prompt queues are owned at this
//! level and injected into each engine instance, so messages remain editable and
//! cannot disappear during the gap between turns.

use std::sync::Arc;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use super::queue::RunQueues;
use crate::agent::model_handoff::UserHandoffs;
use crate::agent::models::ModelSelection;
use crate::base::error::EvotError;
use crate::conf::Config;

#[derive(Clone)]
pub struct RunControl {
    cancel: CancellationToken,
    engine: Arc<Mutex<Option<evot_engine::RunHandle>>>,
    queues: RunQueues,
    pub(super) user_handoffs: Option<Arc<UserHandoffs>>,
}

impl RunControl {
    pub fn new() -> Self {
        Self {
            cancel: CancellationToken::new(),
            engine: Arc::new(Mutex::new(None)),
            queues: RunQueues::new(),
            user_handoffs: None,
        }
    }

    pub(super) fn with_user_handoffs(mut self, selection: Arc<ModelSelection>) -> Self {
        self.user_handoffs = Some(Arc::new(UserHandoffs::new(selection)));
        self
    }

    /// Queue a model for this run's next request and return its resolved spec.
    /// Does not abort the run.
    pub fn request_model_handoff(
        &self,
        config: &Config,
        spec: &str,
        effort: Option<&str>,
    ) -> crate::base::error::Result<String> {
        let handoffs = self.user_handoffs.as_ref().ok_or_else(|| {
            EvotError::Run("Model switching is not available for this run".into())
        })?;
        handoffs.request(config, spec, effort)
    }

    pub(in crate::agent) fn install_engine(&self, handle: evot_engine::RunHandle) {
        let mut engine = self.engine.lock();
        // Cancellation may win while a turn is being built, before it has an
        // engine handle. Never attach a fresh uncancelled engine to an aborted
        // run. Share the lock with abort() to cover either ordering.
        if self.cancel.is_cancelled() {
            handle.abort();
        }
        *engine = Some(handle);
    }

    pub(in crate::agent) fn detach_engine(&self) {
        *self.engine.lock() = None;
    }

    pub(in crate::agent) fn queues(&self) -> RunQueues {
        self.queues.clone()
    }

    pub fn abort(&self) {
        self.cancel.cancel();
        if let Some(handoffs) = &self.user_handoffs {
            handoffs.close();
        }
        if let Some(handle) = self.engine.lock().as_ref() {
            handle.abort();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub(super) fn segment_cancellation(&self) -> CancellationToken {
        self.cancel.child_token()
    }

    pub fn steer(&self, msg: evot_engine::AgentMessage) -> evot_engine::PromptQueueEntry {
        self.queues.enqueue_steering(msg)
    }

    pub fn follow_up(&self, msg: evot_engine::AgentMessage) -> evot_engine::PromptQueueEntry {
        self.queues.enqueue_follow_up(msg)
    }

    pub fn queued_steering(&self) -> Vec<evot_engine::PromptQueueEntry> {
        self.queues.list_steering()
    }

    pub fn queued_follow_ups(&self) -> Vec<evot_engine::PromptQueueEntry> {
        self.queues.list_follow_up()
    }

    pub fn update_steering(
        &self,
        id: &str,
        version: u64,
        msg: evot_engine::AgentMessage,
    ) -> Result<evot_engine::PromptQueueEntry, evot_engine::PromptQueueError> {
        self.queues.update_steering(id, version, msg)
    }

    pub fn update_follow_up(
        &self,
        id: &str,
        version: u64,
        msg: evot_engine::AgentMessage,
    ) -> Result<evot_engine::PromptQueueEntry, evot_engine::PromptQueueError> {
        self.queues.update_follow_up(id, version, msg)
    }

    pub fn remove_steering(
        &self,
        id: &str,
        version: Option<u64>,
    ) -> Result<evot_engine::PromptQueueEntry, evot_engine::PromptQueueError> {
        self.queues.remove_steering(id, version)
    }

    pub fn remove_follow_up(
        &self,
        id: &str,
        version: Option<u64>,
    ) -> Result<evot_engine::PromptQueueEntry, evot_engine::PromptQueueError> {
        self.queues.remove_follow_up(id, version)
    }

    pub fn move_queued_prompt(
        &self,
        queue: &str,
        id: &str,
        version: u64,
        direction: &str,
    ) -> Result<evot_engine::PromptQueueEntry, evot_engine::PromptQueueError> {
        match (queue, direction) {
            ("steering", "up") => self.queues.move_steering_up(id, version),
            ("steering", "down") => self.queues.move_steering_down(id, version),
            ("follow_up", "up") => self.queues.move_follow_up_up(id, version),
            ("follow_up", "down") => self.queues.move_follow_up_down(id, version),
            _ => Err(evot_engine::PromptQueueError::NotFound(format!(
                "invalid queue move: {queue}/{direction}"
            ))),
        }
    }

    pub fn send_follow_up_now(
        &self,
        id: &str,
        version: Option<u64>,
    ) -> Result<evot_engine::PromptQueueEntry, evot_engine::PromptQueueError> {
        self.queues.send_follow_up_now(id, version)
    }

    pub fn clear_steering(&self) {
        self.queues.clear_steering()
    }

    pub fn clear_follow_up(&self) {
        self.queues.clear_follow_up()
    }
}

impl Default for RunControl {
    fn default() -> Self {
        Self::new()
    }
}
