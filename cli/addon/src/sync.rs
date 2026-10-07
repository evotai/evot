//! Cloud session sync bridge. Every method returns JSON the CLI decodes with
//! `parseCloudResult`; outcomes that are decisions for the user (diverged,
//! local ahead) come back as data, not as thrown errors.

use napi::threadsafe_function::ErrorStrategy;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::Error;
use napi::Result;
use napi_derive::napi;
use serde_json::json;

use crate::agent::NapiAgent;

/// `(progressJson: string) => void`, called after each uploaded batch. Wire
/// shape: `{ "uploaded_entries", "total_entries", "batch", "batches" }`.
/// napi builds the threadsafe wrapper at the call boundary, so the handle is
/// `Send` and can ride along into the async push.
type ProgressCallback = ThreadsafeFunction<String, ErrorStrategy::Fatal>;

fn report(
    callback: &Option<ProgressCallback>,
) -> impl Fn(evot::api::sync::PushProgress) + Sync + '_ {
    move |progress| {
        let Some(callback) = callback else { return };
        let payload = json!({
            "uploaded_entries": progress.uploaded_entries,
            "total_entries": progress.total_entries,
            "batch": progress.batch,
            "batches": progress.batches,
        });
        // A dropped progress tick is harmless; the next one carries the total.
        callback.call(payload.to_string(), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

fn auth() -> Result<evot::api::auth::AuthState> {
    evot::api::auth::load_auth()
        .map_err(failure)?
        .ok_or_else(|| Error::from_reason("sharing requires sign-in; run /login"))
}

/// `"keep"` leaves an already-shared session's access as it is.
fn parse_access(value: &str) -> Result<Option<evot::api::CloudAccess>> {
    match value {
        "keep" => Ok(None),
        "private" => Ok(Some(evot::api::CloudAccess::Private)),
        "team" => Ok(Some(evot::api::CloudAccess::Team)),
        "public" => Ok(Some(evot::api::CloudAccess::Public)),
        other => Err(Error::from_reason(format!("unknown visibility: {other}"))),
    }
}

fn push_json(outcome: evot::api::sync::PushOutcome) -> Result<String> {
    let value = match outcome {
        evot::api::sync::PushOutcome::Synced { cloud, pushed } => {
            json!({ "kind": "synced", "cloud": cloud, "pushed": pushed })
        }
        evot::api::sync::PushOutcome::Diverged {
            local_seq,
            remote_seq,
        } => json!({ "kind": "diverged", "local_seq": local_seq, "remote_seq": remote_seq }),
        evot::api::sync::PushOutcome::NotShared => json!({ "kind": "not_shared" }),
    };
    serde_json::to_string(&value).map_err(failure)
}

#[napi]
impl NapiAgent {
    /// Turn cloud sync on for a session (or change its visibility) and push.
    ///
    /// `on_progress`, when given, is called with a JSON string after each
    /// uploaded batch so the UI can draw a bar for a long first share.
    #[napi(
        ts_args_type = "sessionId: string, visibility: string, onProgress?: (progress: string) => void"
    )]
    pub async fn cloud_share_session(
        &self,
        session_id: String,
        visibility: String,
        on_progress: Option<ProgressCallback>,
    ) -> Result<String> {
        let callback = on_progress;
        let outcome = evot::api::sync::share_session(
            &auth()?,
            &self.agent.storage(),
            &session_id,
            parse_access(&visibility)?,
            env!("CARGO_PKG_VERSION"),
            &report(&callback),
        )
        .await
        .map_err(failure)?;
        push_json(outcome)
    }

    /// Incremental push; `force` replaces the server copy with local.
    #[napi(
        ts_args_type = "sessionId: string, force: boolean, onProgress?: (progress: string) => void"
    )]
    pub async fn cloud_push_session(
        &self,
        session_id: String,
        force: bool,
        on_progress: Option<ProgressCallback>,
    ) -> Result<String> {
        let callback = on_progress;
        let outcome = evot::api::sync::push_session(
            &auth()?,
            &self.agent.storage(),
            &session_id,
            env!("CARGO_PKG_VERSION"),
            force,
            &report(&callback),
        )
        .await
        .map_err(failure)?;
        push_json(outcome)
    }

    /// Stop syncing: delete the server copy, keep the local transcript.
    #[napi]
    pub async fn cloud_unshare_session(&self, session_id: String) -> Result<()> {
        evot::api::sync::unshare_session(&auth()?, &self.agent.storage(), &session_id)
            .await
            .map_err(failure)
    }

    /// Owner's remote index: metadata only, cheap enough to refresh often.
    /// Returns an empty list when signed out so callers need no auth check.
    #[napi]
    pub async fn cloud_list_sessions(&self) -> Result<String> {
        let Some(state) = evot::api::auth::load_auth().map_err(failure)? else {
            return Ok("[]".into());
        };
        let index = evot::api::sync::remote_index(&state)
            .await
            .map_err(failure)?;
        serde_json::to_string(&index.sessions).map_err(failure)
    }

    /// Bring the local copy up to the server's.
    #[napi]
    pub async fn cloud_pull_session(&self, session_id: String) -> Result<String> {
        let outcome = evot::api::sync::pull_session(&auth()?, &self.agent.storage(), &session_id)
            .await
            .map_err(failure)?;
        let value = match outcome {
            evot::api::sync::PullOutcome::Pulled { meta, appended } => {
                json!({ "kind": "pulled", "meta": meta, "appended": appended })
            }
            evot::api::sync::PullOutcome::UpToDate => json!({ "kind": "up_to_date" }),
            evot::api::sync::PullOutcome::LocalAhead {
                local_seq,
                remote_seq,
            } => json!({ "kind": "local_ahead", "local_seq": local_seq, "remote_seq": remote_seq }),
            evot::api::sync::PullOutcome::Diverged {
                local_seq,
                remote_seq,
            } => json!({ "kind": "diverged", "local_seq": local_seq, "remote_seq": remote_seq }),
        };
        serde_json::to_string(&value).map_err(failure)
    }

    /// Materialise the server copy as a new local-only session; returns its meta.
    #[napi]
    pub async fn cloud_fork_remote_session(&self, session_id: String) -> Result<String> {
        let meta =
            evot::api::sync::fork_remote_session(&auth()?, &self.agent.storage(), &session_id)
                .await
                .map_err(failure)?;
        serde_json::to_string(&meta).map_err(failure)
    }

    /// `/share <url>`: fork a public page's transcript into a new local session.
    #[napi]
    pub async fn import_shared_session(&self, link: String) -> Result<String> {
        let meta = evot::api::import_shared_session(&auth()?, &self.agent.storage(), &link)
            .await
            .map_err(failure)?;
        serde_json::to_string(&meta).map_err(failure)
    }
}
