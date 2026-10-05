//! Claim → run → heartbeat → report loop for cloud scheduled tasks.
//!
//! This module owns run lifecycle only. Where a result goes is decided by
//! `super::delivery`, which resolves channels through the delivery layer.

use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::executor::ExecutorCapabilities;
use super::model::ClaimedRun;
use super::model::Task;
use crate::agent::Agent;
use crate::agent::QueryRequest;
use crate::agent::RunEventPayload;
use crate::agent::SubmitOutcome;
use crate::agent::ToolMode;
use crate::auth::AuthState;
use crate::conf::Config;
use crate::error::EvotError;
use crate::error::Result;
use crate::sessions::SessionLocator;

const POLL_INTERVAL: Duration = Duration::from_secs(15);
const RETRY_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// Run timeout bounds enforced locally. The task tool schema advertises the same
/// range, so a stored task can never quietly ask for a timeout we will not honor.
pub const MIN_TIMEOUT_SECONDS: i64 = 30;
pub const MAX_TIMEOUT_SECONDS: i64 = 3600;

pub fn effective_timeout(timeout_seconds: i64) -> Duration {
    Duration::from_secs(timeout_seconds.clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) as u64)
}

pub fn spawn(config: &Config, agent: Arc<Agent>, cancel: CancellationToken) -> JoinHandle<()> {
    let env_file = config.env_file_path.to_string_lossy().to_string();
    tokio::spawn(async move {
        let mut claim_request_id = Uuid::new_v4().to_string();
        let mut registered = String::new();
        loop {
            if cancel.is_cancelled() {
                return;
            }
            let auth = match crate::auth::load_auth() {
                Ok(Some(auth)) => auth,
                Ok(None) => {
                    wait(&cancel, RETRY_INTERVAL).await;
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "task dispatcher could not load auth");
                    wait(&cancel, RETRY_INTERVAL).await;
                    continue;
                }
            };
            // Reload per poll so console edits to channels or models take effect
            // without restarting the process.
            let config = match Config::load_with_env_file(Some(&env_file)) {
                Ok(config) => config,
                Err(error) => {
                    tracing::warn!(%error, "task dispatcher could not load config");
                    wait(&cancel, RETRY_INTERVAL).await;
                    continue;
                }
            };
            let executor_id = super::executor_id(&auth.user.id);
            let executor_name = super::executor_name(&executor_id);
            let capabilities = ExecutorCapabilities::from_channels(&config.channels);
            // Shared registration cannot describe a particular polling device.
            // Supply locally deliverable revisions on every claim instead.
            let eligible_tasks = match super::list_tasks(&auth).await {
                Ok(list) if list.cache.ready && !list.cache.stale => {
                    super::executor::eligible_tasks(&config.channels, &list.tasks)
                }
                Ok(_) => {
                    wait(&cancel, RETRY_INTERVAL).await;
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "task dispatcher could not check delivery requirements");
                    wait(&cancel, RETRY_INTERVAL).await;
                    continue;
                }
            };
            let fingerprint = capabilities.fingerprint(&auth.user.id, &executor_id, &executor_name);
            if registered != fingerprint {
                if let Err(error) =
                    super::register_executor(&auth, &executor_id, &executor_name, &capabilities)
                        .await
                {
                    tracing::warn!(%error, "task executor registration failed");
                    wait(&cancel, RETRY_INTERVAL).await;
                    continue;
                }
                registered = fingerprint;
            }
            match super::claim(&auth, &executor_id, &claim_request_id, &eligible_tasks).await {
                Ok(Some(run)) => {
                    claim_request_id = Uuid::new_v4().to_string();
                    let session_id =
                        SessionLocator::new("automation", &format!("run:{}", run.id)).session_id();
                    let result = super::lease::guard(
                        execute(&auth, agent.clone(), &config, &run, cancel.clone()),
                        || super::heartbeat(&auth, &run.id, &run.lease_token, &session_id),
                        cancel.clone(),
                        HEARTBEAT_INTERVAL,
                    )
                    .await;
                    if let Err(error) = result {
                        tracing::warn!(%error, run_id = %run.id, "task stopped without confirmed lease");
                    }
                }
                Ok(None) => {
                    claim_request_id = Uuid::new_v4().to_string();
                    wait(&cancel, POLL_INTERVAL).await;
                }
                Err(error) => {
                    tracing::warn!(%error, "task claim failed");
                    wait(&cancel, RETRY_INTERVAL).await;
                }
            }
        }
    })
}

