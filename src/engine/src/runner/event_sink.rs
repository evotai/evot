//! Event delivery port. Durable/lifecycle events await bounded capacity;
//! synchronous progress callbacks are best-effort and never block tools.
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::event::AgentEvent;

#[derive(Clone)]
pub(crate) enum EventSink {
    Legacy(mpsc::UnboundedSender<AgentEvent>),
    Bounded {
        tx: mpsc::Sender<AgentEvent>,
        cancel: CancellationToken,
    },
}

impl From<mpsc::UnboundedSender<AgentEvent>> for EventSink {
    fn from(tx: mpsc::UnboundedSender<AgentEvent>) -> Self {
        Self::Legacy(tx)
    }
}

impl EventSink {
    pub(crate) fn bounded(cancel: CancellationToken) -> (Self, mpsc::Receiver<AgentEvent>) {
        let (tx, rx) = mpsc::channel(64);
        (Self::Bounded { tx, cancel }, rx)
    }
    pub(crate) async fn send(&self, event: AgentEvent) -> Result<(), ()> {
        let failed = match self {
            Self::Legacy(tx) => tx.send(event).is_err(),
            Self::Bounded { tx, .. } => tx.send(event).await.is_err(),
        };
        if failed {
            if let Self::Bounded { cancel, .. } = self {
                cancel.cancel();
            }
            Err(())
        } else {
            Ok(())
        }
    }
    pub(crate) fn progress(&self, event: AgentEvent) {
        match self {
            Self::Legacy(tx) => {
                let _ = tx.send(event);
            }
            Self::Bounded { tx, cancel } => {
                if matches!(
                    tx.try_send(event),
                    Err(mpsc::error::TrySendError::Closed(_))
                ) {
                    cancel.cancel();
                }
                // Full: skip a transient progress update. Tool result, message
                // completion, and compaction snapshots use send(), never here.
            }
        }
    }
}
