//! Session listing, creation, deletion and workspace endpoints.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::server::workspace_label;
use super::server::DeleteSessionsRequest;
use super::server::NewChatRequest;
use super::server::Server;
use super::server::SessionListParams;
use super::server::WorkspaceRequest;
use super::server::MAX_DELETE_BATCH;
use super::server::RECENT_CACHE_TTL;
use super::server::SESSION_PAGE_SIZE;
use super::server::SESSION_SEARCH_LIMIT;
use crate::base::error::Result;
use crate::types::ListSessions;
use crate::types::SessionMeta;

impl Server {
    /// Newest-first rows for slicing, from a snapshot; zero-turn drafts stay hidden.
    async fn recent_snapshot(&self) -> Result<Vec<SessionMeta>> {
        if let Some((at, rows)) = self.recent_cache.lock().as_ref() {
            if at.elapsed() < RECENT_CACHE_TTL {
                return Ok(rows.clone());
            }
        }
        let rows = self.agent.sessions().list(0).await?;
        *self.recent_cache.lock() = Some((std::time::Instant::now(), rows.clone()));
        Ok(rows)
    }

    fn invalidate_recent_cache(&self) {
        *self.recent_cache.lock() = None;
    }

    /// Paged session list for the sidebar. `limit`/`offset` page lightweight
    /// rows (no transcript text) so opening the console costs one small
    /// request no matter how many sessions exist; scrolling asks for the next
    /// page. `full=1` returns every row with the flattened `search_text`
    /// (transcript snippets included) — only the search dialog requests that,
    /// once, when it first opens.
    pub(super) async fn sessions(&self, params: SessionListParams) -> impl IntoResponse {
        let failed = |e| {
            tracing::warn!("chat: failed to list sessions: {e}");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "failed to list sessions",
            )
                .into_response()
        };
        if params.full {
            // Search pays for transcript text; the sidebar never does.
            return match self
                .agent
                .sessions()
                .list_with_text(SESSION_SEARCH_LIMIT)
                .await
            {
                // Agent/storage filtering is transcript-aware: a run can have
                // durable entries before its final turns/title metadata save.
                Ok(rows) => Json(serde_json::json!({ "items": rows })).into_response(),
                Err(e) => failed(e),
            };
        }
        match self.recent_snapshot().await {
            Ok(all) => {
                let offset = params.offset.unwrap_or(0).min(all.len());
                let end = (offset + params.limit.unwrap_or(SESSION_PAGE_SIZE)).min(all.len());
                Json(serde_json::json!({ "items": &all[offset..end] })).into_response()
            }
            Err(e) => failed(e),
        }
    }

    /// Deletes the given sessions and reports how many were removed. Invalid or
    /// already-gone ids are skipped rather than failing the whole batch, so a
    /// concurrent deletion or a stale client list cannot wedge the request. Any
    /// active run for a session is aborted first so it cannot re-create the
    /// session directory and leave zombie state behind.
    pub(super) async fn delete_sessions(&self, req: DeleteSessionsRequest) -> impl IntoResponse {
        if req.ids.len() > MAX_DELETE_BATCH {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("too many ids: {} (max {MAX_DELETE_BATCH})", req.ids.len()),
                })),
            )
                .into_response();
        }
        let mut deleted = 0usize;
        let mut failed: Vec<String> = Vec::new();
        for id in &req.ids {
            // Stop an in-flight run before removing files, otherwise the run's
            // next transcript write would recreate the directory.
            self.agent.abort_run(id);
            match self.agent.delete_session(id).await {
                Ok(true) => deleted += 1,
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(session_id = %id, "delete failed: {e}");
                    failed.push(id.clone());
                }
            }
        }
        if deleted > 0 {
            self.invalidate_recent_cache();
        }
        Json(serde_json::json!({
            "deleted": deleted,
            "requested": req.ids.len(),
            "failed": failed,
        }))
        .into_response()
    }

    /// New chat commits a blank session up front; the composer owns its id.
    pub(super) async fn new_chat(&self, req: Option<NewChatRequest>) -> impl IntoResponse {
        let cwd = req.and_then(|r| r.cwd);
        self.sweep_stale_drafts().await;
        match self.agent.create_session_in("http", cwd).await {
            Ok(meta) => {
                self.invalidate_recent_cache();
                Json(serde_json::json!({
                    "session_id": meta.session_id,
                    "cwd": meta.cwd,
                    "title": meta.title,
                    "model": meta.model,
                    "provider": meta.provider,
                }))
                .into_response()
            }
            Err(error) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
            )
                .into_response(),
        }
    }

    /// Sweep forgotten New-chat drafts (>24h, no turns) so they don't pile up.
    async fn sweep_stale_drafts(&self) {
        let cutoff = (std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60))
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let Ok(rows) = self
            .agent
            .storage()
            .list_sessions(ListSessions {
                limit: 0,
                offset: 0,
            })
            .await
        else {
            return;
        };
        let stale: Vec<String> = rows
            .into_iter()
            .filter(|meta| {
                meta.turns == 0
                    && meta.title.is_none()
                    && !self.agent.has_active_run(&meta.session_id)
                    && chrono::DateTime::parse_from_rfc3339(&meta.updated_at)
                        .map(|t| t.timestamp() < cutoff)
                        .unwrap_or(false)
            })
            .map(|meta| meta.session_id)
            .take(20)
            .collect();
        for id in &stale {
            if let Err(e) = self.agent.delete_session(id).await {
                tracing::warn!(session_id = %id, "draft sweep delete failed: {e}");
            }
        }
        if !stale.is_empty() {
            self.invalidate_recent_cache();
            tracing::info!(count = stale.len(), "swept stale new-chat drafts");
        }
    }

    pub(super) fn workspace(&self) -> impl IntoResponse {
        Json(serde_json::json!({
            "cwd": self.agent.cwd(),
            "label": workspace_label(self.agent.cwd()),
        }))
    }

    pub(super) fn resolve_workspace(&self, req: WorkspaceRequest) -> impl IntoResponse {
        match crate::base::paths::expand_home_path(req.path.trim()) {
            Ok(path) => {
                let path = path.to_string_lossy().into_owned();
                match std::fs::metadata(&path) {
                    Ok(meta) if meta.is_dir() => {
                        let canonical = std::fs::canonicalize(&path)
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or(path);
                        Json(serde_json::json!({
                            "ok": true,
                            "cwd": canonical,
                            "label": workspace_label(&canonical),
                        }))
                        .into_response()
                    }
                    Ok(_) => (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": format!("{path} is not a directory"),
                        })),
                    )
                        .into_response(),
                    Err(error) => (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": format!("{path} is not accessible: {error}"),
                        })),
                    )
                        .into_response(),
                }
            }
            Err(error) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
            )
                .into_response(),
        }
    }

    pub(super) async fn session_detail(&self, id: &str) -> impl IntoResponse {
        match self.agent.sessions().find(id).await {
            Ok(Some(meta)) => {
                let nodes = match self.agent.sessions().resume_transcript(id).await {
                    Ok(items) => {
                        crate::session::conversation::chat_projection::replay_nodes(&items)
                    }
                    Err(error) => {
                        tracing::warn!(session_id = %id, "chat: failed to load transcript: {error}");
                        Vec::new()
                    }
                };
                // Stats items never reach the replayed node list (they are not
                // context), so the whole-session readings are folded here from
                // the raw entries instead.
                let stats = match self.agent.storage().load_active_entries(id).await {
                    Ok(entries) => {
                        crate::session::conversation::chat_projection::session_stats(&entries)
                    }
                    Err(error) => {
                        tracing::warn!(session_id = %id, "chat: failed to load stats: {error}");
                        crate::session::conversation::chat_projection::ChatStats::default()
                    }
                };
                Json(serde_json::json!({
                    "session": {
                        "session_id": meta.session_id,
                        "cwd": meta.cwd,
                        "title": meta.title,
                        "model": meta.model,
                        "provider": meta.provider,
                    },
                    "stats": stats,
                    "nodes": nodes.into_iter().map(|node| node.to_sse_json()).collect::<Vec<_>>(),
                }))
                .into_response()
            }
            Ok(None) => (StatusCode::NOT_FOUND, "session not found").into_response(),
            Err(error) => {
                tracing::warn!(session_id = %id, "chat: failed to load session: {error}");
                (StatusCode::INTERNAL_SERVER_ERROR, "failed to load session").into_response()
            }
        }
    }
}
