use std::sync::Arc;

use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::routing::get;
use axum::routing::post;
use axum::Json;
use axum::Router;
use parking_lot::RwLock;
use serde::Deserialize;
use tower_http::cors::CorsLayer;

use crate::agent::Agent;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::FeishuSettings;
use crate::conf::ModelSettings;
use crate::types::SessionMeta;

/// `0` = no limit: the full-text index wants every session.
pub(super) const SESSION_SEARCH_LIMIT: usize = 0;

/// Sidebar page size for `/api/sessions`.
pub(super) const SESSION_PAGE_SIZE: usize = 30;
/// Cap on ids accepted per `/api/sessions/delete` call. Bounds the work a single
/// request can trigger; the UI never selects more than the listed pool anyway.
pub(super) const MAX_DELETE_BATCH: usize = 200;

#[derive(Deserialize)]
pub(super) struct ChatRequest {
    pub(super) message: String,
    #[serde(default)]
    pub(super) session_id: Option<String>,
    /// Optional runtime selection from the Chat composer. Both provider and
    /// model are required together; the choice is validated before a run starts.
    #[serde(default)]
    pub(super) provider: Option<String>,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) thinking_level: Option<String>,
    /// Workspace for a *new* session. Resume always keeps the persisted cwd.
    #[serde(default)]
    pub(super) cwd: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct AbortChatRequest {
    pub(super) session_id: String,
}

/// Mid-run message for the active run, delivered at the next interruption
/// point.
#[derive(Deserialize)]
pub(super) struct SteerChatRequest {
    pub(super) session_id: String,
    pub(super) message: String,
}

#[derive(Deserialize)]
pub(super) struct NewChatRequest {
    /// Workspace to bind the new session to; defaults to the server cwd.
    #[serde(default)]
    pub(super) cwd: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct WorkspaceRequest {
    pub(super) path: String,
}

#[derive(Deserialize)]
pub(super) struct DeleteSessionsRequest {
    pub(super) ids: Vec<String>,
}

/// Query params for the session list. The sidebar pages through lightweight
/// rows; full transcript text rides only an explicit `full=1`, which is the
/// search dialog's lazy one-shot index build.
#[derive(Deserialize)]
pub(super) struct SessionListParams {
    #[serde(default)]
    pub(super) limit: Option<usize>,
    #[serde(default)]
    pub(super) offset: Option<usize>,
    #[serde(default)]
    pub(super) full: bool,
}

pub struct Server {
    pub(super) agent: Arc<Agent>,
    /// The live, mutable runtime config. Shared so the settings API can read a
    /// masked snapshot and apply edits in place, then persist to the env file.
    pub(super) config: Arc<RwLock<Config>>,
    /// Newest-first session snapshot: page slices, never per-page rescans.
    pub(super) recent_cache: parking_lot::Mutex<Option<(std::time::Instant, Vec<SessionMeta>)>>,
    /// Device login in progress (start until poll settles).
    pub(super) login: parking_lot::Mutex<Option<PendingLogin>>,
}

/// A device login the dashboard started and the poll endpoint settles.
#[derive(Clone)]
pub(super) struct PendingLogin {
    pub(super) base_url: String,
    pub(super) code: String,
    pub(super) expires_at: i64,
}

/// Snapshot freshness window; new/delete also invalidate explicitly.
pub(super) const RECENT_CACHE_TTL: std::time::Duration = std::time::Duration::from_millis(750);

/// Stable per-device id for the login handshake, mirroring the CLI recipe.
pub(super) fn device_fingerprint() -> String {
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
        let dashboard = crate::surface::gateway::dashboard::dashboard_router(self.agent.clone());
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
}

pub(super) fn workspace_label(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(cwd)
        .to_string()
}
