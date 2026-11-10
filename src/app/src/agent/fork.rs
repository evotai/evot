use std::sync::Arc;

use super::agent::Agent;
use super::request::QueryRequest;
use super::request::SubmitOutcome;
use super::tools::ToolMode;
use super::Run;
use crate::base::error::EvotError;
use crate::base::error::Result;

pub struct ForkRequest {
    pub system_prompt: String,
}

pub struct ForkedAgent {
    pub(super) agent: Arc<Agent>,
    pub(super) session_id: Option<String>,
}

impl ForkedAgent {
    pub async fn query(&mut self, prompt: &str) -> Result<Run> {
        let request = QueryRequest::text(prompt)
            .session_id(self.session_id.clone())
            .mode(ToolMode::Readonly);
        let outcome = self.agent.submit(request).await?;
        match outcome {
            SubmitOutcome::Run(run) => {
                if self.session_id.is_none() {
                    self.session_id = Some(run.session_id.clone());
                }
                Ok(run)
            }
            SubmitOutcome::Command(_) => Err(EvotError::Run(
                "commands not supported in forked agent".into(),
            )),
        }
    }
}
