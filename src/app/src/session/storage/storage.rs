use async_trait::async_trait;

use crate::base::error::Result;
use crate::session::storage::SessionWithText;
use crate::types::CloudSync;
use crate::types::ListSessions;
use crate::types::ListTranscriptEntries;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::VariableRecord;

#[async_trait]
pub trait Storage: Send + Sync {
    async fn save_session(&self, session: SessionMeta) -> Result<()>;
    /// Update only the user-owned name, preserving activity and automatic title.
    async fn rename_session(&self, session_id: &str, title: &str) -> Result<SessionMeta> {
        let _ = (session_id, title);
        Err(crate::base::error::EvotError::Store(
            "session rename is not supported by this backend".into(),
        ))
    }
    /// Replace only the cloud sync block, preserving activity and titles.
    async fn set_session_cloud(
        &self,
        session_id: &str,
        cloud: Option<CloudSync>,
    ) -> Result<SessionMeta> {
        let _ = (session_id, cloud);
        Err(crate::base::error::EvotError::Store(
            "cloud sync is not supported by this backend".into(),
        ))
    }
    async fn get_session(&self, session_id: &str) -> Result<Option<SessionMeta>>;
    async fn list_sessions(&self, params: ListSessions) -> Result<Vec<SessionMeta>>;
    async fn list_sessions_with_text(&self, limit: usize) -> Result<Vec<SessionWithText>>;
    /// One session's searchable and displayable text, or `None` when the
    /// session is gone. The resume pane loads the focused row this way rather
    /// than paying for every transcript in the catalog.
    async fn session_with_text(&self, session_id: &str) -> Result<Option<SessionWithText>>;
    /// Whether a session has any persisted transcript activity. Empty drafts
    /// have metadata only and must not consume slots in user-facing listings.
    async fn session_has_entries(&self, session_id: &str) -> Result<bool> {
        Ok(!self
            .list_entries(ListTranscriptEntries {
                session_id: session_id.to_string(),
                run_id: None,
                after_seq: None,
                limit: Some(1),
            })
            .await?
            .is_empty())
    }

    async fn delete_session(&self, session_id: &str) -> Result<bool>;

    async fn append_entry(&self, entry: TranscriptEntry) -> Result<()> {
        self.append_entries(vec![entry]).await
    }
    /// Append one logical transcript batch. Implementations must preserve the
    /// order of entries and avoid interleaving another batch within it.
    async fn append_entries(&self, entries: Vec<TranscriptEntry>) -> Result<()>;
    /// Atomically append a batch only when the persisted transcript still ends
    /// at `expected_seq`. Returns `false` when another writer won the race.
    async fn compare_and_append_entries(
        &self,
        expected_seq: u64,
        entries: Vec<TranscriptEntry>,
    ) -> Result<bool>;
    async fn list_entries(&self, params: ListTranscriptEntries) -> Result<Vec<TranscriptEntry>>;
    /// Load only the persisted branch that can affect the current conversation:
    /// the latest compact/marker control point and every entry after it. Storage
    /// backends may override this to avoid decoding superseded history.
    async fn load_active_entries(&self, session_id: &str) -> Result<Vec<TranscriptEntry>> {
        let entries = self
            .list_entries(ListTranscriptEntries {
                session_id: session_id.to_string(),
                run_id: None,
                after_seq: None,
                limit: None,
            })
            .await?;
        let start = entries
            .iter()
            .rposition(|entry| {
                matches!(
                    entry.item,
                    crate::types::TranscriptItem::Compact { .. }
                        | crate::types::TranscriptItem::Marker { .. }
                )
            })
            .unwrap_or(0);
        Ok(entries.into_iter().skip(start).collect())
    }

    async fn load_variables(&self) -> Result<Vec<VariableRecord>>;
    /// Insert or replace one variable, merging with whatever is on disk, and
    /// return the resulting set. A caller holding a stale snapshot must not be
    /// able to drop variables another process added.
    async fn upsert_variable(&self, record: VariableRecord) -> Result<Vec<VariableRecord>>;
    /// Remove one variable, merging with whatever is on disk. Returns whether
    /// the key existed and the resulting set.
    async fn remove_variable(&self, key: String) -> Result<(bool, Vec<VariableRecord>)>;
}
