//! Session management on the agent.

use std::sync::Arc;

use parking_lot::RwLock;

use super::agent::Agent;
use super::fork::ForkRequest;
use super::fork::ForkedAgent;
use super::prompt::SystemPrompt;
use super::run::registry::RunRegistry;
use crate::agent::models::ModelSelection;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::session::storage::MemoryStorage;
use crate::session::Session;
use crate::session::SessionGates;
use crate::session::SessionQueries;
use crate::session::SessionService;
use crate::types::SessionMeta;

impl Agent {
    /// Fork an independent, non-persisted agent for side conversations.
    pub fn fork(self: &Arc<Self>, request: ForkRequest) -> Result<ForkedAgent> {
        let Self {
            selection,
            system_prompt: _,
            assembler,
            cwd,
            storage: _,
            active_runs: _,
            session_lifecycle_gates: _,
        } = self.as_ref();

        // Turns are built from the assembler's sections, so the fork's
        // instructions must live there or they never reach the model.
        let (system_prompt, sections) = SystemPrompt::side_session(cwd, &request.system_prompt);
        let forked = Arc::new(Self {
            selection: ModelSelection::new(selection.snapshot()),
            system_prompt: RwLock::new(system_prompt),
            assembler: Arc::new(assembler.fork(sections)),
            cwd: cwd.clone(),
            storage: Arc::new(MemoryStorage::new()),
            active_runs: Arc::new(RunRegistry::default()),
            session_lifecycle_gates: SessionGates::new(),
        });
        Ok(ForkedAgent {
            agent: forked,
            session_id: None,
        })
    }

    // -- session queries -----------------------------------------------------

    pub fn sessions(&self) -> SessionQueries {
        SessionQueries::new(self.storage())
    }

    pub async fn rename_session(
        &self,
        session_id: &str,
        title: &str,
    ) -> Result<crate::types::SessionMeta> {
        let _lifecycle = self.session_lifecycle_gate(session_id).lock().await;
        self.storage.rename_session(session_id, title).await
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<bool> {
        let _lifecycle = self.session_lifecycle_gate(session_id).lock().await;
        self.abort_run_and_wait_for_completion(session_id).await?;
        self.assembler.processes.retire(session_id).await;
        self.storage.delete_session(session_id).await
    }

    pub async fn create_session(&self, source: &str) -> Result<SessionMeta> {
        self.create_session_in(source, None).await
    }

    /// Create a blank session, optionally bound to an explicit workspace.
    pub async fn create_session_in(
        &self,
        source: &str,
        cwd: Option<String>,
    ) -> Result<SessionMeta> {
        self.create_session_with_llm(source, cwd, None).await
    }

    /// Create a blank session pinned to an explicit (provider, model).
    async fn create_session_with_llm(
        &self,
        source: &str,
        cwd: Option<String>,
        llm: Option<(String, String)>,
    ) -> Result<SessionMeta> {
        let (provider, model) = match llm {
            Some(pair) => pair,
            None => {
                let live = self.selection.snapshot();
                (live.provider.clone(), live.model.clone())
            }
        };
        self.session_service()
            .create(source, cwd.as_deref(), provider, model)
            .await
    }

    /// Fork `source_id` into a new persistent session that inherits its
    /// active context. Refused while the source is running, so the fork point
    /// never lands inside a half-written turn.
    pub async fn fork_session(&self, source_id: &str, title: Option<&str>) -> Result<SessionMeta> {
        let _lifecycle = self.session_lifecycle_gate(source_id).lock().await;
        if self.has_active_run(source_id) {
            return Err(EvotError::Session(
                "cannot fork while the session is running".into(),
            ));
        }
        self.session_service().fork(source_id, title).await
    }

    pub async fn load_session(&self, id: &str) -> Result<Option<Arc<Session>>> {
        self.session_service().load(id).await
    }

    pub(super) fn session_service(&self) -> SessionService {
        SessionService::new(self.storage.clone(), self.cwd.clone())
    }

    // -- private -------------------------------------------------------------
}
