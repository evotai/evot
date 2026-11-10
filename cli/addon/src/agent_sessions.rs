//! Session listing, transcripts and lifecycle on `NapiAgent`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::agent::NapiAgent;

#[napi]
impl NapiAgent {
    #[napi]
    pub async fn create_session(&self) -> Result<String> {
        let meta = self
            .agent
            .create_session("repl")
            .await
            .map_err(|e| Error::from_reason(format!("create session: {e}")))?;

        serde_json::to_string(&meta).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    #[napi]
    pub async fn list_sessions(&self, limit: Option<u32>) -> Result<String> {
        let sessions = self
            .agent
            .sessions()
            .list(limit.unwrap_or(20) as usize)
            .await
            .map_err(|e| Error::from_reason(format!("list sessions: {e}")))?;

        serde_json::to_string(&sessions).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    #[napi]
    pub async fn list_sessions_with_text(&self, limit: Option<u32>) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .list_with_text(limit.unwrap_or(0) as usize)
            .await
            .map_err(|e| Error::from_reason(format!("list sessions with text: {e}")))?;
        serde_json::to_string(&items).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// One session's text, for the resume pane's focused row. Returns `null`
    /// when the session is gone.
    #[napi]
    pub async fn session_with_text(&self, session_id: String) -> Result<Option<String>> {
        let item = self
            .agent
            .sessions()
            .with_text(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("session with text: {e}")))?;
        match item {
            Some(item) => serde_json::to_string(&item)
                .map(Some)
                .map_err(|e| Error::from_reason(format!("serialize: {e}"))),
            None => Ok(None),
        }
    }

    #[napi]
    pub async fn rename_session(&self, session_id: String, title: String) -> Result<String> {
        let session = self
            .agent
            .rename_session(&session_id, &title)
            .await
            .map_err(|e| Error::from_reason(format!("rename session: {e}")))?;
        serde_json::to_string(&session).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Fork `source_id` into a new persistent session inheriting its context.
    #[napi]
    pub async fn fork_session(&self, source_id: String, title: Option<String>) -> Result<String> {
        let meta = self
            .agent
            .fork_session(&source_id, title.as_deref())
            .await
            .map_err(|e| Error::from_reason(format!("fork session: {e}")))?;
        serde_json::to_string(&meta).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Fork ancestry, root first and `session_id` last. Empty when unknown.
    #[napi]
    pub async fn session_lineage(&self, session_id: String) -> Result<String> {
        let chain = self
            .agent
            .sessions()
            .lineage(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("session lineage: {e}")))?;
        serde_json::to_string(&chain).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    #[napi]
    pub async fn delete_session(&self, session_id: String) -> Result<bool> {
        self.agent
            .delete_session(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("delete session: {e}")))
    }

    /// Load transcript for a session.
    #[napi]
    pub async fn load_transcript(&self, session_id: String) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .transcript(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("load transcript: {e}")))?;

        serde_json::to_string(&evot::session::conversation::input::transcript_views(
            &items,
        ))
        .map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Load the effective context transcript for a session, after control markers.
    #[napi]
    pub async fn load_context_transcript(&self, session_id: String) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .context_transcript(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("load context transcript: {e}")))?;

        serde_json::to_string(&evot::session::conversation::input::transcript_views(
            &items,
        ))
        .map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Load a bounded resume view without superseded history or Engine-only
    /// compact snapshot fields.
    #[napi]
    pub async fn load_resume_transcript(&self, session_id: String) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .resume_transcript(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("load resume transcript: {e}")))?;

        serde_json::to_string(&evot::session::conversation::input::transcript_views(
            &items,
        ))
        .map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Find a single session by ID.
    #[napi]
    pub async fn find_session(&self, session_id: String) -> Result<Option<String>> {
        let meta = self
            .agent
            .sessions()
            .find(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("find session: {e}")))?;
        match meta {
            Some(m) => serde_json::to_string(&m)
                .map(Some)
                .map_err(|e| Error::from_reason(format!("serialize: {e}"))),
            None => Ok(None),
        }
    }
}
