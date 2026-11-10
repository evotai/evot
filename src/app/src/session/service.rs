//! Session preparation, independent of providers, runs and access adapters.
//!
//! The caller supplies a frozen model selection. Existing sessions retain their
//! original workspace and source; an explicit workspace applies only at creation.
use std::sync::Arc;

use super::Session;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::session::storage::Storage;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;

pub struct SessionSelection {
    pub provider: String,
    pub model: String,
    pub thinking_level: Option<String>,
}

pub struct SessionService {
    storage: Arc<dyn Storage>,
    default_workspace: String,
}

impl SessionService {
    pub fn new(storage: Arc<dyn Storage>, default_workspace: String) -> Self {
        Self {
            storage,
            default_workspace,
        }
    }

    pub async fn load(&self, id: &str) -> Result<Option<Arc<Session>>> {
        Session::open(id, self.storage.clone()).await
    }

    /// Blank drafts do not stamp reasoning effort until a run begins.
    pub async fn create(
        &self,
        source: &str,
        cwd: Option<&str>,
        provider: String,
        model: String,
    ) -> Result<SessionMeta> {
        let session = Session::new_with_provider_source(
            crate::types::new_id(),
            self.creation_workspace(cwd)?,
            provider,
            model,
            source,
            self.storage.clone(),
        )
        .await?;
        Ok(session.meta().await)
    }

    /// Copy a session's active context branch into a new session that records
    /// `source_id` as its parent. The source is left untouched. Only the branch
    /// after the latest compact/marker is copied, so the fork costs the same
    /// context the parent currently pays for.
    pub async fn fork(&self, source_id: &str, title: Option<&str>) -> Result<SessionMeta> {
        let source = self
            .storage
            .get_session(source_id)
            .await?
            .ok_or_else(|| EvotError::Session(format!("session not found: {source_id}")))?;
        let custom_title = match title.map(str::trim).filter(|t| !t.is_empty()) {
            Some(title) => Some(crate::session::storage::session_title::validate(title)?),
            None => None,
        };
        let entries = self.storage.load_active_entries(source_id).await?;

        let mut meta = SessionMeta::new(
            crate::types::new_id(),
            source.cwd.clone(),
            source.model.clone(),
        )
        .with_provider(source.provider.clone())
        .with_source(source.source.as_str());
        meta.thinking_level = source.thinking_level.clone();
        meta.title = source.title.clone();
        meta.custom_title = custom_title;
        meta.turns = source.turns;
        meta.message_count = source.message_count;
        meta.context_tokens = source.context_tokens;
        meta.context_budget = source.context_budget;
        meta.span_count = source.span_count;
        meta.parent_session_id = Some(source.session_id.clone());
        meta.fork_seq = Some(entries.last().map(|entry| entry.seq).unwrap_or(0));

        let copied: Vec<TranscriptEntry> = entries
            .into_iter()
            .enumerate()
            .map(|(index, mut entry)| {
                entry.session_id = meta.session_id.clone();
                entry.run_id = None;
                entry.seq = index as u64 + 1;
                entry
            })
            .collect();

        self.storage.save_session(meta.clone()).await?;
        if !copied.is_empty() {
            self.storage.append_entries(copied).await?;
        }
        Ok(meta)
    }

    /// Resolve a run's session, preserving existing workspace/source metadata.
    /// Admission and clear/delete synchronization stay with the run owner.
    pub async fn resolve(
        &self,
        id: Option<&str>,
        source: &str,
        selection: SessionSelection,
        cwd: Option<&str>,
    ) -> Result<Arc<Session>> {
        let SessionSelection {
            provider,
            model,
            thinking_level,
        } = selection;
        let existing = match id {
            Some(id) => self.load(id).await?,
            None => None,
        };
        let session = match existing {
            Some(session) => {
                session.set_model_selection(provider, model).await?;
                session
            }
            None => {
                Session::new_with_provider_source(
                    id.map(str::to_owned).unwrap_or_else(crate::types::new_id),
                    self.creation_workspace(cwd)?,
                    provider,
                    model,
                    source,
                    self.storage.clone(),
                )
                .await?
            }
        };
        session.set_thinking_level(thinking_level).await;
        Ok(session)
    }

    fn creation_workspace(&self, requested: Option<&str>) -> Result<String> {
        match requested {
            Some(path) => canonical_workspace(path),
            None => Ok(self.default_workspace.clone()),
        }
    }
}

fn canonical_workspace(cwd: &str) -> Result<String> {
    let path = crate::base::paths::expand_home_path(cwd.trim())?;
    if path.as_os_str().is_empty() {
        return Err(EvotError::Conf("workspace path must not be empty".into()));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| {
        EvotError::Conf(format!(
            "workspace '{}' is not accessible: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(EvotError::Conf(format!(
            "workspace '{}' is not a directory",
            path.display()
        )));
    }
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(canonical.to_string_lossy().into_owned())
}