async fn execute(
    auth: &AuthState,
    agent: Arc<Agent>,
    config: &Config,
    claimed: &ClaimedRun,
    cancel: CancellationToken,
) {
    let task = &claimed.task_snapshot;
    // Check before running the agent, so missing local channel configuration
    // cannot consume a full run only to fail at the final delivery step.
    if let Err(error) = super::delivery::validate(
        &config.channels,
        &task.delivery_channel,
        &task.delivery_target,
    ) {
        finish(
            auth,
            claimed,
            "needs_attention",
            "",
            super::delivery::NOT_REQUESTED,
            &error.to_string(),
        )
        .await;
        return;
    }
    let locator = SessionLocator::new("automation", &format!("run:{}", claimed.id));
    let session_id = locator.session_id();
    let mut request = QueryRequest::text(&task.instruction)
        .session_id(Some(session_id.clone()))
        .mode(ToolMode::Headless)
        .source("automation");
    if !task.workspace_ref.trim().is_empty() {
        request = request.cwd(task.workspace_ref.clone());
    }
    if task.model_policy == "fixed" {
        match fixed_model(&agent, config, task) {
            Ok(model) => request = request.llm(model),
            Err(error) => {
                finish(
                    auth,
                    claimed,
                    "needs_attention",
                    "",
                    super::delivery::NOT_REQUESTED,
                    &error.to_string(),
                )
                .await;
                return;
            }
        }
    }

    let outcome = match agent.submit(request).await {
        Ok(SubmitOutcome::Run(run)) => {
            // The session exists now. Name it after the task, as a user-owned
            // title, so the list shows "Daily HN digest" rather than the first
            // line of the instruction — and never "(untitled)" while it runs.
            if let Err(error) = agent.rename_session(&session_id, &task.name).await {
                tracing::warn!(%error, session_id, "cannot name task session");
            }
            run
        }
        Ok(SubmitOutcome::Command(message)) => {
            finish(
                auth,
                claimed,
                "failed",
                "",
                super::delivery::NOT_REQUESTED,
                &message,
            )
            .await;
            return;
        }
        Err(error) => {
            finish(
                auth,
                claimed,
                "failed",
                "",
                super::delivery::NOT_REQUESTED,
                &error.to_string(),
            )
            .await;
            return;
        }
    };

    // Lease renewal is owned by the outer guard through report completion.
    // Dropping collect(outcome) aborts the Run on lease loss or shutdown.
    let timeout = effective_timeout(task.timeout_seconds);
    let control = outcome.handle();
    let result = tokio::select! {
        _ = cancel.cancelled() => {
            control.abort();
            Err(EvotError::Run("task dispatcher stopped".into()))
        },
        result = tokio::time::timeout(timeout, collect(outcome)) => match result {
            Ok(result) => result,
            Err(_) => {
                control.abort();
                Err(EvotError::Run(format!("task timed out after {}s", timeout.as_secs())))
            },
        },
    };

    let text = match result {
        Ok(text) => text,
        Err(error) => {
            finish(
                auth,
                claimed,
                "failed",
                "",
                super::delivery::NOT_REQUESTED,
                &error.to_string(),
            )
            .await;
            return;
        }
    };

    // A run can last an hour. Use the current credentials/targets rather than
    // the snapshot taken when it was claimed (setup may have changed meanwhile).
    let delivery_result = if task.delivery_channel.trim().is_empty() {
        Ok(super::delivery::NOT_REQUESTED)
    } else {
        match Config::load_with_env_file(config.env_file_path.to_str()) {
            Ok(fresh) => {
                super::delivery::deliver(
                    &fresh.channels,
                    &task.delivery_channel,
                    &task.delivery_target,
                    &text,
                )
                .await
            }
            Err(error) => Err(error),
        }
    };
    match delivery_result {
        Ok(status) => finish(auth, claimed, "succeeded", &text, status, "").await,
        Err(error) => {
            finish(
                auth,
                claimed,
                "succeeded",
                &text,
                super::delivery::FAILED,
                &error.to_string(),
            )
            .await
        }
    }
}

fn fixed_model(agent: &Agent, config: &Config, task: &Task) -> Result<crate::conf::LlmConfig> {
    if task.model_spec.trim().is_empty() {
        return Err(EvotError::Conf("fixed task has no model".into()));
    }
    // The spec was saved when the task was created; the catalog may have
    // moved or regrouped the model since, so resolve it as persisted state.
    let (provider, model) = config
        .resolve_persisted_model_spec(&task.model_spec)
        .map_err(|error| {
            EvotError::Conf(format!(
                "fixed task model is unavailable: {} ({error})",
                task.model_spec
            ))
        })?;
    agent.select_configured_model(
        config,
        &provider,
        &model,
        (!task.thinking_level.trim().is_empty()).then_some(task.thinking_level.as_str()),
    )
}

async fn collect(mut run: crate::agent::Run) -> Result<String> {
    let mut text = String::new();
    while let Some(event) = run.next().await {
        match event.payload {
            RunEventPayload::RunFinished {
                text: final_text, ..
            } => text = final_text,
            RunEventPayload::Error { message } => return Err(EvotError::Run(message)),
            _ => {}
        }
    }
    if text.trim().is_empty() {
        return Err(EvotError::Run("task produced no result".into()));
    }
    Ok(text)
}

async fn finish(
    auth: &AuthState,
    claimed: &ClaimedRun,
    status: &str,
    summary: &str,
    delivery_status: &str,
    error: &str,
) {
    // Record the actual reporting host, never the account-wide executor id
    // or its mutable server-side registration name.
    let hostname = super::executor_name("Unknown host");
    let error = super::executor::error_with_executor(error, &hostname);
    for attempt in 0..3 {
        if super::report(
            auth,
            &claimed.id,
            &claimed.lease_token,
            status,
            summary,
            delivery_status,
            &error,
        )
        .await
        .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_secs(attempt + 1)).await;
    }
    tracing::error!(run_id = %claimed.id, "task result report failed");
}

async fn wait(cancel: &CancellationToken, duration: Duration) {
    tokio::select! {
        _ = cancel.cancelled() => {},
        _ = tokio::time::sleep(duration) => {},
    }
}
