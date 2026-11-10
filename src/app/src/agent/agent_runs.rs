//! Run lifecycle on the agent: submit, steer, abort, compact.

use std::sync::Arc;
use std::time::Duration;

use super::agent::Agent;
use super::dump::build_prompt_dump;
use super::dump::resolve_dump_path;
use super::request::expand_prompt_command;
use super::request::PromptCommandContext;
use super::request::QueryRequest;
use super::request::SubmitOutcome;
use super::run::run::Run;
use super::run::runtime;
use super::run::runtime::TurnFactory;
use super::tools::ToolMode;
use super::turn_assembler::TurnBuildRequest;
use super::turn_factory::AgentTurnFactory;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Protocol;
use crate::session::Session;
use crate::session::SessionSelection;

enum AbortRunOutcome {
    Stopped,
    Cancelled,
    TimedOut,
}

const RUN_ABORT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

impl Agent {
    pub(super) fn session_lifecycle_gate(&self, session_id: &str) -> &tokio::sync::Mutex<()> {
        self.session_lifecycle_gates.gate(session_id)
    }

    // -- run control ---------------------------------------------------------

    /// Send a steering message to the active run for a session.
    pub fn steer(&self, session_id: &str, input: Vec<evot_engine::Content>) {
        self.try_steer(session_id, input);
    }

