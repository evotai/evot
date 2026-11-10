//! Run — a single execution handle (event stream + control plane).
//!
//! `Run` is a one-shot consumer: call `next()` to read events.
//! For control (steer / follow_up / abort), use `handle()` to get
//! a cloneable `RunControl`.
//!
//! Internally a Run may span multiple engine turns (auto-continuation
//! while the run is active). `RunControl` survives engine swaps
//! between turns; consumers see a single stable handle.

use tokio::sync::mpsc;

use super::control::RunControl;
use super::outbox::EventReceiver;
use crate::session::conversation::run_event::RunEvent;

enum Receiver {
    Live(EventReceiver),
    Fixture(mpsc::UnboundedReceiver<RunEvent>),
}

/// A single agent run. Owns the event stream and a control handle.
///
/// Not cloneable — use `handle()` to obtain a shareable `RunControl`.
pub struct Run {
    pub id: String,
    pub session_id: String,
    rx: Receiver,
    control: RunControl,
    exhausted: bool,
}

impl Drop for Run {
    fn drop(&mut self) {
        // Cancellation is synchronous even if the runtime is still building
        // its engine and cannot yet observe event-channel closure.
        if !self.exhausted {
            self.control.abort();
        }
    }
}

impl Run {
    pub(crate) fn new(
        id: String,
        session_id: String,
        rx: EventReceiver,
        control: RunControl,
    ) -> Self {
        Self {
            id,
            session_id,
            rx: Receiver::Live(rx),
            control,
            exhausted: false,
        }
    }

    /// Read the next event. Returns `None` when the run is finished.
    pub async fn next(&mut self) -> Option<RunEvent> {
        let event = match &mut self.rx {
            Receiver::Live(rx) => rx.recv().await,
            Receiver::Fixture(rx) => rx.recv().await,
        };
        if event.is_none() {
            self.exhausted = true;
        }
        event
    }

    /// Get a cloneable control handle for this run.
    pub fn handle(&self) -> RunControl {
        self.control.clone()
    }

    /// Abort this run.
    pub fn abort(&self) {
        self.control.abort();
    }

    /// Test-only constructor: create a Run from a raw receiver.
    #[doc(hidden)]
    pub fn from_receiver(
        rx: mpsc::UnboundedReceiver<RunEvent>,
        session_id: String,
        run_id: String,
    ) -> Self {
        Self {
            id: run_id,
            session_id,
            rx: Receiver::Fixture(rx),
            control: RunControl::new(),
            exhausted: false,
        }
    }
}
