//! `/share <url>`: fork a public or team session into a local one.
//!
//! The share's `session.json` has the sync `pull` shape. Team links require
//! the reader's CLI token and current team membership. Both kinds are fetched
//! from this client's own server (never the pasted host) and installed like a
//! cloud fork: fresh id, no cloud link, and no writes to the owner's copy.

use std::sync::Arc;
use std::time::Duration;

use super::parse_session_share_link;
use super::SessionShareLink;
use crate::auth::AuthState;
use crate::error::EvotError;
use crate::error::Result;
use crate::storage::Storage;
use crate::sync::install_fork;
use crate::sync::SyncPull;
use crate::types::SessionMeta;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn import_shared_session(
    auth: &AuthState,
    storage: &Arc<dyn Storage>,
    link: &str,
) -> Result<SessionMeta> {
    let share = parse_session_share_link(link)
        .ok_or_else(|| EvotError::Conf("not a shared session link".into()))?;
    let remote = fetch(auth, &share).await?;
    install_fork(storage, remote, "shared copy").await
}

async fn fetch(auth: &AuthState, share: &SessionShareLink) -> Result<SyncPull> {
    let (path, needs_auth) = match share {
        SessionShareLink::Public(token) => (format!("/share/{token}/session.json"), false),
        SessionShareLink::Team(token) => (format!("/team/{token}/session.json"), true),
    };
    let url = format!("{}{}", auth.server_base_url.trim_end_matches('/'), path);
    let mut request = crate::http::no_redirect_client()?
        .get(url)
        .timeout(REQUEST_TIMEOUT);
    if needs_auth {
        request = request.bearer_auth(&auth.cli_token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| EvotError::Conf(format!("{path}: {error}")))?;
    match response.status().as_u16() {
        401 => Err(EvotError::Conf(
            "sign in with /login to import a team share".into(),
        )),
        404 if needs_auth => Err(EvotError::Conf(
            "team share not found or this account is not a current member of the owner's team"
                .into(),
        )),
        404 => Err(EvotError::Conf(
            "shared session not found; the link may be private, revoked, or a snapshot that \
             cannot be continued — ask the owner to /share the synced session"
                .into(),
        )),
        status if status >= 400 => Err(EvotError::Conf(format!("{path}: HTTP {status}"))),
        _ => response
            .json::<SyncPull>()
            .await
            .map_err(|error| EvotError::Conf(format!("{path}: {error}"))),
    }
}