    pub fn try_steer(&self, session_id: &str, input: Vec<evot_engine::Content>) -> bool {
        let (input, provenance) =
            crate::session::conversation::input::PreparedInput::user(input).finish();
        self.active_runs.try_steer(
            session_id,
            evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                provenance,
                content: input,
                timestamp: evot_engine::now_ms(),
            }),
        )
    }

    /// Send a follow-up message to the active run for a session.
    pub fn follow_up(&self, session_id: &str, text: impl Into<String>) {
        let (content, provenance) = crate::session::conversation::input::PreparedInput::user(vec![
            evot_engine::Content::Text { text: text.into() },
        ])
        .finish();
        self.active_runs.follow_up(
            session_id,
            evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                content,
                provenance,
                timestamp: evot_engine::now_ms(),
            }),
        );
    }

    /// Abort the active run for a session.
    pub fn abort_run(&self, session_id: &str) {
        self.active_runs.abort(session_id);
    }

    /// Check if a session has an active (non-finished) run.
    /// Automatically cleans up finished runs.
    pub fn has_active_run(&self, session_id: &str) -> bool {
        self.active_runs.contains(session_id)
    }

    /// Abort the current run for a session and wait until its cleanup callback
    /// has completed. Returns whether a run was active when the request began.
    pub async fn abort_run_and_wait_for_completion(&self, session_id: &str) -> Result<bool> {
        let active = self.has_active_run(session_id);
        if !active {
            return Ok(false);
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        match self.abort_run_and_wait(session_id, &cancel).await {
            AbortRunOutcome::Stopped => Ok(true),
            AbortRunOutcome::Cancelled => Err(EvotError::Run(
                "run abort was unexpectedly cancelled".to_string(),
            )),
            AbortRunOutcome::TimedOut => Err(EvotError::Run(format!(
                "active run did not stop within {} seconds",
                RUN_ABORT_WAIT_TIMEOUT.as_secs()
            ))),
        }
    }

    async fn abort_run_and_wait(
        &self,
        session_id: &str,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> AbortRunOutcome {
        let active = self.active_runs.abort(session_id);
        let Some(completed) = active else {
            return AbortRunOutcome::Stopped;
        };
        if completed.is_cancelled() {
            return AbortRunOutcome::Stopped;
        }

        tokio::select! {
            _ = cancel.cancelled() => AbortRunOutcome::Cancelled,
            _ = completed.cancelled() => AbortRunOutcome::Stopped,
            _ = tokio::time::sleep(RUN_ABORT_WAIT_TIMEOUT) => {
                tracing::warn!(
                    stage = "compact",
                    status = "run_abort_timeout",
                    session_id = %session_id,
                    timeout_ms = RUN_ABORT_WAIT_TIMEOUT.as_millis() as u64,
                );
                AbortRunOutcome::TimedOut
            }
        }
    }

    /// Manually compact an existing session with an abortable lifecycle.
    pub async fn compact(
        &self,
        session_id: &str,
        custom_instructions: Option<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<crate::session::compact::orchestrator::ManualCompactionOutcome> {
        self.compact_with_observer(session_id, custom_instructions, cancel, None)
            .await
    }

    pub async fn compact_with_observer(
        &self,
        session_id: &str,
        custom_instructions: Option<String>,
        cancel: tokio_util::sync::CancellationToken,
        observer: Option<crate::session::compact::orchestrator::ManualCompactionObserver>,
    ) -> Result<crate::session::compact::orchestrator::ManualCompactionOutcome> {
        match self.abort_run_and_wait(session_id, &cancel).await {
            AbortRunOutcome::Stopped => {}
            AbortRunOutcome::Cancelled => {
                return Ok(
                    crate::session::compact::orchestrator::ManualCompactionOutcome::Cancelled,
                )
            }
            AbortRunOutcome::TimedOut => {
                return Err(EvotError::Run(format!(
                    "active run did not stop within {} seconds; compaction was not started",
                    RUN_ABORT_WAIT_TIMEOUT.as_secs()
                )))
            }
        }
        let Some(session) = self.load_session(session_id).await? else {
            return Ok(
                crate::session::compact::orchestrator::ManualCompactionOutcome::NothingToCompact,
            );
        };
        self.compact_resolved_session(&session, custom_instructions, cancel, observer)
            .await
    }

    // -- query ---------------------------------------------------------------

    pub async fn submit(self: &Arc<Self>, mut request: QueryRequest) -> Result<SubmitOutcome> {
        // Freeze one selection for session metadata and every turn in this run.
        // Without this snapshot, concurrent callers changing the live model
        // could make a run start or auto-continue on a different provider.
        let llm = request.llm.clone().unwrap_or_else(|| self.llm());
        request.llm = Some(llm.clone());
        let session = self
            .session_service()
            .resolve(
                request.session_id.as_deref(),
                &request.source,
                SessionSelection {
                    provider: llm.provider.clone(),
                    model: llm.model.clone(),
                    thinking_level: Self::persisted_thinking_level_for(&llm),
                },
                request.cwd.as_deref(),
            )
            .await?;
        // A retried scheduled run may find a session created by an older
        // executor. Never silently reuse its inherited CLI checkout.
        if request.scratch_dir.is_some() {
            if let Some(cwd) = &request.cwd {
                if session.meta().await.cwd != *cwd {
                    return Err(EvotError::Conf(
                        "task session workspace differs from the prepared run workspace".into(),
                    ));
                }
            }
        }
        self.submit_to_session(request, session).await
    }

    /// Channel path: session is already resolved by the caller (RunManager).
    /// Intercepts gateway commands before starting a run.
    pub async fn submit_to_session(
        self: &Arc<Self>,
        request: QueryRequest,
        session: Arc<Session>,
    ) -> Result<SubmitOutcome> {
        // Intercept gateway commands (/clear, /compact, ...)
        if let Some(outcome) = self.maybe_handle_command(&request, &session).await? {
            return Ok(outcome);
        }
        // `/clip all` and `/sessions <query>` become prepared prompts and
        // continue as a normal run.
        let skills_dirs = self.assembler.skills_dirs.read().clone();
        let request = expand_prompt_command(request, &PromptCommandContext {
            skills_dirs: &skills_dirs,
            storage: self.storage.clone(),
            session: &session,
        })
        .await?;

        let run = self.start_run(request, session).await?;
        Ok(SubmitOutcome::Run(run))
    }

    // -- command handling (private) -------------------------------------------

    async fn maybe_handle_command(
        self: &Arc<Self>,
        request: &QueryRequest,
        session: &Arc<Session>,
    ) -> Result<Option<SubmitOutcome>> {
        use crate::agent::command::parse_command;
        use crate::agent::command::Command;

        let cmd = match parse_command(&request.input_text()) {
            Some(cmd) => cmd,
            None => return Ok(None),
        };

        match cmd {
            Command::UsageError(msg) => Ok(Some(SubmitOutcome::Command(msg))),
            Command::Clear => {
                let session_id = session.session_id().await;
                let _lifecycle = self.session_lifecycle_gate(&session_id).lock().await;
                self.abort_run_and_wait_for_completion(&session_id).await?;
                self.assembler.processes.retire(&session_id).await;
                session.write_clear_marker().await?;
                session.save().await?;
                Ok(Some(SubmitOutcome::Command("Session cleared.".into())))
            }
            Command::Compact {
                custom_instructions,
            } => {
                let session_id = session.session_id().await;
                let cancel = tokio_util::sync::CancellationToken::new();
                let outcome = match self.abort_run_and_wait(&session_id, &cancel).await {
                    AbortRunOutcome::Stopped => {
                        self.compact_resolved_session(session, custom_instructions, cancel, None)
                            .await?
                    }
                    AbortRunOutcome::Cancelled => {
                        crate::session::compact::orchestrator::ManualCompactionOutcome::Cancelled
                    }
                    AbortRunOutcome::TimedOut => {
                        return Err(EvotError::Run(format!(
                            "active run did not stop within {} seconds; compaction was not started",
                            RUN_ABORT_WAIT_TIMEOUT.as_secs()
                        )))
                    }
                };
                let msg = outcome.describe();
                Ok(Some(SubmitOutcome::Command(msg)))
            }
            Command::Dump { target } => {
                let msg = self
                    .handle_dump_command(request.mode, session, target.as_deref())
                    .await?;
                Ok(Some(SubmitOutcome::Command(msg)))
            }
            // Expanded into a normal prompt by `expand_prompt_command` after
            // this interception step; nothing to handle here.
            Command::ClipSession | Command::SessionSearch(_) => Ok(None),
        }
    }

    // -- run execution (private) ----------------------------------------------

    async fn compact_resolved_session(
        &self,
        session: &Arc<Session>,
        custom_instructions: Option<String>,
        cancel: tokio_util::sync::CancellationToken,
        observer: Option<crate::session::compact::orchestrator::ManualCompactionObserver>,
    ) -> Result<crate::session::compact::orchestrator::ManualCompactionOutcome> {
        if cancel.is_cancelled() {
            return Ok(crate::session::compact::orchestrator::ManualCompactionOutcome::Cancelled);
        }
        let context_window = self.resolved_context_window() as usize;
        let request = crate::session::compact::orchestrator::ManualCompactRequest {
            reason: crate::types::CompactReason::Manual,
            custom_instructions,
            summary_override: None,
            summarizer: Some(self.compact_summarizer()),
            settings: crate::session::compact::orchestrator::CompactSettings {
                context_window,
                ..Default::default()
            },
            observer,
        };
        crate::session::compact::service::compact(session, request, cancel).await
    }

    fn llm_provider(&self, protocol: &Protocol) -> Arc<dyn evot_engine::provider::StreamProvider> {
        match self.assembler.provider_override.read().clone() {
            Some(provider) => crate::agent::models::transport::overridden(provider),
            None => crate::agent::models::transport::for_protocol(protocol),
        }
    }

    fn compact_summarizer(&self) -> crate::session::compact::orchestrator::CompactSummarizer {
        let llm = self.selection.snapshot();
        let provider = self.llm_provider(&llm.protocol);
        crate::session::compact::orchestrator::CompactSummarizer {
            provider,
            llm,
            reserve_tokens: evot_engine::DEFAULT_SUMMARY_RESERVE_TOKENS,
            timeout: None,
        }
    }

    async fn start_run(
        self: &Arc<Self>,
        request: QueryRequest,
        session: Arc<Session>,
    ) -> Result<Run> {
        let session_id = session.meta().await.session_id.clone();
        let _lifecycle = self.session_lifecycle_gate(&session_id).lock().await;
        self.abort_run_and_wait_for_completion(&session_id).await?;
        let run_id = crate::types::new_id();
        // `submit_to_session` is also public and may bypass `submit`, so keep a
        // fallback snapshot here for channel callers that did not pin one.
        let llm = request.llm.clone().unwrap_or_else(|| self.llm());
        session
            .set_model_selection(llm.provider.clone(), llm.model.clone())
            .await?;
        session
            .set_thinking_level(Self::persisted_thinking_level_for(&llm))
            .await;

        tracing::info!(
            stage = "run",
            status = "started",
            run_id = %run_id,
            session_id = %session_id,
            provider = ?llm.provider,
            model = %llm.model,
        );

        // Completion is a one-shot signal, not a polled flag. This avoids a
        // manual compaction waiting forever on stale run state.
        let completed = tokio_util::sync::CancellationToken::new();

        // Build cleanup callback — signal completion, remove only if still this run
        let active_runs = self.active_runs.clone();
        let sid = session_id.clone();
        let rid = run_id.clone();
        let completed_signal = completed.clone();
        let on_complete: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            active_runs.complete(&sid, &rid, &completed_signal);
        });

        let factory: Arc<dyn TurnFactory> = Arc::new(AgentTurnFactory {
            assembler: Arc::clone(&self.assembler),
            session: Arc::clone(&session),
            mode: request.mode,
            session_id: session_id.clone(),
            llm,
            previous_llm: self.selection.previous_llm(),
            host_tools: request.host_tools.clone(),
            extra_tools: request.extra_tools.clone(),
            approver: request.approver.clone(),
            scratch_dir: request.scratch_dir.clone(),
        });

        let run = runtime::execute_run(runtime::ExecuteRunArgs {
            run_id: run_id.clone(),
            session_id: session_id.clone(),
            session,
            initial_input: request.input,
            factory,
            on_complete: Some(on_complete),
        });

        // Register while holding the same map lock used by on_complete. The
        // completion token is cancelled before that callback takes the lock, so
        // this ordering closes the check/insert race that could leave a finished
        // run registered forever.
        self.active_runs
            .register(session_id, run_id, run.handle(), completed);

        Ok(run)
    }

    // -- fork ----------------------------------------------------------------

    /// Build a structured snapshot of what evot would send to the LLM right
    /// now (system prompt + tool definitions). Persists
    /// to JSON and returns a human-readable status string.
    async fn handle_dump_command(
        self: &Arc<Self>,
        mode: ToolMode,
        session: &Arc<Session>,
        target: Option<&str>,
    ) -> Result<String> {
        let session_id = session.session_id().await;
        // build_turn runs the full per-turn assembly (tools, skills).
        let llm = self.llm();
        let turn = self
            .assembler
            .build_turn(
                &llm,
                mode,
                Arc::clone(session),
                &session_id,
                TurnBuildRequest {
                    input: Vec::new(),
                    host_tools: None,
                    extra_tools: Vec::new(),
                    approver: None,
                    consume_process_notifications: false,
                    previous_llm: None,
                    scratch_dir: None,
                },
            )
            .await?;

        let dump = build_prompt_dump(mode, &turn);

        let path = resolve_dump_path(target)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                EvotError::Agent(format!(
                    "failed to create dump dir {}: {err}",
                    parent.display()
                ))
            })?;
        }
        let json = serde_json::to_string_pretty(&dump)
            .map_err(|err| EvotError::Agent(format!("failed to serialize prompt dump: {err}")))?;
        std::fs::write(&path, json).map_err(|err| {
            EvotError::Agent(format!("failed to write dump to {}: {err}", path.display()))
        })?;

        Ok(format!(
            "Prompt dump saved to {}\n  system_prompt: {} tokens ({} sections)\n  tools: {} entries, {} tokens\n  total: {} tokens",
            path.display(),
            dump.totals.system_prompt_tokens,
            dump.system_prompt.sections.len(),
            dump.tools.len(),
            dump.totals.tool_definition_tokens,
            dump.totals.grand_total,
        ))
    }
}
