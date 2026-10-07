//! One blocking-pool hop per batch of local filesystem work.
//!
//! Pattern: write the work as a synchronous function taking
//! `&CancellationToken`, and enter it only through [`blocking_io`]. Scans that
//! touch many files should poll the token between operations; short workers
//! can ignore it.

use tokio_util::sync::CancellationToken;

use crate::error::EvotError;
use crate::error::Result;

/// Run `work` on the blocking pool and surface its result.
///
/// Dropping the returned future cancels the token. The worker only observes
/// that at its next poll; an in-flight syscall still completes first.
pub async fn blocking_io<T, F>(label: &'static str, work: F) -> Result<T>
where
    F: FnOnce(&CancellationToken) -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    tokio::task::spawn_blocking(move || work(&cancel))
        .await
        .map_err(|error| EvotError::Store(format!("{label} task failed: {error}")))?
}

/// Error for a worker that noticed cancellation and stopped early.
pub fn cancelled(label: &str) -> EvotError {
    EvotError::Store(format!("{label} cancelled"))
}
