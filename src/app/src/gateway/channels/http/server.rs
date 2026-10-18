use std::sync::Arc;

use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Sse;
use axum::routing::get;
use axum::routing::post;
use axum::Json;
use axum::Router;
use parking_lot::RwLock;
use serde::Deserialize;
use tower_http::cors::CorsLayer;

use crate::agent::Agent;
use crate::agent::QueryRequest;
use crate::agent::SubmitOutcome;
use crate::conf::Config;
use crate::conf::FeishuSettings;
use crate::conf::ModelSettings;
use crate::error::EvotError;
use crate::error::Result;
use crate::gateway::channels::http::stream;
use crate::types::ListSessions;
use crate::types::SessionMeta;

/// `0` = no limit: the full-text index wants every session.
const SESSION_SEARCH_LIMIT: usize = 0;

/// Sidebar page size for `/api/sessions`.
const SESSION_PAGE_SIZE: usize = 30;
/// Cap on ids accepted per `/api/sessions/delete` call. Bounds the work a single
/// request can trigger; the UI never selects more than the listed pool anyway.
const MAX_DELETE_BATCH: usize = 200;

#[derive(Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(default)]
    session_id: Option<String>,
    /// Optional runtime selection from the Chat composer. Both provider and
    /// model are required together; the choice is validated before a run starts.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    thinking_level: Option<String>,
    /// Workspace for a *new* session. Resume always keeps the persisted cwd.
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct AbortChatRequest {
    session_id: String,
}

/// Mid-run message for the active run, delivered at the next interruption
/// point.
#[derive(Deserialize)]
struct SteerChatRequest {
    session_id: String,
    message: String,
}

