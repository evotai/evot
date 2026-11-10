//! Process-local transport health. A status belongs to a credential generation,
//! not just a channel name, so a settings edit cannot observe an old connection.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::RwLock;
use serde::Serialize;
use sha2::Digest;

#[derive(Clone, Default, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    #[default]
    Connecting,
    Connected,
    Retrying,
    Failed,
    Stopped,
}

#[derive(Clone, Default, Debug, Serialize)]
pub struct ChannelHealth {
    pub state: ConnectionState,
    /// Safe fixed copy only; never store raw transport errors (URLs may contain tokens).
    pub message: String,
}

fn statuses() -> &'static RwLock<HashMap<String, ChannelHealth>> {
    static VALUES: OnceLock<RwLock<HashMap<String, ChannelHealth>>> = OnceLock::new();
    VALUES.get_or_init(Default::default)
}

pub fn credential_key(app_id: &str, secret: &str) -> String {
    let mut hash = sha2::Sha256::new();
    hash.update(app_id.as_bytes());
    hash.update([0]);
    hash.update(secret.as_bytes());
    format!("{:x}", hash.finalize())
}

pub fn set(key: &str, state: ConnectionState, message: &str) {
    statuses().write().insert(key.to_owned(), ChannelHealth {
        state,
        message: message.into(),
    });
}

pub fn get(key: &str) -> ChannelHealth {
    statuses().read().get(key).cloned().unwrap_or_default()
}
