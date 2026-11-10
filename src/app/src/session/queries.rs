use std::sync::Arc;

use crate::base::error::Result;
use crate::session::storage::Storage;
use crate::session::Session;
use crate::types::ListSessions;
use crate::types::ListTranscriptEntries;
use crate::types::SessionMeta;
use crate::types::TranscriptItem;

/// Read-side application service. Owns visibility and replay policy, not run
/// lifecycle or storage mutation. The repository is supplied by composition.
pub struct SessionQueries {
    storage: Arc<dyn Storage>,
}

impl SessionQueries {
    pub fn new(storage: Arc<dyn Storage>) -> Self {
        Self { storage }
    }

    pub async fn list(&self, limit: usize) -> Result<Vec<SessionMeta>> {
        let sessions = self
            .storage
            .list_sessions(ListSessions {
                limit: 0,
                offset: 0,
            })
            .await?;
        let mut visible = Vec::new();
        for session in sessions {
            // Limit after excluding abandoned drafts, not before.
            let is_draft = session.turns == 0
                && session.title.is_none()
                && !self
                    .storage
                    .session_has_entries(&session.session_id)
                    .await?;
            if !is_draft {
                visible.push(session);
                if limit > 0 && visible.len() == limit {
                    break;
                }
            }
        }
        Ok(visible)
    }

    pub async fn list_with_text(
        &self,
        limit: usize,
    ) -> Result<Vec<crate::session::storage::SessionWithText>> {
        self.storage.list_sessions_with_text(limit).await
    }

    /// One session's text, for the resume pane's focused row.
    pub async fn with_text(
        &self,
        id: &str,
    ) -> Result<Option<crate::session::storage::SessionWithText>> {
        self.storage.session_with_text(id).await
    }

    pub async fn find(&self, id: &str) -> Result<Option<SessionMeta>> {
        self.storage.get_session(id).await
    }

    /// Fork ancestry of a session, root first and `id` last. The chain stops
    /// at the first missing parent (deleted sessions make their children
    /// roots) and refuses to loop on corrupted parent links. Unknown `id`
    /// yields an empty chain.
    pub async fn lineage(&self, id: &str) -> Result<Vec<SessionMeta>> {
        let mut chain = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut cursor = Some(id.to_string());
        while let Some(current) = cursor {
            if !seen.insert(current.clone()) {
                break;
            }
            let Some(meta) = self.storage.get_session(&current).await? else {
                break;
            };
            cursor = meta.parent_session_id.clone();
            chain.push(meta);
        }
        chain.reverse();
        Ok(chain)
    }

    pub async fn transcript(&self, id: &str) -> Result<Vec<TranscriptItem>> {
        if self.find(id).await?.is_none() {
            return Ok(Vec::new());
        }
        let entries = self
            .storage
            .list_entries(ListTranscriptEntries {
                session_id: id.to_string(),
                run_id: None,
                after_seq: None,
                limit: None,
            })
            .await?;
        Ok(entries.into_iter().map(|entry| entry.item).collect())
    }

    pub async fn context_transcript(&self, id: &str) -> Result<Vec<TranscriptItem>> {
        match Session::open(id, self.storage.clone()).await? {
            Some(session) => Ok(session.transcript().await),
            None => Ok(Vec::new()),
        }
    }

    pub async fn resume_transcript(&self, id: &str) -> Result<Vec<TranscriptItem>> {
        if self.find(id).await?.is_none() {
            return Ok(Vec::new());
        }
        Ok(super::replay::resume_transcript_items(
            self.storage.load_active_entries(id).await?,
        ))
    }
}
