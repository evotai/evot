use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;

use super::dump::build_prompt_dump;
use super::dump::resolve_dump_path;
use super::fork::ForkRequest;
use super::fork::ForkedAgent;
use super::request::expand_prompt_command;
use super::request::ExecutionLimits;
use super::request::PromptCommandContext;
use super::request::QueryRequest;
use super::request::SubmitOutcome;
use super::run::registry::RunRegistry;
use super::run::run::Run;
use super::run::runtime;
use super::run::runtime::TurnFactory;
use super::tools::ToolMode;
use super::turn_assembler::TurnAssembler;
use super::turn_assembler::TurnBuildRequest;
use super::turn_factory::AgentTurnFactory;
use super::variables::Variables;
use crate::agent::prompt::Section;
use crate::conf::Config;
use crate::conf::LlmConfig;
use crate::conf::Protocol;
use crate::error::EvotError;
use crate::error::Result;
use crate::models::ModelSelection;
use crate::models::SelectionReload;
use crate::sessions::Session;
use crate::sessions::SessionGates;
use crate::sessions::SessionQueries;
use crate::sessions::SessionSelection;
use crate::sessions::SessionService;
use crate::storage::open_storage;
use crate::storage::MemoryStorage;
use crate::storage::Storage;
use crate::types::SessionMeta;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

enum AbortRunOutcome {
    Stopped,
    Cancelled,
    TimedOut,
}

const RUN_ABORT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const COMPACTION_SUMMARY_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Agent {
    selection: ModelSelection,
    system_prompt: RwLock<String>,
    assembler: Arc<TurnAssembler>,
    cwd: String,
    storage: Arc<dyn Storage>,
    /// session_id → (run_id, handle, done_flag)
    active_runs: Arc<RunRegistry>,
    /// Fixed sharded gates linearize start/clear/delete per session without
    /// retaining one lock per historical session.
    session_lifecycle_gates: SessionGates,
}

impl Agent {
    pub fn new(config: &Config, cwd: impl Into<String>) -> Result<Arc<Self>> {
        let cwd = cwd.into();
        let storage = open_storage(&config.storage)?;
        Ok(Arc::new(Self::new_inner(config, cwd, storage)?))
    }

    fn new_inner(config: &Config, cwd: String, storage: Arc<dyn Storage>) -> Result<Self> {
        let system_prompt = format!("You are a helpful assistant. Working directory: {cwd}");
        Ok(Self {
            selection: ModelSelection::new(
                config
                    .active_llm()
                    .unwrap_or_else(|_| LlmConfig::unconfigured()),
            ),
            system_prompt: RwLock::new(system_prompt),
            assembler: Arc::new(TurnAssembler::new(config)),
            cwd,
            storage,
            active_runs: Arc::new(RunRegistry::default()),
            session_lifecycle_gates: SessionGates::new(),
        })
    }

    pub fn new_with_provider_for_test(
        config: &Config,
        cwd: impl Into<String>,
        storage: Arc<dyn Storage>,
        provider: impl evot_engine::provider::StreamProvider + 'static,
    ) -> Result<Arc<Self>> {
        let agent = Arc::new(Self::new_inner(config, cwd.into(), storage)?);
        *agent.assembler.provider_override.write() = Some(Arc::new(provider));
        Ok(agent)
    }

    // -- configuration (fluent setters) --------------------------------------

    pub fn with_system_prompt(self: &Arc<Self>, prompt: impl Into<String>) -> Arc<Self> {
        let prompt = prompt.into();
        let mut current_prompt = self.system_prompt.write();
        let mut sections = self.assembler.system_prompt_sections.write();
        *current_prompt = prompt;
        sections.clear();
        Arc::clone(self)
    }

