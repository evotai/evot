use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::Json;
use axum::Router;
use parking_lot::RwLock;
use tower_http::cors::CorsLayer;

use crate::agent::Agent;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::FeishuSettings;
use crate::conf::ModelSettings;

pub struct Server {
    pub(super) agent: Arc<Agent>,
    /// The live, mutable runtime config. Shared so the settings API can read a
    /// masked snapshot and apply edits in place, then persist to the env file.
    pub(super) config: Arc<RwLock<Config>>,
}

impl Server {
    pub fn new(agent: Arc<Agent>, config: Config) -> Arc<Self> {
        Arc::new(Self {
            agent,
            config: Arc::new(RwLock::new(config)),
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
