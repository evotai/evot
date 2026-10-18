use evot_engine::host::HostToolResponse;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::convert::parse_content_blocks;
use crate::host::HostResponders;

/// Serialize a RunEvent to JSON string.
fn serialize_event(event: evot::api::RunEvent) -> Result<Option<String>> {
    serde_json::to_string(&event)
        .map(Some)
        .map_err(|e| Error::from_reason(format!("serialize event: {e}")))
}

/// Wire shape of a host tool response from JS: the correlation id plus the
/// engine's [`HostToolResponse`] fields, flattened.
#[derive(serde::Deserialize)]
struct HostToolResponsePayload {
    tool_call_id: String,
    #[serde(flatten)]
    response: HostToolResponse,
}

/// Abort-aware helper: read next event from run, or return None on abort.
macro_rules! next_run_or_abort {
    ($run:expr, $notify:expr) => {
        tokio::select! {
            event = $run.next() => {
                match event {
                    Some(e) => serialize_event(e),
                    None => Ok(None),
                }
            }
            _ = $notify.cancelled() => {
                $run.abort();
                Ok(None)
            }
        }
    };
}

// ---------------------------------------------------------------------------
// NapiSubmitOutcome
// ---------------------------------------------------------------------------

#[napi]
pub struct NapiSubmitOutcome {
    pub(crate) kind: String,
    pub(crate) run: std::sync::Mutex<Option<NapiRun>>,
    pub(crate) message: Option<String>,
}

#[napi]
impl NapiSubmitOutcome {
    #[napi(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }

    #[napi(getter)]
    pub fn message(&self) -> Option<String> {
        self.message.clone()
    }

    #[napi]
    pub fn take_run(&self) -> Option<NapiRun> {
        if let Ok(mut guard) = self.run.lock() {
            guard.take()
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// NapiRun — streaming event iterator for a single agent run
// ---------------------------------------------------------------------------

#[napi]
pub struct NapiRun {
    pub(crate) inner: Mutex<evot::api::Run>,
    pub(crate) handle: evot::api::RunControl,
    pub(crate) cached_session_id: String,
    pub(crate) abort_signal: CancellationToken,
    pub(crate) host_event_rx: Mutex<Option<tokio_mpsc::Receiver<String>>>,
    pub(crate) host_responders: HostResponders,
}

#[napi]
impl NapiRun {
    #[napi(getter)]
    pub fn session_id(&self) -> String {
        self.cached_session_id.clone()
    }

    /// Get the next event from the run stream.
    /// Returns null when the run is complete.
    #[napi]
    pub async fn next(&self) -> Result<Option<String>> {
        if self.abort_signal.is_cancelled() {
            return Ok(None);
        }

        let mut run = self.inner.lock().await;

        // Check if we have a host-event receiver (host tool call forwarding).
        let mut host_rx_guard = self.host_event_rx.lock().await;
        let host_rx_slot = &mut *host_rx_guard;

        match host_rx_slot {
            None => next_run_or_abort!(run, self.abort_signal),
            Some(host_rx) => {
                tokio::select! {
                    host_json = host_rx.recv() => {
                        match host_json {
                            Some(json) => Ok(Some(json)),
                            None => {
                                // Sender dropped and buffer empty — permanently
                                // disable the host branch, then read from run.
                                *host_rx_slot = None;
                                next_run_or_abort!(run, self.abort_signal)
                            }
                        }
                    }
                    event = run.next() => {
                        match event {
                            Some(e) => serialize_event(e),
                            None => Ok(None),
                        }
                    }
                    _ = self.abort_signal.cancelled() => {
                        run.abort();
                        Ok(None)
                    }
                }
            }
        }
    }

    /// Respond to a `host_tool_call` event with a JSON-encoded result.
    ///
    /// The payload is `{ tool_call_id, content, details?, is_error? }`. The
    /// call is matched to its parked responder by `tool_call_id`, so parallel
    /// host tool calls resolve independently.
    #[napi]
    pub async fn respond_host_tool(&self, response_json: String) -> Result<()> {
        let parsed: HostToolResponsePayload = serde_json::from_str(&response_json)
            .map_err(|e| Error::from_reason(format!("parse host tool response: {e}")))?;
        let mut guard = self
            .host_responders
            .lock()
            .map_err(|_| Error::from_reason("host response lock poisoned"))?;
        if let Some(tx) = guard.remove(&parsed.tool_call_id) {
            let _ = tx.send(Ok(parsed.response));
        }
        Ok(())
    }

    /// Abort the running query. Safe to call while next() is awaiting.
    #[napi]
    pub fn abort(&self) {
        self.abort_signal.cancel();
        self.handle.abort();
    }

    /// List queued prompts as JSON. `queue` is `steering` or `follow_up`.
    #[napi]
    pub fn queued_prompts(&self, queue: String) -> Result<String> {
        let entries = match queue.as_str() {
            "steering" => self.handle.queued_steering(),
            "follow_up" => self.handle.queued_follow_ups(),
            _ => {
                return Err(Error::from_reason(
                    "queue must be 'steering' or 'follow_up'",
                ))
            }
        };
        serde_json::to_string(&entries)
            .map_err(|error| Error::from_reason(format!("serialize queued prompts: {error}")))
    }

    /// Update a queued text prompt using optimistic version matching.
    #[napi]
    pub fn update_queued_prompt(
        &self,
        queue: String,
        id: String,
        version: f64,
        text: String,
    ) -> Result<String> {
        let message = evot_engine::AgentMessage::Llm(evot_engine::Message::user(text));
        let updated = match queue.as_str() {
            "steering" => self.handle.update_steering(&id, version as u64, message),
            "follow_up" => self.handle.update_follow_up(&id, version as u64, message),
            _ => {
                return Err(Error::from_reason(
                    "queue must be 'steering' or 'follow_up'",
                ))
            }
        }
        .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&updated)
            .map_err(|error| Error::from_reason(format!("serialize queued prompt: {error}")))
    }

    #[napi]
    pub fn remove_queued_prompt(
        &self,
        queue: String,
        id: String,
        version: Option<f64>,
    ) -> Result<String> {
        let version = version.map(|value| value as u64);
        let removed = match queue.as_str() {
            "steering" => self.handle.remove_steering(&id, version),
            "follow_up" => self.handle.remove_follow_up(&id, version),
            _ => {
                return Err(Error::from_reason(
                    "queue must be 'steering' or 'follow_up'",
                ))
            }
        }
        .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&removed)
            .map_err(|error| Error::from_reason(format!("serialize queued prompt: {error}")))
    }

    #[napi]
    pub fn send_queued_prompt_now(&self, id: String, version: Option<f64>) -> Result<String> {
        let sent = self
            .handle
            .send_follow_up_now(&id, version.map(|value| value as u64))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&sent)
            .map_err(|error| Error::from_reason(format!("serialize queued prompt: {error}")))
    }

