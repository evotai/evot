use std::convert::Infallible;

use crate::session::conversation::chat_projection as chat;
use crate::session::conversation::RunEvent;
use crate::types::SessionMeta;

pub type SseEvent = std::result::Result<axum::response::sse::Event, Infallible>;

pub fn done_event() -> SseEvent {
    encode(&chat::done_node().to_sse_json())
}

pub fn error_event(message: impl Into<String>) -> SseEvent {
    encode(&chat::error_node(message).to_sse_json())
}

pub fn text_event(text: &str) -> SseEvent {
    encode(&chat::command_node(text).to_sse_json())
}

/// Stable JSON shape for the session identity sent at the start of a run.
pub fn session_event_json(session_id: &str) -> serde_json::Value {
    chat::session_node_from_id(session_id, None).to_sse_json()
}

pub fn session_meta_event(meta: &SessionMeta) -> SseEvent {
    encode(&chat::session_node(meta).to_sse_json())
}

/// Identify the session created or resumed for this stream. Sent before run
/// output so browser clients can bind follow-up messages to the same session.
pub fn session_event(session_id: &str) -> SseEvent {
    encode(&session_event_json(session_id))
}

/// Map a RunEvent to a list of SSE JSON payloads (stable, testable).
/// Each returned Value has shape: { "type": "...", ...node fields }
pub fn map_run_event_json(run_event: &RunEvent) -> Vec<serde_json::Value> {
    chat::map_run_event(run_event)
        .into_iter()
        .map(|node| node.to_sse_json())
        .collect()
}

pub fn map_run_event(run_event: &RunEvent) -> Vec<SseEvent> {
    map_run_event_json(run_event)
        .into_iter()
        .map(|payload| encode(&payload))
        .collect()
}

fn encode(payload: &serde_json::Value) -> SseEvent {
    match serde_json::to_string(payload) {
        Ok(json) => Ok(axum::response::sse::Event::default().data(json)),
        Err(_) => Ok(axum::response::sse::Event::default().data(String::new())),
    }
}
