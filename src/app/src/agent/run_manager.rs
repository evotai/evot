//! Channel conversation routing — serializes per-conversation to prevent
//! duplicate runs. Session identity is derived from `SessionLocator`.
//!
//! Direct session APIs (HTTP, NAPI) bypass this and call Agent directly.

use std::sync::Arc;

use super::run::run::Run;
use super::Agent;
use super::QueryRequest;
use crate::agent::SubmitOutcome;
use crate::base::error::Result;
use crate::session::Session;
use crate::session::SessionGates;
use crate::session::SessionLocator;

pub enum SendOutcome {
    Started(Run),
    Steered,
    /// A gateway command was handled; carry this text back to the user.
    Command(String),
}

pub struct RunManager {
    agent: Arc<Agent>,
    /// Bounded conversation gates, separate from Agent's lifecycle gates so
    /// calling submit while holding this gate cannot re-enter the same lock.
    gates: SessionGates,
}

impl RunManager {
    pub fn new(agent: Arc<Agent>) -> Arc<Self> {
        Arc::new(Self {
            agent,
            gates: SessionGates::new(),
        })
    }

    pub fn agent(&self) -> &Arc<Agent> {
        &self.agent
    }

    pub async fn send(
        &self,
        locator: &SessionLocator,
        request: QueryRequest,
    ) -> Result<SendOutcome> {
        let key = locator.stable_key();

        let _guard = self.gates.gate(&key).lock().await;

        // Resolve session via locator (open existing or create new)
        let llm = self.agent.llm();
        let session = Session::open_or_create_with_provider(
            locator,
            self.agent.cwd(),
            &llm.provider,
            &llm.model,
            self.agent.storage(),
        )
        .await?;

        let session_id = session.session_id().await;

        // Busy commands are not prompts on any entry point. Keep channel
        // commands out of the model queue just as TUI and HTTP do.
        if self.agent.has_active_run(&session_id)
            && crate::agent::command::is_queued_command(&request.input_text())
        {
            return Ok(SendOutcome::Command(
                "Commands don't queue while a response is running. Stop it or wait for the turn to finish.".into(),
            ));
        }

        // Steer into active run if one exists
        if self.agent.try_steer(&session_id, request.input.clone()) {
            return Ok(SendOutcome::Steered);
        }

        // Start new run (commands are intercepted inside Agent)
        match self.agent.submit_to_session(request, session).await? {
            SubmitOutcome::Run(run) => Ok(SendOutcome::Started(run)),
            SubmitOutcome::Command(msg) => Ok(SendOutcome::Command(msg)),
        }
    }
}
