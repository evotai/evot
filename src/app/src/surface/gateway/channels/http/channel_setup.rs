//! Setup observations come from the process that owns the live transport.
//! Both the embedded CLI and other local CLIs use this HTTP boundary.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::Json;
use axum::Router;
use parking_lot::RwLock;
use serde::Deserialize;

use crate::conf::Config;
use crate::surface::gateway::channels::feishu::setup;

#[derive(Deserialize)]
struct BindChat {
    revision: String,
    chat_id: String,
}

pub(super) fn router(config: Arc<RwLock<Config>>) -> Router {
    Router::new()
        .route("/api/channels/feishu/setup", get(observe).post(bind))
        .with_state(config)
}

fn failure(error: impl std::fmt::Display) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": error.to_string()})),
    )
        .into_response()
}

async fn observe(State(config): State<Arc<RwLock<Config>>>) -> Response {
    let path = config.read().env_file_path.clone();
    match Config::load_with_env_file(path.to_str()).and_then(|config| setup::observe(&config)) {
        Ok(state) => Json(state).into_response(),
        Err(error) => failure(error),
    }
}

async fn bind(
    State(config): State<Arc<RwLock<Config>>>,
    Json(request): Json<BindChat>,
) -> Response {
    // Re-read before beginning the transaction, and check the UI's revision in
    // setup::bind. No cached credentials or target from another process are used.
    let path = config.read().env_file_path.clone();
    let result = Config::load_with_env_file(path.to_str())
        .and_then(|mut config| setup::bind(&mut config, &request.revision, &request.chat_id));
    match result {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(error) => failure(error),
    }
}