    /// Set the system prompt along with its per-section breakdown. The joined
    /// `text` must equal `sections` joined by `"\n\n"` — same invariant as
    /// `SystemPrompt::build_with_sections`.
    pub fn with_system_prompt_sections(
        self: &Arc<Self>,
        text: String,
        sections: Vec<Section>,
    ) -> Arc<Self> {
        let mut current_prompt = self.system_prompt.write();
        let mut current_sections = self.assembler.system_prompt_sections.write();
        *current_prompt = text;
        *current_sections = sections;
        Arc::clone(self)
    }

    /// Insert extra instructions where pi places `appendSystemPrompt`: after
    /// guidelines and before project context and the working directory.
    pub fn append_system_prompt(self: &Arc<Self>, extra: &str) -> Arc<Self> {
        if extra.is_empty() {
            return Arc::clone(self);
        }

        let mut prompt = self.system_prompt.write();
        let mut sections = self.assembler.system_prompt_sections.write();
        if sections.is_empty() {
            if !prompt.is_empty() {
                prompt.push_str("\n\n");
            }
            prompt.push_str(extra);
            return Arc::clone(self);
        }

        let insert_at = match sections.iter().position(|section| {
            matches!(
                section.name,
                "project_context" | "environment" | "dynamic_boundary"
            )
        }) {
            Some(index) => index,
            None => sections.len(),
        };
        sections.insert(insert_at, Section {
            name: "append",
            text: extra.to_string(),
        });
        *prompt = sections
            .iter()
            .map(|section| section.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        Arc::clone(self)
    }

    pub fn with_limits(self: &Arc<Self>, limits: ExecutionLimits) -> Arc<Self> {
        *self.assembler.limits.write() = limits;
        Arc::clone(self)
    }

    pub fn with_skills_dirs(self: &Arc<Self>, dirs: Vec<PathBuf>) -> Arc<Self> {
        *self.assembler.skills_dirs.write() = dirs;
        self.with_claude_skills_dirs()
    }

    pub fn add_skills_dirs(self: &Arc<Self>, dirs: Vec<PathBuf>) -> Arc<Self> {
        {
            let mut current = self.assembler.skills_dirs.write();
            for dir in dirs {
                if !current.contains(&dir) {
                    current.push(dir);
                }
            }
        }
        self.with_claude_skills_dirs()
    }

    pub fn set_skill_names(&self, names: Vec<String>) -> Result<()> {
        crate::agent::prompt::skill::load_skills_by_name(&self.skills_dirs(), &names)
            .map_err(|error| EvotError::Agent(error.to_string()))?;
        *self.assembler.skill_names.write() = Some(names);
        Ok(())
    }

    fn with_claude_skills_dirs(self: &Arc<Self>) -> Arc<Self> {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            let claude_dir = PathBuf::from(home).join(".claude").join("skills");
            if claude_dir.is_dir() {
                let mut dirs = self.assembler.skills_dirs.write();
                if !dirs.contains(&claude_dir) {
                    dirs.push(claude_dir);
                }
            }
        }
        Arc::clone(self)
    }

    pub fn with_variables(self: &Arc<Self>, variables: Arc<Variables>) -> Arc<Self> {
        *self.assembler.variables.write() = Some(variables);
        Arc::clone(self)
    }

    // -- getters -------------------------------------------------------------

    pub fn system_prompt(&self) -> String {
        self.system_prompt.read().clone()
    }

