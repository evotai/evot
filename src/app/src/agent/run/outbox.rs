//! Live delivery for the UI stream, independent of transcript persistence.
//!
//! Persistence is the source of truth, so a slow consumer must never cancel
//! the run. Bursty streaming deltas coalesce into fewer events (same order,
//! same content), and large payloads wait for the consumer instead of growing
//! without bound. Delivery ends only when the consumer is gone.
use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::control::RunControl;
use crate::session::conversation::run_event::RunEvent;
use crate::session::conversation::run_event::RunEventPayload;
use crate::session::conversation::run_event::ToolCallStreamPhase;

/// Once more than this many events are queued, adjacent deltas merge.
const COALESCE_AFTER_EVENTS: usize = 64;
/// Queue memory before the producer waits for the consumer to drain.
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;

fn event_bytes(event: &RunEvent) -> usize {
    // Content dominates. Fixed headroom covers ids, timestamps and field names.
    256 + match &event.payload {
        RunEventPayload::AssistantDelta { delta, .. } => delta.len(),
        RunEventPayload::AssistantToolCall { delta, args, .. } => {
            delta.as_ref().map_or(0, String::len)
                + args.as_ref().map_or(0, |value| value.to_string().len())
        }
        payload => serde_json::to_vec(payload).map_or(MAX_PENDING_BYTES, |bytes| bytes.len()),
    }
}

fn coalesce(last: &mut RunEvent, next: &RunEvent) -> bool {
    match (&mut last.payload, &next.payload) {
        (
            RunEventPayload::AssistantDelta {
                content_index,
                content_type,
                delta,
            },
            RunEventPayload::AssistantDelta {
                content_index: next_index,
                content_type: next_type,
                delta: next_delta,
            },
        ) if content_index == next_index
            && std::mem::discriminant(content_type) == std::mem::discriminant(next_type) =>
        {
            delta.push_str(next_delta);
            true
        }
        (
            RunEventPayload::AssistantToolCall {
                tool_call_id,
                phase: ToolCallStreamPhase::Delta,
                delta: Some(delta),
                ..
            },
            RunEventPayload::AssistantToolCall {
                tool_call_id: next_id,
                phase: ToolCallStreamPhase::Delta,
                delta: Some(next_delta),
                ..
            },
        ) if tool_call_id == next_id => {
            delta.push_str(next_delta);
            true
        }
        _ => false,
    }
}

struct State {
    events: VecDeque<(RunEvent, usize)>,
    pending_bytes: usize,
    sender_closed: bool,
}
struct Shared {
    state: Mutex<State>,
    ready: Notify,
    drained: Notify,
    receiver_closed: CancellationToken,
}

#[derive(Debug)]
pub struct DeliveryClosed;

pub struct EventSender(Arc<Shared>);
pub struct EventReceiver(Arc<Shared>);

pub fn event_channel(_control: RunControl) -> (EventSender, EventReceiver) {
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            events: VecDeque::new(),
            pending_bytes: 0,
            sender_closed: false,
        }),
        ready: Notify::new(),
        drained: Notify::new(),
        receiver_closed: CancellationToken::new(),
    });
    (EventSender(shared.clone()), EventReceiver(shared))
}

impl EventSender {
    /// Queue an event. `Err` means the consumer is gone. Never cancels the run.
    pub fn send(&self, event: RunEvent) -> Result<(), DeliveryClosed> {
        let bytes = event_bytes(&event);
        let mut state = self.0.state.lock();
        if self.0.receiver_closed.is_cancelled() {
            return Err(DeliveryClosed);
        }
        if state.events.len() >= COALESCE_AFTER_EVENTS {
            if let Some((last, last_bytes)) = state.events.back_mut() {
                if coalesce(last, &event) {
                    let added = bytes.saturating_sub(256);
                    *last_bytes = last_bytes.saturating_add(added);
                    state.pending_bytes = state.pending_bytes.saturating_add(added);
                    drop(state);
                    self.0.ready.notify_one();
                    return Ok(());
                }
            }
        }
        state.pending_bytes = state.pending_bytes.saturating_add(bytes);
        state.events.push_back((event, bytes));
        drop(state);
        self.0.ready.notify_one();
        Ok(())
    }

    /// Wait while queued bytes exceed the budget. Returns immediately once the
    /// consumer is gone, so a closed UI never blocks the engine.
    pub async fn wait_for_capacity(&self) {
        loop {
            let drained = self.0.drained.notified();
            if self.0.receiver_closed.is_cancelled()
                || self.0.state.lock().pending_bytes <= MAX_PENDING_BYTES
            {
                return;
            }
            tokio::select! {
                _ = drained => {}
                _ = self.0.receiver_closed.cancelled() => return,
            }
        }
    }

    pub fn over_budget(&self) -> bool {
        self.0.state.lock().pending_bytes > MAX_PENDING_BYTES
    }

    pub async fn closed(&self) {
        self.0.receiver_closed.cancelled().await;
    }
}
impl Drop for EventSender {
    fn drop(&mut self) {
        self.0.state.lock().sender_closed = true;
        self.0.ready.notify_one();
    }
}
impl EventReceiver {
    pub async fn recv(&mut self) -> Option<RunEvent> {
        loop {
            let ready = self.0.ready.notified();
            {
                let mut state = self.0.state.lock();
                if let Some((event, bytes)) = state.events.pop_front() {
                    state.pending_bytes = state.pending_bytes.saturating_sub(bytes);
                    drop(state);
                    self.0.drained.notify_waiters();
                    return Some(event);
                }
                if state.sender_closed {
                    return None;
                }
            }
            ready.await;
        }
    }
}
impl Drop for EventReceiver {
    fn drop(&mut self) {
        self.0.receiver_closed.cancel();
    }
}
