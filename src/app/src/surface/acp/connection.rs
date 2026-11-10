//! One ACP connection's wire layer: JSON-RPC 2.0 over newline-delimited
//! frames. Owns everything written to the client and the agent → client
//! requests awaiting an answer. Knows nothing about sessions or the agent.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use agent_client_protocol_schema::v1 as acp;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use serde_json::Value;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

/// One parsed inbound frame.
pub(super) enum Inbound {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// The client's answer to one of this agent's requests.
    Response {
        id: Value,
        frame: Value,
    },
}

impl Inbound {
    /// `Err` is the error to send back for a line that is not a JSON-RPC message.
    pub(super) fn parse(line: &str) -> Result<Self, acp::Error> {
        let message: Value = serde_json::from_str(line).map_err(|_| acp::Error::parse_error())?;
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        match (method, id) {
            (Some(method), Some(id)) => Ok(Self::Request { id, method, params }),
            (Some(method), None) => Ok(Self::Notification { method, params }),
            (None, Some(id)) => Ok(Self::Response { id, frame: message }),
            (None, None) => Err(acp::Error::invalid_request()),
        }
    }
}

/// Outbound side of the connection. Cheap to share; frames are queued to a
/// single writer task so they never interleave.
pub(super) struct Connection {
    out: mpsc::UnboundedSender<String>,
    next_request_id: AtomicU64,
    /// Agent → client requests awaiting a response, by request ID.
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl Connection {
    /// Returns the connection and the receiver [`write_frames`] drains.
    pub(super) fn new() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (out, rx) = mpsc::unbounded_channel();
        let connection = Self {
            out,
            next_request_id: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
        };
        (connection, rx)
    }

    pub(super) fn reply<T: Serialize>(&self, id: Value, result: Result<T, acp::Error>) {
        match result.and_then(to_value) {
            Ok(result) => self.send(json!({"jsonrpc": "2.0", "id": id, "result": result})),
            Err(error) => self.error(id, error),
        }
    }

    pub(super) fn error(&self, id: Value, error: acp::Error) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": error}));
    }

    pub(super) fn notify<T: Serialize>(&self, method: &str, params: T) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    /// `session/update` for one session.
    pub(super) fn update(&self, session_id: &str, update: acp::SessionUpdate) {
        let notification = acp::SessionNotification::new(session_id.to_string(), update);
        self.notify("session/update", notification);
    }

    /// Ask the client something and wait for its `result`. `None` when the
    /// client answered with an error or disconnected first.
    pub(super) async fn request<T: Serialize>(&self, method: &str, params: T) -> Option<Value> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        // Dropped before the answer arrives (cancelled call): stop waiting for it.
        let _forget = Forget {
            connection: self,
            id,
        };
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let mut frame = rx.await.ok()?;
        frame.get_mut("result").map(Value::take)
    }

    /// Route the client's response to the request waiting for it. Unknown or
    /// late IDs are dropped.
    pub(super) fn resolve(&self, id: &Value, frame: Value) {
        let Some(id) = id.as_u64() else {
            return;
        };
        if let Some(tx) = self.pending.lock().remove(&id) {
            let _ = tx.send(frame);
        }
    }

    /// Client disconnected: every waiting request resolves as unanswered.
    pub(super) fn close(&self) {
        self.pending.lock().clear();
    }

    fn send(&self, frame: Value) {
        match serde_json::to_string(&frame) {
            Ok(line) => {
                let _ = self.out.send(line);
            }
            Err(error) => tracing::warn!("acp: cannot serialize frame: {error}"),
        }
    }
}

struct Forget<'a> {
    connection: &'a Connection,
    id: u64,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.connection.pending.lock().remove(&self.id);
    }
}

/// Write queued frames, one per line, until every [`Connection`] is dropped.
pub(super) async fn write_frames<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut rx: mpsc::UnboundedReceiver<String>,
) -> std::io::Result<()> {
    while let Some(mut line) = rx.recv().await {
        line.push('\n');
        writer.write_all(line.as_bytes()).await?;
        writer.flush().await?;
    }
    Ok(())
}

pub(super) fn to_value<T: Serialize>(value: T) -> Result<Value, acp::Error> {
    serde_json::to_value(value).map_err(acp::Error::into_internal_error)
}
