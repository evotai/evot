//! In-memory storage backend for side conversations.
//!
//! Stores sessions and transcript entries in memory. Nothing is written to
//! disk. This allows side conversations to reuse the full session / run_loop
//! pipeline with multi-turn context, without persisting anything.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use super::Storage;
use crate::base::error::Result;
use crate::session::storage::SessionWithText;
use crate::types::ListSessions;
use crate::types::ListTranscriptEntries;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::VariableRecord;

/// An in-memory storage backend — all data lives in memory and is discarded
/// on drop. Used by side conversations for multi-turn context without
/// touching disk.
pub struct MemoryStorage {
    sessions: Mutex<HashMap<String, SessionMeta>>,
    entries: Mutex<Vec<TranscriptEntry>>,
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            entries: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Storage for MemoryStorage {
    async fn save_session(&self, mut session: SessionMeta) -> Result<()> {
        let mut map = self
            .sessions
            .lock()
            .map_err(|e| crate::base::error::EvotError::Store(e.to_string()))?;
        if let Some(current) = map.get(&session.session_id) {
            session.custom_title = current.custom_title.clone();
            session.cloud = current.cloud.clone();
        }
        session.schema_version = 1;
        map.insert(session.session_id.clone(), session);
        Ok(())
    }

    async fn rename_session(&self, session_id: &str, title: &str) -> Result<SessionMeta> {
        let title = super::session_title::validate(title)?;
        let mut map = self
            .sessions
            .lock()
            .map_err(|e| crate::base::error::EvotError::Store(e.to_string()))?;
        let session = map.get_mut(session_id).ok_or_else(|| {
            crate::base::error::EvotError::Session("session no longer exists".into())
        })?;
        session.custom_title = Some(title);
        session.schema_version = 1;
        Ok(session.clone())
    }

    async fn set_session_cloud(
        &self,
        session_id: &str,
        cloud: Option<crate::types::CloudSync>,
    ) -> Result<SessionMeta> {
        let mut map = self
            .sessions
            .lock()
            .map_err(|e| crate::base::error::EvotError::Store(e.to_string()))?;
        let session = map.get_mut(session_id).ok_or_else(|| {
            crate::base::error::EvotError::Session("session no longer exists".into())
        })?;
        session.cloud = cloud;
        Ok(session.clone())
    }

    async fn get_session(&self, session_id: &str) -> Result<Option<SessionMeta>> {
        let result = self
            .sessions
            .lock()
            .ok()
            .and_then(|map| map.get(session_id).cloned());
        Ok(result)
    }

    async fn session_has_entries(&self, session_id: &str) -> Result<bool> {
        Ok(self
            .entries
            .lock()
            .ok()
            .is_some_and(|entries| entries.iter().any(|entry| entry.session_id == session_id)))
    }

    async fn list_sessions(&self, params: ListSessions) -> Result<Vec<SessionMeta>> {
        let result = self
            .sessions
            .lock()
            .ok()
            .map(|map| {
                // Newest first, matching the fs backend's ordering.
                let mut sessions: Vec<_> = map.values().cloned().collect();
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                sessions
                    .into_iter()
                    .skip(params.offset)
                    .take(if params.limit == 0 {
                        usize::MAX
                    } else {
                        params.limit
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(result)
    }

    async fn delete_session(&self, session_id: &str) -> Result<bool> {
        let removed = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut map| map.remove(session_id))
            .is_some();
        if removed {
            if let Ok(mut entries) = self.entries.lock() {
                entries.retain(|e| e.session_id != session_id);
            }
        }
        Ok(removed)
    }

    async fn append_entries(&self, batch: Vec<TranscriptEntry>) -> Result<()> {
        let expected_seq = batch
            .first()
            .map(|entry| entry.seq.saturating_sub(1))
            .unwrap_or(0);
        if !self.compare_and_append_entries(expected_seq, batch).await? {
            return Err(crate::base::error::EvotError::Store(format!(
                "transcript sequence conflict: expected seq {expected_seq}"
            )));
        }
        Ok(())
    }

    async fn compare_and_append_entries(
        &self,
        expected_seq: u64,
        batch: Vec<TranscriptEntry>,
    ) -> Result<bool> {
        let Some(first) = batch.first() else {
            return Ok(true);
        };
        if batch
            .iter()
            .any(|entry| entry.session_id != first.session_id)
            || batch
                .windows(2)
                .any(|pair| pair[1].seq != pair[0].seq.saturating_add(1))
        {
            return Err(crate::base::error::EvotError::Store(
                "invalid transcript batch".to_string(),
            ));
        }
        let mut entries = self.entries.lock().map_err(|_| {
            crate::base::error::EvotError::Store("entries lock poisoned".to_string())
        })?;
        let persisted_seq = entries
            .iter()
            .filter(|entry| entry.session_id == first.session_id)
            .map(|entry| entry.seq)
            .max()
            .unwrap_or(0);
        if persisted_seq != expected_seq || first.seq != expected_seq.saturating_add(1) {
            return Ok(false);
        }
        entries.extend(batch);
        Ok(true)
    }

    async fn list_entries(&self, params: ListTranscriptEntries) -> Result<Vec<TranscriptEntry>> {
        let result = self
            .entries
            .lock()
            .ok()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|e| e.session_id == params.session_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Ok(result)
    }

    async fn load_variables(&self) -> Result<Vec<VariableRecord>> {
        Ok(vec![])
    }

    async fn upsert_variable(&self, _record: VariableRecord) -> Result<Vec<VariableRecord>> {
        Ok(vec![])
    }

    async fn remove_variable(&self, _key: String) -> Result<(bool, Vec<VariableRecord>)> {
        Ok((false, vec![]))
    }

    async fn list_sessions_with_text(&self, limit: usize) -> Result<Vec<SessionWithText>> {
        let sessions = self
            .list_sessions(ListSessions {
                limit: 0,
                offset: 0,
            })
            .await?;

        let mut result = Vec::new();
        for session in sessions {
            let session_entries = self.session_entries(&session.session_id);
            if session.turns == 0 && session.title.is_none() && session_entries.is_empty() {
                continue;
            }
            result.push(SessionWithText::extract(session, &session_entries));
            if limit > 0 && result.len() == limit {
                break;
            }
        }

        Ok(result)
    }

    async fn session_with_text(&self, session_id: &str) -> Result<Option<SessionWithText>> {
        let Some(session) = self.get_session(session_id).await? else {
            return Ok(None);
        };
        let entries = self.session_entries(session_id);
        Ok(Some(SessionWithText::extract(session, &entries)))
    }
}

impl MemoryStorage {
    fn session_entries(&self, session_id: &str) -> Vec<TranscriptEntry> {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| entry.session_id == session_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}