#[derive(Deserialize)]
struct NewChatRequest {
    /// Workspace to bind the new session to; defaults to the server cwd.
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct WorkspaceRequest {
    path: String,
}

#[derive(Deserialize)]
struct DeleteSessionsRequest {
    ids: Vec<String>,
}

/// Query params for the session list. The sidebar pages through lightweight
/// rows; full transcript text rides only an explicit `full=1`, which is the
/// search dialog's lazy one-shot index build.
#[derive(Deserialize)]
struct SessionListParams {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    full: bool,
}

pub struct Server {
    agent: Arc<Agent>,
    /// The live, mutable runtime config. Shared so the settings API can read a
    /// masked snapshot and apply edits in place, then persist to the env file.
    config: Arc<RwLock<Config>>,
    /// Newest-first session snapshot: page slices, never per-page rescans.
    recent_cache: parking_lot::Mutex<Option<(std::time::Instant, Vec<SessionMeta>)>>,
    /// Device login in progress (start until poll settles).
    login: parking_lot::Mutex<Option<PendingLogin>>,
}

/// A device login the dashboard started and the poll endpoint settles.
#[derive(Clone)]
struct PendingLogin {
    base_url: String,
    code: String,
    expires_at: i64,
}

/// Snapshot freshness window; new/delete also invalidate explicitly.
const RECENT_CACHE_TTL: std::time::Duration = std::time::Duration::from_millis(750);

/// Stable per-device id for the login handshake, mirroring the CLI recipe.
fn device_fingerprint() -> String {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    format!(
        "{host}:{}:{}:{user}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
    .chars()
    .take(64)
    .collect()
}

impl Server {
    pub fn new(agent: Arc<Agent>, config: Config) -> Arc<Self> {
        Arc::new(Self {
            agent,
            config: Arc::new(RwLock::new(config)),
            recent_cache: parking_lot::Mutex::new(None),
            login: parking_lot::Mutex::new(None),
        })
    }

    pub async fn start(self: Arc<Self>, host: String, port: u16) -> Result<()> {
        let addr = format!("{host}:{port}");
        tracing::info!(stage = "server", status = "listening", addr = %addr);

        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| EvotError::Run(format!("failed to bind {addr}: {e}")))?;

        axum::serve(listener, self.router())
            .await
            .map_err(|e| EvotError::Run(format!("server error: {e}")))?;

        Ok(())
    }

    pub fn router(self: Arc<Self>) -> Router {
        let dashboard = super::dashboard::dashboard_router(self.agent.clone());
        let channel_setup = super::channel_setup::router(self.config.clone());
        Router::new()
            .route(
                "/api/chat",
                post(
                    |State(server): State<Arc<Server>>, Json(req): Json<ChatRequest>| async move {
                        server.chat(req).await
                    },
                ),
            )
            .route(
                "/api/chat/abort",
                post(
                    |State(server): State<Arc<Server>>,
                     Json(req): Json<AbortChatRequest>| async move {
                        server.abort_chat(req).await
                    },
                ),
            )
            .route(
                "/api/chat/new",
                post(
                    |State(server): State<Arc<Server>>, body: Option<Json<NewChatRequest>>| async move {
                        server.new_chat(body.map(|Json(req)| req)).await
                    },
                ),
            )
            .route(
                "/api/chat/steer",
                post(
                    |State(server): State<Arc<Server>>,
                     Json(req): Json<SteerChatRequest>| async move {
                        server.steer_chat(req)
                    },
                ),
            )
            .route(
                "/api/chat/options",
                get(|State(server): State<Arc<Server>>| async move { server.chat_options() }),
            )
            .route(
                "/api/workspace",
                get(|State(server): State<Arc<Server>>| async move { server.workspace() }).post(
                    |State(server): State<Arc<Server>>,
                     Json(req): Json<WorkspaceRequest>| async move {
                        server.resolve_workspace(req)
                    },
                ),
            )
            .route(
                "/api/sessions/{id}",
                get(
                    |State(server): State<Arc<Server>>, Path(id): Path<String>| async move {
                        server.session_detail(&id).await
                    },
                ),
            )
            .route(
                "/api/sessions",
                get(
                    |State(server): State<Arc<Server>>,
                     Query(params): Query<SessionListParams>| async move {
                        server.sessions(params).await
                    },
                ),
            )
            .route(
                "/api/auth/session",
                get(|State(server): State<Arc<Server>>| async move { server.auth_session() }),
            )
            .route(
                "/api/auth/login/start",
                post(|State(server): State<Arc<Server>>| async move { server.login_start().await }),
            )
            .route(
                "/api/auth/login/poll",
                get(|State(server): State<Arc<Server>>| async move { server.login_poll().await }),
            )
            .route(
                "/api/auth/logout",
                post(|State(server): State<Arc<Server>>| async move { server.auth_logout().await }),
            )
            .route(
                "/api/notices",
                get(|State(server): State<Arc<Server>>| async move { server.notices() }),
            )
            .route(
                "/api/sessions/delete",
                post(
                    |State(server): State<Arc<Server>>,
                     Json(req): Json<DeleteSessionsRequest>| async move {
                        server.delete_sessions(req).await
                    },
                ),
            )
            .route(
                "/api/models",
                get(|State(server): State<Arc<Server>>| async move { server.get_models() }).post(
                    |State(server): State<Arc<Server>>,
                     Json(req): Json<ModelSettings>| async move {
                        server.update_models(req)
                    },
                ),
            )
            .route(
                "/api/channels/feishu",
                get(|State(server): State<Arc<Server>>| async move { server.get_feishu() }).post(
                    |State(server): State<Arc<Server>>,
                     Json(req): Json<FeishuSettings>| async move {
                        server.update_feishu(req)
                    },
                ),
            )
            .with_state(self)
            .merge(super::assets::router())
            .merge(dashboard)
            .merge(channel_setup)
            .layer(CorsLayer::permissive())
    }

    /// Provider + model state with secrets masked, for the Models page.
    ///
    /// Reloads from the env file on disk first, so the page reflects edits made
    /// outside the dashboard (e.g. a hand-edited `evot.env`) rather than a stale
    /// in-memory snapshot. This also keeps the next save's "leave blank to keep"
    /// behavior anchored to the real on-disk secrets.
    fn get_models(&self) -> impl IntoResponse {
        if let Err(e) = self.reload_config_from_disk() {
            // Fall back to the in-memory config rather than failing the page; a
            // transient read error shouldn't blank out the page.
            tracing::warn!("models: reload from disk failed, serving cached config: {e}");
        }
        Json(crate::conf::models_snapshot(&self.config.read()))
    }

    /// Feishu channel state with the secret masked, for the Feishu page.
    fn get_feishu(&self) -> impl IntoResponse {
        if let Err(e) = self.reload_config_from_disk() {
            tracing::warn!("feishu: reload from disk failed, serving cached config: {e}");
        }
        Json(crate::conf::feishu_snapshot(&self.config.read()))
    }

    /// Re-read the env file from disk and replace the shared config. Uses the
    /// path the process was started with so a custom `--env-file` is honored.
    fn reload_config_from_disk(&self) -> Result<()> {
        let mut config = self.config.write();
        let path_arg = config.env_file_path.to_str();
        let fresh = Config::load_with_env_file(path_arg)?;
        *config = fresh;
        Ok(())
    }

    /// Validate, persist, and hot-apply a provider/model update. Takes effect on
    /// the next message: the agent's `LlmConfig` is rebuilt here.
    fn update_models(&self, update: ModelSettings) -> impl IntoResponse {
        match self
            .apply_and_persist(|candidate| crate::conf::apply_model_settings(candidate, &update))
        {
            Ok(()) => (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "models": crate::conf::models_snapshot(&self.config.read()),
                })),
            )
                .into_response(),
            Err(e) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Persist settings; the gateway supervisor applies transport changes live.
    fn update_feishu(&self, update: FeishuSettings) -> impl IntoResponse {
        match self
            .apply_and_persist(|candidate| crate::conf::apply_feishu_settings(candidate, &update))
        {
            Ok(()) => (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "restart_required": false,
                    "channel": crate::conf::feishu_snapshot(&self.config.read()),
                })),
            )
                .into_response(),
            Err(e) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Apply `mutate` to a copy of the shared config, persist the result to the
    /// env file, and push the rebuilt active LLM into the running agent. Holds
    /// the write lock for the whole operation so concurrent edits from separate
    /// pages cannot interleave and lose each other's changes.
    fn apply_and_persist(&self, mutate: impl FnOnce(&mut Config) -> Result<()>) -> Result<()> {
        let mut config = self.config.write();
        let llm = crate::conf::update_config(&mut config, |candidate| {
            mutate(candidate)?;
            candidate.active_llm()
        })?;
        self.agent.set_llm(llm);
        Ok(())
    }

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
    async fn sessions(&self, params: SessionListParams) -> impl IntoResponse {
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
    async fn delete_sessions(&self, req: DeleteSessionsRequest) -> impl IntoResponse {
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

    /// Runtime model directory for the Chat composer. Unlike `/api/models`,
    /// this is about choosing a model for the next run, so it includes each
    /// model's actual supported thinking levels and the agent's live selection.
    /// Reloads from disk so a long-open Chat sees external config edits.
    fn chat_options(&self) -> impl IntoResponse {
        if let Err(e) = self.reload_config_from_disk() {
            tracing::warn!("chat options: reload from disk failed, serving cached config: {e}");
        }
        let config = self.config.read();
        let current = self.agent.llm();
        let providers: Vec<serde_json::Value> = config
            .providers
            .iter()
            .map(|(name, profile)| {
                let models: Vec<serde_json::Value> = profile
                    .models
                    .iter()
                    .filter_map(|model| {
                        match config.build_llm(name, Some(model.clone())) {
                            Ok(llm) => {
                                let thinking_levels = crate::models::ModelSelection::supported_thinking_levels_for(&llm)
                                    .into_iter()
                                    .map(|level| level.as_str())
                                    .collect::<Vec<_>>();
                                // The effective default after the catalog map
                                // and model metadata resolve: the composer
                                // preselects this when the user switches to
                                // the model.
                                let mut entry = serde_json::json!({
                                    "id": model,
                                    "thinking_levels": thinking_levels,
                                    "sort_order": config.cloud_model_sorts.get(model).copied().unwrap_or(0),
                                });
                                if !thinking_levels.is_empty() {
                                    entry["default_thinking_level"] =
                                        serde_json::json!(llm.thinking_level.as_str());
                                }
                                Some(entry)
                            }
                            Err(error) => {
                                tracing::warn!(provider = %name, model = %model, %error, "chat: model omitted from directory");
                                None
                            }
                        }
                    })
                    .collect();
                serde_json::json!({
                    "name": name,
                    "cloud": config.cloud_providers.contains(name),
                    // Tier of the group, so the composer can label cloud
                    // optgroups like the Models page does (Evot Free / Evot
                    // Premium) instead of exposing the per-protocol provider
                    // names. Every model in a group shares its tier.
                    "tier": profile
                        .models
                        .iter()
                        .find_map(|m| config.cloud_model_tiers.get(m))
                        .cloned()
                        .unwrap_or_default(),
                    "models": models,
                })
            })
            .collect();

        Json(serde_json::json!({
            "current": {
                "provider": current.provider,
                "model": current.model,
                "thinking_level": current.thinking_level.as_str(),
            },
            "providers": providers,
        }))
    }

    /// Validate and atomically apply the composer's runtime selection. The
    /// Models page owns persisted defaults; Chat only changes the running agent
    /// and the session metadata stamped by the next submit.
    fn apply_chat_selection(&self, req: &ChatRequest) -> Result<crate::conf::LlmConfig> {
        let (provider, model) = match (&req.provider, &req.model) {
            (None, None) => return Ok(self.agent.llm()),
            (Some(provider), Some(model)) => (provider, model),
            _ => {
                return Err(EvotError::Conf(
                    "chat model selection requires both provider and model".into(),
                ));
            }
        };

        let config = self.config.read();
        self.agent
            .select_configured_model(&config, provider, model, req.thinking_level.as_deref())
    }

    // -- account (login / notices) ------------------------------------------

    /// Who the sidebar shows; `logged_in: false` renders the login row.
    fn auth_session(&self) -> impl IntoResponse {
        match crate::auth::load_auth() {
            Ok(Some(state)) => Json(serde_json::json!({
                "logged_in": true,
                "name": state.user.name,
                "email": state.user.email,
            }))
            .into_response(),
            Ok(None) => Json(serde_json::json!({ "logged_in": false })).into_response(),
            Err(e) => {
                tracing::warn!("auth session read failed: {e}");
                Json(serde_json::json!({ "logged_in": false })).into_response()
            }
        }
    }

    /// Start a device login; the poll endpoint settles it in place.
    async fn login_start(&self) -> impl IntoResponse {
        let fingerprint = device_fingerprint();
        let base_url = crate::auth::client::DEFAULT_SERVER_URL;
        match crate::auth::begin_login(base_url, &fingerprint).await {
            Ok(code) => {
                *self.login.lock() = Some(PendingLogin {
                    base_url: base_url.to_string(),
                    code: code.code.clone(),
                    expires_at: code.expires_at,
                });
                Json(serde_json::json!({
                    "login_url": code.login_url,
                    "code": code.code,
                    "interval_ms": code.interval_ms,
                }))
                .into_response()
            }
            Err(e) => (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Settle the pending login: persist auth, sync the catalog, hot-reload.
    async fn login_poll(&self) -> impl IntoResponse {
        let pending = self.login.lock().clone();
        let Some(pending) = pending else {
            return Json(serde_json::json!({ "status": "idle" })).into_response();
        };
        match crate::auth::poll_status(&pending.base_url, &pending.code, pending.expires_at).await {
            Ok(crate::auth::PollOutcome::Pending) => {
                Json(serde_json::json!({ "status": "pending" })).into_response()
            }
            Ok(crate::auth::PollOutcome::Expired) => {
                *self.login.lock() = None;
                Json(serde_json::json!({ "status": "expired" })).into_response()
            }
            Ok(crate::auth::PollOutcome::Denied {
                reason,
                reason_code,
            }) => {
                *self.login.lock() = None;
                Json(serde_json::json!({
                    "status": "denied",
                    "reason": reason,
                    "reason_code": reason_code,
                }))
                .into_response()
            }
            Ok(crate::auth::PollOutcome::Success { user }) => {
                *self.login.lock() = None;
                let sync = async {
                    crate::auth::save_auth(&user)?;
                    let response = crate::auth::sync_models(&user).await?;
                    // The cache file is what config loading reads to register
                    // the cloud providers; skipping it makes login a no-op.
                    crate::auth::save_models_cache(&crate::auth::ModelsCache::new(
                        chrono::Utc::now().timestamp_millis(),
                        response,
                    ))?;
                    Ok::<(), crate::error::EvotError>(())
                };
                // Strictly ordered: the reload reads the cache file that the
                // sync just wrote, so these can never run concurrently.
                let sync = sync.await;
                let reload = self.reload_after_auth_change();
                match (sync, reload) {
                    (Ok(()), Ok(_)) => {
                        let providers = self
                            .config
                            .read()
                            .providers
                            .iter()
                            .filter(|(name, _)| self.config.read().cloud_providers.contains(*name))
                            .count();
                        Json(serde_json::json!({
                            "status": "success",
                            "name": user.user.name,
                            "email": user.user.email,
                            "providers": providers,
                        }))
                        .into_response()
                    }
                    (Ok(()), Err(e)) => Json(serde_json::json!({
                        "status": "success",
                        "name": user.user.name,
                        "email": user.user.email,
                        "reload_error": e.to_string(),
                    }))
                    .into_response(),
                    (Err(e), _) => (
                        axum::http::StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
                    )
                        .into_response(),
                }
            }
            Err(e) => (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Sign out: clear auth + catalog, drop cloud providers in place.
    async fn auth_logout(&self) -> impl IntoResponse {
        match (crate::auth::logout(), self.reload_after_auth_change()) {
            (Ok(()), Ok(_)) => Json(serde_json::json!({ "ok": true })).into_response(),
            (Err(e), _) | (_, Err(e)) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
                .into_response(),
        }
    }

    /// Server-pushed notices (banner + ads), highest priority first.
    fn notices(&self) -> impl IntoResponse {
        let items = match crate::auth::load_models_cache() {
            Ok(Some(cache)) => cache
                .response
                .notices
                .into_iter()
                .take(3)
                .map(|n| serde_json::json!({ "kind": n.kind, "title": n.title, "body": n.body_md }))
                .collect(),
            _ => Vec::new(),
        };
        Json(serde_json::json!({ "items": items })).into_response()
    }

    /// Swap in a fresh config after auth.json changed, then re-resolve the live
    /// model selection through the shared reload rule (`Agent::reload_selection`).
    fn reload_after_auth_change(&self) -> Result<()> {
        let env_path = self.config.read().env_file_path.clone();
        // A never-saved env file is not an error: fall back to the default
        // path, which creates its own baseline.
        let fresh = if env_path.exists() {
            Config::load_with_env_file(env_path.to_str())?
        } else {
            Config::load_with_env_file(None)?
        };
        *self.config.write() = fresh;
        let config = self.config.read().clone();
        self.agent.reload_selection(&config);
        Ok(())
    }

    /// New chat commits a blank session up front; the composer owns its id.
    async fn new_chat(&self, req: Option<NewChatRequest>) -> impl IntoResponse {
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

    fn workspace(&self) -> impl IntoResponse {
        Json(serde_json::json!({
            "cwd": self.agent.cwd(),
            "label": workspace_label(self.agent.cwd()),
        }))
    }

    fn resolve_workspace(&self, req: WorkspaceRequest) -> impl IntoResponse {
        match crate::conf::paths::expand_home_path(req.path.trim()) {
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

    async fn session_detail(&self, id: &str) -> impl IntoResponse {
        match self.agent.sessions().find(id).await {
            Ok(Some(meta)) => {
                let nodes = match self.agent.sessions().resume_transcript(id).await {
                    Ok(items) => crate::conversation::chat_projection::replay_nodes(&items),
                    Err(error) => {
                        tracing::warn!(session_id = %id, "chat: failed to load transcript: {error}");
                        Vec::new()
                    }
                };
                // Stats items never reach the replayed node list (they are not
                // context), so the whole-session readings are folded here from
                // the raw entries instead.
                let stats = match self.agent.storage().load_active_entries(id).await {
                    Ok(entries) => crate::conversation::chat_projection::session_stats(&entries),
                    Err(error) => {
                        tracing::warn!(session_id = %id, "chat: failed to load stats: {error}");
                        crate::conversation::chat_projection::ChatStats::default()
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

    async fn abort_chat(&self, req: AbortChatRequest) -> impl IntoResponse {
        let session_id = req.session_id.trim();
        if session_id.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "session_id must not be empty",
                })),
            );
        }
        match self
            .agent
            .abort_run_and_wait_for_completion(session_id)
            .await
        {
            Ok(active) => (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "active": active })),
            ),
            Err(error) => (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": error.to_string(),
                })),
            ),
        }
    }

    /// Queue a message onto the run that is already streaming for this
    /// session. Returns `active: false` when no run is in flight, so the
    /// browser can fall back to sending a normal turn.
    fn steer_chat(&self, req: SteerChatRequest) -> impl IntoResponse {
        let session_id = req.session_id.trim();
        let message = req.message.trim();
        if session_id.is_empty() || message.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "session_id and message must not be empty",
                })),
            );
        }
        if crate::command::is_queued_command(message) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "Commands don't queue while a response is running. Stop it or wait for the turn to finish.",
                })),
            );
        }
        let active = self
            .agent
            .try_steer(session_id, vec![evot_engine::Content::Text {
                text: message.to_string(),
            }]);
        (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "active": active })),
        )
    }

    async fn chat(self: Arc<Self>, req: ChatRequest) -> impl IntoResponse {
        let stream = self.chat_stream(req);
        Sse::new(stream).keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
    }

    fn chat_stream(
        self: Arc<Self>,
        req: ChatRequest,
    ) -> impl futures::stream::Stream<
        Item = std::result::Result<axum::response::sse::Event, std::convert::Infallible>,
    > {
        let (tx, rx) = tokio::sync::mpsc::channel(64);

        tokio::spawn(async move {
            let llm = match self.apply_chat_selection(&req) {
                Ok(llm) => llm,
                Err(error) => {
                    let _ = tx.send(stream::error_event(error.to_string())).await;
                    let _ = tx.send(stream::done_event()).await;
                    return;
                }
            };

            let mut request = QueryRequest::text(&req.message)
                .session_id(req.session_id.clone())
                .llm(llm)
                .source("http");
            if req.session_id.is_none() {
                if let Some(cwd) = req.cwd.clone() {
                    request = request.cwd(cwd);
                }
            }

            let drain_run = |mut query_run: crate::agent::Run, tx: tokio::sync::mpsc::Sender<_>| async move {
                loop {
                    tokio::select! {
                        // A dropped browser response is also a stop request. Do
                        // not leave the model or tools running without a client.
                        _ = tx.closed() => {
                            query_run.abort();
                            return;
                        }
                        event = query_run.next() => {
                            let Some(event) = event else { return };
                            for sse in stream::map_run_event(&event) {
                                if tx.send(sse).await.is_err() {
                                    query_run.abort();
                                    return;
                                }
                            }
                        }
                    }
                }
            };

            match self.agent.submit(request).await {
                Ok(SubmitOutcome::Run(query_run)) => {
                    let session_event =
                        match self.agent.sessions().find(&query_run.session_id).await {
                            Ok(Some(meta)) => stream::session_meta_event(&meta),
                            _ => stream::session_event(&query_run.session_id),
                        };
                    if tx.send(session_event).await.is_err() {
                        query_run.abort();
                        return;
                    }
                    drain_run(query_run, tx.clone()).await;
                }
                Ok(SubmitOutcome::Command(text)) => {
                    let _ = tx.send(stream::text_event(&text)).await;
                }
                Err(e) => {
                    let _ = tx.send(stream::error_event(e.to_string())).await;
                }
            }

            let _ = tx.send(stream::done_event()).await;
        });

        tokio_stream::wrappers::ReceiverStream::new(rx)
    }
}

fn workspace_label(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(cwd)
        .to_string()
}
