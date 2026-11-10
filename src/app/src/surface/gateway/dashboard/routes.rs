use std::sync::Arc;

use axum::extract::Path;
use axum::extract::State;
use axum::response::Html;
use axum::response::IntoResponse;
use axum::response::Redirect;
use axum::routing::get;
use axum::Json;
use axum::Router;

use super::trace;
use crate::agent::Agent;
use crate::types::ListTranscriptEntries;

#[derive(Clone)]
pub struct DashboardState {
    pub agent: Arc<Agent>,
}

pub fn dashboard_router(agent: Arc<Agent>) -> Router {
    let state = DashboardState { agent };
    Router::new()
        // Per-session trace API (per-LLM-call spans with tool calls).
        .route("/api/session/{id}/events", get(api_events))
        .route("/api/session/{id}/events/{seq}", get(api_event_detail))
        .route("/api/session/{id}/activity", get(api_activity))
        // Chat owns session browsing; the standalone list is gone. Old
        // bookmarks land in Chat, which resumes any session by id.
        .route("/sessions", get(|| async { Redirect::to("/chat") }))
        .route("/sessions/{id}", get(trace_page))
        .route("/sessions/{id}/trace", get(trace_page))
        .with_state(state)
}

// --- API: session trace (per-LLM-call spans) ---

const TRACE_HTML: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/console/trace/index.html"
));

async fn load_entries(state: &DashboardState, id: &str) -> Vec<crate::types::TranscriptEntry> {
    state
        .agent
        .storage()
        .list_entries(ListTranscriptEntries {
            session_id: id.to_string(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await
        .unwrap_or_default()
}

async fn api_events(
    State(state): State<DashboardState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let entries = load_entries(&state, &id).await;
    Json(trace::project_spans(&entries))
}

async fn api_event_detail(
    State(state): State<DashboardState>,
    Path((id, seq)): Path<(String, u64)>,
) -> impl IntoResponse {
    let entries = load_entries(&state, &id).await;
    match trace::project_span_detail(&entries, seq) {
        Some(detail) => Json(detail).into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, "span not found").into_response(),
    }
}

async fn api_activity(
    State(state): State<DashboardState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let meta = state.agent.storage().get_session(&id).await.ok().flatten();
    let entries = load_entries(&state, &id).await;
    Json(trace::project_activity(&entries, meta.as_ref())).into_response()
}

async fn trace_page() -> Html<&'static str> {
    Html(TRACE_HTML)
}
