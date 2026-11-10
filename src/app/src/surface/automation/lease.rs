//! A lease owns the entire operation, including delivery and reporting. Losing
//! confirmation stops local work conservatively; it never retries side effects.

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::base::error::EvotError;
use crate::base::error::Result;

pub async fn guard<T, Work, Heartbeat, Beat>(
    work: Work,
    mut heartbeat: Heartbeat,
    cancel: CancellationToken,
    interval: Duration,
) -> Result<T>
where
    Work: Future<Output = T>,
    Heartbeat: FnMut() -> Beat,
    Beat: Future<Output = Result<()>>,
{
    tokio::pin!(work);
    // Verify ownership before polling work: no agent/tool side effects first.
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(EvotError::Run("task dispatcher stopped".into())),
        result = heartbeat() => result?,
    }
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(EvotError::Run("task dispatcher stopped".into())),
            _ = tokio::time::sleep(interval) => {},
            result = &mut work => return Ok(result),
        }
        // Freeze work while renewing. Any failure (including transient network
        // uncertainty) fails closed until the server's lease contract permits
        // a safe grace period. Do not infer lease duration from run expires_at.
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(EvotError::Run("task dispatcher stopped".into())),
            result = heartbeat() => result?,
        }
    }
}
