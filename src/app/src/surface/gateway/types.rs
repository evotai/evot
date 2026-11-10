use std::sync::Arc;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::base::error::Result;

#[async_trait]
pub trait Channel: Send + Sync {
    fn name(&self) -> &'static str;
    async fn run(self: Arc<Self>, agent: Arc<Agent>, cancel: CancellationToken) -> Result<()>;
}
