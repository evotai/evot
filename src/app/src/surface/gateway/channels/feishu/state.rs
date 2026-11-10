use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;

use fs2::FileExt;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;

use crate::base::error::EvotError;
use crate::base::error::Result;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Default, Serialize, Deserialize)]
struct DirectChatState {
    /// Missing version means legacy v0, which had the same shape.
    #[serde(default)]
    schema_version: u32,
    /// One p2p chat per Feishu sender. Kept private on the local device.
    #[serde(default)]
    chats_by_sender: BTreeMap<String, String>,
}

/// Local record of direct conversations with one Feishu app.
///
/// Feishu apps have no static default chat ID, so the chats a bot can reach 1:1
/// are learned from inbound p2p events. This store only remembers them; whether
/// a scheduled result may fan out to all of them is decided by
/// [`super::target`], and never by default.
pub struct DirectChatStore {
    root: PathBuf,
}

impl DirectChatStore {
    pub fn new(state_root: impl Into<PathBuf>) -> Self {
        Self {
            root: state_root.into().join("channels").join("feishu"),
        }
    }

    pub fn direct_chats(&self, app_id: &str) -> Result<Vec<String>> {
        let state = self.load(app_id)?;
        let chats: BTreeSet<&str> = state.chats_by_sender.values().map(String::as_str).collect();
        Ok(chats.into_iter().map(str::to_string).collect())
    }

    pub fn remember(&self, app_id: &str, sender_id: &str, chat_id: &str) -> Result<()> {
        let sender_id = sender_id.trim();
        if sender_id.is_empty() {
            return Err(EvotError::Conf(
                "Feishu direct conversation has no sender ID".into(),
            ));
        }
        validate_chat_id(chat_id)?;
        let path = self.path(app_id)?;
        let parent = path
            .parent()
            .ok_or_else(|| EvotError::Conf("Feishu direct-chat path has no parent".into()))?;
        std::fs::create_dir_all(parent)?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))?;
        FileExt::lock_exclusive(&lock)?;
        let result = (|| {
            let mut state = self.load(app_id)?;
            state.schema_version = SCHEMA_VERSION;
            state
                .chats_by_sender
                .insert(sender_id.to_string(), chat_id.to_string());
            crate::base::atomic_file::write_private_atomic(
                &path,
                &serde_json::to_vec_pretty(&state)?,
            )
        })();
        FileExt::unlock(&lock)?;
        result
    }

    fn load(&self, app_id: &str) -> Result<DirectChatState> {
        let path = self.path(app_id)?;
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(DirectChatState {
                    schema_version: SCHEMA_VERSION,
                    chats_by_sender: BTreeMap::new(),
                });
            }
            Err(error) => return Err(error.into()),
        };
        let state: DirectChatState = serde_json::from_slice(&raw).map_err(|error| {
            EvotError::Conf(format!(
                "invalid Feishu direct-chat state {}: {error}",
                path.display()
            ))
        })?;
        if state.schema_version > SCHEMA_VERSION {
            return Err(EvotError::Conf(format!(
                "unsupported Feishu direct-chat state version {} (this build reads up to {SCHEMA_VERSION})",
                state.schema_version
            )));
        }
        for chat_id in state.chats_by_sender.values() {
            validate_chat_id(chat_id)?;
        }
        Ok(state)
    }

    fn path(&self, app_id: &str) -> Result<PathBuf> {
        let app_id = app_id.trim();
        if app_id.is_empty() {
            return Err(EvotError::Conf("Feishu app ID is empty".into()));
        }
        let digest = sha2::Sha256::digest(app_id.as_bytes());
        Ok(self.root.join(format!("{}.json", hex(&digest[..16]))))
    }
}

pub fn load_direct_chats(app_id: &str) -> Result<Vec<String>> {
    DirectChatStore::new(crate::base::paths::state_root_dir()?).direct_chats(app_id)
}

pub fn remember_direct_chat(app_id: &str, sender_id: &str, chat_id: &str) -> Result<()> {
    DirectChatStore::new(crate::base::paths::state_root_dir()?).remember(app_id, sender_id, chat_id)
}

fn validate_chat_id(chat_id: &str) -> Result<()> {
    if !chat_id.starts_with("oc_") {
        return Err(EvotError::Conf(
            "Feishu direct conversation has an invalid chat ID".into(),
        ));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
