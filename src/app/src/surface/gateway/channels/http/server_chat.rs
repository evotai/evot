//! Chat endpoints: options, submit, steer, abort.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Sse;
use axum::Json;

use super::server::AbortChatRequest;
use super::server::ChatRequest;
use super::server::Server;
use super::server::SteerChatRequest;
use crate::agent::QueryRequest;
use crate::agent::SubmitOutcome;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::surface::gateway::channels::http::stream;

impl Server {
    /// Runtime model directory for the Chat composer. Unlike `/api/models`,
    /// this is about choosing a model for the next run, so it includes each
    /// model's actual supported thinking levels and the agent's live selection.
    /// Reloads from disk so a long-open Chat sees external config edits.
    pub(super) fn chat_options(&self) -> impl IntoResponse {
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
                                let thinking_levels = crate::agent::models::ModelSelection::supported_thinking_levels_for(&llm)
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

    pub(super) async fn abort_chat(&self, req: AbortChatRequest) -> impl IntoResponse {
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
    pub(super) fn steer_chat(&self, req: SteerChatRequest) -> impl IntoResponse {
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
        if crate::agent::command::is_queued_command(message) {
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

    pub(super) async fn chat(self: Arc<Self>, req: ChatRequest) -> impl IntoResponse {
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
