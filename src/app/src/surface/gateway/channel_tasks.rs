use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Owns channel task lifetime across HTTP startup, failure and cancellation.
/// Graceful shutdown gets one shared deadline; stalled tasks are then aborted.
pub struct ChannelTasks {
    cancel: CancellationToken,
    handles: Vec<JoinHandle<()>>,
}

impl ChannelTasks {
    pub fn new(cancel: CancellationToken, handles: Vec<JoinHandle<()>>) -> Self {
        Self { cancel, handles }
    }

    pub fn is_finished(&self) -> bool {
        self.handles.iter().all(JoinHandle::is_finished)
    }

    pub fn is_empty(&self) -> bool {
        self.handles.is_empty()
    }

    pub async fn shutdown(mut self, grace: Duration) {
        self.cancel.cancel();
        let deadline = tokio::time::Instant::now() + grace;
        for handle in &mut self.handles {
            match tokio::time::timeout_at(deadline, &mut *handle).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(%error, "channel task failed during shutdown"),
                Err(_) => {
                    handle.abort();
                    let _ = handle.await;
                }
            }
        }
        self.handles.clear();
    }
}

impl Drop for ChannelTasks {
    fn drop(&mut self) {
        self.cancel.cancel();
        for handle in &self.handles {
            handle.abort();
        }
    }
}