    pub fn llm(&self) -> LlmConfig {
        self.selection.snapshot()
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    /// The fully-resolved, ordered list of skills directories the agent scans:
    /// managed builtins, global `~/.evotai/skills`, config dirs, then
    /// `~/.claude/skills`. This is the single source of truth the CLI display
    /// layer should read so `/skill list` and the banner never drift from what
    /// the agent actually loads.
    pub fn skills_dirs(&self) -> Vec<PathBuf> {
        self.assembler.skills_dirs.read().clone()
    }

    pub fn limits(&self) -> ExecutionLimits {
        self.assembler.limits.read().clone()
    }

    pub fn set_llm(&self, llm: LlmConfig) {
        self.selection.replace(llm);
    }

    /// Set the active thinking level for the current provider.
    pub fn set_thinking_level(&self, level: evot_engine::ThinkingLevel) {
        self.selection.set_thinking_level(level);
    }

    /// Apply a named thinking level when supported by the active model.
    /// Kept as a public API for callers that explicitly manage live state;
    /// session resume intentionally reloads the current configured value instead.
    pub fn restore_thinking_level(&self, name: &str) {
        self.selection.restore_thinking_level(name);
    }

    /// Thinking levels the current model can cycle through, in ascending order
    /// of effort. Empty when the model does not honor a reasoning effort (e.g.
    /// an OpenAI-compatible provider without the reasoning-effort capability).
    pub fn supported_thinking_levels(&self) -> Vec<evot_engine::ThinkingLevel> {
        self.selection.supported_thinking_levels()
    }

    /// The active model's resolved context window in tokens, after applying
    /// explicit overrides. Used to size and validate compaction so the retained
    /// context fits what the model actually accepts.
    pub fn resolved_context_window(&self) -> u32 {
        self.selection.resolved_context_window()
    }

    /// Advance the thinking level to the next supported tier, wrapping around.
    /// Returns the new level, or `None` when the model has no selectable levels.
    pub fn cycle_thinking_level(&self) -> Option<evot_engine::ThinkingLevel> {
        self.selection.cycle_thinking_level()
    }

    /// Set the active model by spec (e.g. "deepseek-chat" or "openrouter:google/gemini-2.5-pro").
    ///
    /// Resolution and provider config errors are returned before mutating the
    /// active LLM. Explicit `provider:model` remains the escape hatch for model
    /// ids not listed in config, as long as the provider itself exists.
    pub fn set_model_by_spec(&self, config: &Config, spec: &str) -> Result<()> {
        self.selection.select_by_spec(config, spec)
    }

    /// Select a model from the configured directory and return the exact
    /// snapshot to pin to a run. This does not persist configuration.
    pub fn select_configured_model(
        &self,
        config: &Config,
        provider: &str,
        model: &str,
        thinking_level: Option<&str>,
    ) -> Result<LlmConfig> {
        self.selection
            .select_configured(config, provider, model, thinking_level)
    }

    /// Re-resolve the live selection against a reloaded config, after login,
    /// logout, key recovery, or a settings write.
    ///
    /// The live (provider, model) is authoritative whenever the new config still
    /// serves it: re-minting a scoped key must not move a running session onto
    /// the catalog's landing model. Its thinking level rides along, clamped to
    /// what the model supports. Otherwise the config's own active selection
    /// takes over — a first login lands on the catalog default, and logout falls
    /// back to whatever BYOK remains, or to no model at all.
    ///
    /// Total by construction: every config maps to one of the three landings, so
    /// callers never have to invent a recovery of their own.
    pub fn reload_selection(&self, config: &Config) -> SelectionReload {
        self.selection.reload_selection(config)
    }

    /// Restore a resumed session's saved provider/model. Falls back to
    /// re-resolving the live selection when the saved one is gone (e.g. a
    /// provider dropped from config), so its thinking level still refreshes.
    /// Returns whether the saved selection was restored.
    pub fn reload_provider_for_resume(&self, config: &Config, spec: &str) -> Result<bool> {
        self.selection.reload_provider_for_resume(config, spec)
    }

    pub fn variables(&self) -> Option<Arc<Variables>> {
        self.assembler.variables.read().clone()
    }

    pub fn storage(&self) -> Arc<dyn Storage> {
        self.storage.clone()
    }

    fn session_lifecycle_gate(&self, session_id: &str) -> &tokio::sync::Mutex<()> {
        self.session_lifecycle_gates.gate(session_id)
    }

    // -- run control ---------------------------------------------------------

    /// Send a steering message to the active run for a session.
    pub fn steer(&self, session_id: &str, input: Vec<evot_engine::Content>) {
        self.try_steer(session_id, input);
    }

    pub fn try_steer(&self, session_id: &str, input: Vec<evot_engine::Content>) -> bool {
        self.active_runs.try_steer(
            session_id,
            evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                content: input,
                timestamp: evot_engine::now_ms(),
            }),
        )
    }

    /// Send a follow-up message to the active run for a session.
    pub fn follow_up(&self, session_id: &str, text: impl Into<String>) {
        self.active_runs.follow_up(
            session_id,
            evot_engine::AgentMessage::Llm(evot_engine::Message::user(text)),
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
    ) -> Result<crate::compact::orchestrator::ManualCompactionOutcome> {
        self.compact_with_observer(session_id, custom_instructions, cancel, None)
            .await
    }

    pub async fn compact_with_observer(
        &self,
        session_id: &str,
        custom_instructions: Option<String>,
        cancel: tokio_util::sync::CancellationToken,
        observer: Option<crate::compact::orchestrator::ManualCompactionObserver>,
    ) -> Result<crate::compact::orchestrator::ManualCompactionOutcome> {
        match self.abort_run_and_wait(session_id, &cancel).await {
            AbortRunOutcome::Stopped => {}
            AbortRunOutcome::Cancelled => {
                return Ok(crate::compact::orchestrator::ManualCompactionOutcome::Cancelled)
            }
            AbortRunOutcome::TimedOut => {
                return Err(EvotError::Run(format!(
                    "active run did not stop within {} seconds; compaction was not started",
                    RUN_ABORT_WAIT_TIMEOUT.as_secs()
                )))
            }
        }
        let Some(session) = self.load_session(session_id).await? else {
            return Ok(crate::compact::orchestrator::ManualCompactionOutcome::NothingToCompact);
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
        let llm = request.llm.clone().unwrap_or_else(|| self.llm());
        let request = expand_prompt_command(request, &PromptCommandContext {
            skills_dirs: &skills_dirs,
            storage: self.storage.as_ref(),
            session: &session,
            llm: &llm,
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
        use crate::command::parse_command;
        use crate::command::Command;

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
                        crate::compact::orchestrator::ManualCompactionOutcome::Cancelled
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
        observer: Option<crate::compact::orchestrator::ManualCompactionObserver>,
    ) -> Result<crate::compact::orchestrator::ManualCompactionOutcome> {
        if cancel.is_cancelled() {
            return Ok(crate::compact::orchestrator::ManualCompactionOutcome::Cancelled);
        }
        let context_window = self.resolved_context_window() as usize;
        let request = crate::compact::orchestrator::ManualCompactRequest {
            reason: crate::types::CompactReason::Manual,
            custom_instructions,
            summary_override: None,
            summarizer: Some(self.compact_summarizer()),
            settings: crate::compact::orchestrator::CompactSettings {
                context_window,
                ..Default::default()
            },
            observer,
        };
        crate::compact::service::compact(session, request, cancel).await
    }

    fn llm_provider(&self, protocol: &Protocol) -> Arc<dyn evot_engine::provider::StreamProvider> {
        use evot_engine::provider::AnthropicProvider;
        use evot_engine::provider::OpenAiCompatProvider;
        use evot_engine::provider::OpenAiResponsesProvider;

        self.assembler
            .provider_override
            .read()
            .clone()
            .unwrap_or_else(|| match protocol {
                Protocol::Anthropic => Arc::new(AnthropicProvider),
                Protocol::OpenAiResponses => Arc::new(OpenAiResponsesProvider),
                Protocol::OpenAi => Arc::new(OpenAiCompatProvider),
            })
    }

    fn compact_summarizer(&self) -> crate::compact::orchestrator::CompactSummarizer {
        let llm = self.selection.snapshot();
        let provider = self.llm_provider(&llm.protocol);
        crate::compact::orchestrator::CompactSummarizer {
            provider,
            llm,
            reserve_tokens: evot_engine::DEFAULT_SUMMARY_RESERVE_TOKENS,
            timeout: COMPACTION_SUMMARY_TIMEOUT,
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
            host_tools: request.host_tools.clone(),
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

        let forked = Arc::new(Self {
            selection: ModelSelection::new(selection.snapshot()),
            system_prompt: RwLock::new(request.system_prompt),
            assembler: Arc::new(assembler.fork()),
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

    /// Listing view of a session's background tasks. Uses the summary form so a
    /// polling caller never copies captured output.
    pub fn background_processes(
        &self,
        session_id: &str,
    ) -> Vec<evot_engine::tools::ProcessSummary> {
        self.assembler.processes.summaries(session_id)
    }

    pub async fn stop_background_process(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<Option<evot_engine::tools::ProcessSummary>> {
        self.assembler
            .processes
            .stop_background(session_id, task_id)
            .await
    }

    /// Detach every foreground shell in a session, returning how many moved.
    ///
    /// The processes keep running; only the waiting ends. Used when the user
    /// wants the turn back without discarding work in flight.
    pub fn background_foreground_processes(
        &self,
        session_id: &str,
        reason: evot_engine::tools::BackgroundReason,
    ) -> usize {
        self.assembler
            .processes
            .background_foreground(session_id, reason)
    }

    /// Blocking `task_output` waits in flight for a session.
    ///
    /// Such a wait holds the whole turn while the task it watches is already
    /// backgrounded, so there is no foreground shell to detach — the UI needs
    /// this count to know ctrl+b has something to release.
    pub fn blocking_task_waits(&self, session_id: &str) -> usize {
        self.assembler.processes.blocking_waiters(session_id)
    }

    /// End in-flight blocking waits, returning how many were released.
    ///
    /// The watched tasks keep running; only the waiting ends.
    pub fn release_blocking_task_waits(&self, session_id: &str) -> usize {
        self.assembler
            .processes
            .release_blocking_waiters(session_id)
    }

    /// Completion notices queued for a session but not yet delivered to a turn.
    ///
    /// Non-consuming: the caller is deciding *whether* to open a turn, and a
    /// turn is the only thing that can actually carry these. `build_turn`
    /// drains them via `take_notifications`.
    pub fn pending_process_notifications(&self, session_id: &str) -> usize {
        self.assembler.processes.pending_notifications(session_id)
    }

    pub fn pending_process_wake_notifications(&self, session_id: &str) -> usize {
        self.assembler
            .processes
            .pending_wake_notifications(session_id)
    }

    pub async fn stop_all_background_processes(
        &self,
        session_id: &str,
    ) -> Vec<evot_engine::tools::ProcessSummary> {
        self.assembler
            .processes
            .stop_all_background(session_id)
            .await
    }

    /// Kill every background process across all sessions, synchronously.
    ///
    /// Used on process-exit paths that bypass async teardown, where waiting is
    /// not possible and orphaned children are the failure mode.
    pub fn kill_all_background_processes_now(&self) -> usize {
        self.assembler.processes.kill_all_now()
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

    fn session_service(&self) -> SessionService {
        SessionService::new(self.storage.clone(), self.cwd.clone())
    }

    // -- private -------------------------------------------------------------

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
                    consume_process_notifications: false,
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

    /// The session-facing label for the agent's current thinking level, or
    /// `None` when the level is not a selectable tier for the active model
    /// (e.g. a config-set level the model rejects). Resume restores this
    /// snapshot over the config default, so gating on membership keeps the
    /// metadata meaningful.
    fn persisted_thinking_level_for(llm: &LlmConfig) -> Option<String> {
        let level = llm.thinking_level;
        if ModelSelection::supported_thinking_levels_for(llm).contains(&level) {
            Some(level.as_str().to_string())
        } else {
            None
        }
    }
}