    /// Move a queued prompt one position within its queue.
    #[napi]
    pub fn move_queued_prompt(
        &self,
        queue: String,
        id: String,
        version: f64,
        direction: String,
    ) -> Result<String> {
        if !matches!(queue.as_str(), "steering" | "follow_up") {
            return Err(Error::from_reason(
                "queue must be 'steering' or 'follow_up'",
            ));
        }
        if !matches!(direction.as_str(), "up" | "down") {
            return Err(Error::from_reason("direction must be 'up' or 'down'"));
        }
        let moved = self
            .handle
            .move_queued_prompt(&queue, &id, version as u64, &direction)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&moved)
            .map_err(|error| Error::from_reason(format!("serialize queued prompt: {error}")))
    }

    /// Clear all prompts in `steering` or `follow_up`.
    #[napi]
    pub fn clear_queued_prompts(&self, queue: String) -> Result<()> {
        match queue.as_str() {
            "steering" => self.handle.clear_steering(),
            "follow_up" => self.handle.clear_follow_up(),
            _ => {
                return Err(Error::from_reason(
                    "queue must be 'steering' or 'follow_up'",
                ))
            }
        }
        Ok(())
    }

    /// Send a steering message into the running agent loop.
    #[napi]
    pub fn steer(&self, text: String, content_json: Option<String>) -> Result<String> {
        let content = if let Some(json) = content_json {
            if let Ok(blocks) = parse_content_blocks(&json) {
                if blocks.is_empty() {
                    vec![evot_engine::Content::Text { text }]
                } else {
                    blocks
                }
            } else {
                vec![evot_engine::Content::Text { text }]
            }
        } else {
            vec![evot_engine::Content::Text { text }]
        };
        let entry = self
            .handle
            .steer(evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                provenance: None,
                content,
                timestamp: evot_engine::now_ms(),
            }));
        serde_json::to_string(&entry)
            .map_err(|error| Error::from_reason(format!("serialize queued prompt: {error}")))
    }

    /// Send a follow-up message (processed after current turn finishes).
    #[napi]
    pub fn follow_up(&self, text: String, content_json: Option<String>) -> Result<String> {
        let content = if let Some(json) = content_json {
            match parse_content_blocks(&json) {
                Ok(blocks) if !blocks.is_empty() => blocks,
                _ => vec![evot_engine::Content::Text { text }],
            }
        } else {
            vec![evot_engine::Content::Text { text }]
        };
        let entry =
            self.handle
                .follow_up(evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                    provenance: None,
                    content,
                    timestamp: evot_engine::now_ms(),
                }));
        serde_json::to_string(&entry)
            .map_err(|error| Error::from_reason(format!("serialize queued prompt: {error}")))
    }
}
