//! The session judge: TypeSafe Jev published by the cloud catalog as a
//! `role=judge` model, reached through the same gateway as chat models.
//!
//! One construction site, so every consumer (context pruning today, tool-call
//! review or routing later) gets the same endpoint and the same transport.

mod trace;

use std::path::Path;
use std::sync::Arc;

use evot_engine::judge::Judge;
use evot_engine::judge::JudgeLimits;
use evot_engine::judge::ProviderJudge;
pub use trace::TracingJudge;
pub use trace::JUDGE_TRACE_FILE;
pub use trace::JUDGE_TRACE_VERSION;

use crate::conf::resolve_model_config;
use crate::conf::JudgeEndpoint;

/// The judge as the server publishes it right now. Resolved per run from the
/// synced models cache, so switching the judge model off on the server stops
/// pruning at the next run without a restart.
pub fn current() -> Option<Arc<dyn Judge>> {
    from_endpoint(crate::conf::load::current_judge_endpoint().as_ref())
}

/// The current judge, recording every request to the session's
/// `judge-trace.jsonl` when the session has a directory on disk.
pub fn current_for_session(
    session_dir: Option<&Path>,
    session_id: Option<&str>,
) -> Option<Arc<dyn Judge>> {
    let judge = from_endpoint_with_session(
        crate::conf::load::current_judge_endpoint().as_ref(),
        session_id,
    )?;
    Some(match session_dir {
        Some(dir) => Arc::new(TracingJudge::new(judge, dir.to_path_buf())),
        None => judge,
    })
}

/// Build the judge for a published endpoint. `None` when no judge is
/// published, which keeps every judge-driven feature switched off. The
/// server's context window sizes requests when it publishes one; otherwise
/// the engine's default for the judge model applies.
pub fn from_endpoint(endpoint: Option<&JudgeEndpoint>) -> Option<Arc<dyn Judge>> {
    from_endpoint_with_session(endpoint, None)
}

fn from_endpoint_with_session(
    endpoint: Option<&JudgeEndpoint>,
    session_id: Option<&str>,
) -> Option<Arc<dyn Judge>> {
    let endpoint = endpoint?;
    let provider = crate::models::transport::for_protocol(&endpoint.protocol);
    let model_config = resolve_model_config(
        endpoint.protocol.clone(),
        &endpoint.provider,
        &endpoint.model,
        Some(&endpoint.base_url),
        Default::default(),
        Default::default(),
        None,
        None,
        Some(false),
    );
    let mut judge = ProviderJudge::new(
        provider,
        endpoint.model.clone(),
        endpoint.api_key.clone(),
        Some(model_config),
    );
    if let Some(session_id) = session_id.filter(|id| !id.is_empty()) {
        judge = judge.with_session_id(session_id);
    }
    if let Some(window) = endpoint.context_window {
        judge = judge.with_limits(JudgeLimits::for_window(window as usize));
    }
    Some(Arc::new(judge))
}
