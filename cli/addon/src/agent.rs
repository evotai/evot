use std::path::PathBuf;
use std::sync::Arc;

use evot::api::Agent;
use evot::api::BackgroundReason;
use evot::api::ForkRequest;
use evot::api::HostTools;
use evot::api::ModelSelection;
use evot::api::QueryRequest;
use evot::api::SelectionReload;
use evot::api::ToolMode;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::compaction::NapiCompaction;
use crate::convert::parse_content_blocks;
use crate::fork::NapiForkedAgent;
use crate::host::parse_host_tool_specs;
use crate::host::HostResponders;
use crate::host::NapiHostBridge;
use crate::run::NapiRun;
use crate::run::NapiSubmitOutcome;
use crate::tracing::init_tracing;

#[napi]
pub struct NapiAgent {
    pub(crate) agent: Arc<Agent>,
    env_file_path: String,
    startup_warning: Option<String>,
}

#[napi]
impl NapiAgent {
    /// Load config from disk and create an agent.
    #[napi(factory)]
    pub async fn create(model: Option<String>, env_file: Option<String>) -> Result<Self> {
        init_tracing();

        // A stale `--model` (removed from the catalog, typo) must not exit the
        // process: the fixes (/login, model picker) live behind this startup.
        let (config, startup_warning) = evot::api::Config::load_with_env_file(env_file.as_deref())
            .map_err(|e| Error::from_reason(format!("config load failed: {e}")))?
            .with_model_or_fallback(model);

        let env_file_path = config.env_file_path.to_string_lossy().to_string();
        let agent = evot::api::build_agent(&config)
            .await
            .map_err(|e| Error::from_reason(format!("agent init: {e}")))?;

        Ok(Self {
            agent,
            env_file_path,
            startup_warning,
        })
    }

    /// Non-fatal startup diagnostic (e.g. an ignored `--model`), if any.
    #[napi(getter)]
    pub fn startup_warning(&self) -> Option<String> {
        self.startup_warning.clone()
    }

    /// Current model name.
    #[napi(getter)]
    pub fn model(&self) -> String {
        self.agent.llm().model
    }

    /// Set the active model by model spec (e.g. "deepseek-chat" or "openrouter:google/gemini-2.5-pro").
    #[napi(setter)]
    pub fn set_model(&mut self, model: String) -> Result<()> {
        let config = self.load_config()?;
        self.agent
            .set_model_by_spec(&config, &model)
            .map_err(|e| Error::from_reason(format!("model switch failed: {e}")))?;
        Ok(())
    }

    /// Current working directory.
    #[napi(getter)]
    pub fn cwd(&self) -> String {
        self.agent.cwd().to_string()
    }

    /// Send a prompt and get a stream of events.
    ///
    /// `host_specs_json` is a JSON array of host tool specs the TS side
    /// registered (ask_user, extension tools). When present and the mode
    /// permits, these are attached to the run and their execution is delegated
    /// back to JS via `host_tool_call` events.
    #[napi]
    pub async fn query(
        &self,
        prompt: String,
        session_id: Option<String>,
        tool_mode: Option<String>,
        content_json: Option<String>,
        host_specs_json: Option<String>,
    ) -> Result<NapiSubmitOutcome> {
        let (host_event_tx, host_event_rx) = tokio_mpsc::channel::<String>(32);
        let host_responders: HostResponders =
            Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

        let mode = match tool_mode.as_deref() {
            Some("interactive") => ToolMode::Interactive,
            Some("planning" | "planning_interactive") => {
                return Err(Error::from_reason(
                    "Planning mode has been removed. Use interactive mode instead.",
                ));
            }
            Some("readonly") => ToolMode::Readonly,
            _ => ToolMode::Headless,
        };

        // Assemble host tools from the registered specs. Readonly runs carry no
        // host bridge (as required by the resolved preset policy).
        let host_tools = if mode.policy().host_tools {
            let specs =
                parse_host_tool_specs(host_specs_json.as_deref()).map_err(Error::from_reason)?;
            if specs.is_empty() {
                None
            } else {
                let bridge = Arc::new(NapiHostBridge::new(host_event_tx, host_responders.clone()));
                Some(HostTools::new(bridge, specs))
            }
        } else {
            None
        };

        let request = if let Some(json) = content_json {
            let input = parse_content_blocks(&json).map_err(Error::from_reason)?;

            if input.is_empty() {
                return Err(Error::from_reason("empty content"));
            }

            QueryRequest::with_input(input)
                .session_id(session_id)
                .mode(mode)
                .host_tools(host_tools)
                .source("repl")
        } else {
            QueryRequest::text(prompt)
                .session_id(session_id)
                .mode(mode)
                .host_tools(host_tools)
                .source("repl")
        };

        let outcome = self
            .agent
            .submit(request)
            .await
            .map_err(|e| Error::from_reason(format!("query failed: {e}")))?;

        match outcome {
            evot::api::SubmitOutcome::Command(msg) => Ok(NapiSubmitOutcome {
                kind: "command".into(),
                run: std::sync::Mutex::new(None),
                message: Some(msg),
            }),
            evot::api::SubmitOutcome::Run(run) => {
                let sid = run.session_id.clone();
                let handle = run.handle();

                Ok(NapiSubmitOutcome {
                    kind: "run".into(),
                    run: std::sync::Mutex::new(Some(NapiRun {
                        inner: Mutex::new(run),
                        handle,
                        cached_session_id: sid,
                        abort_signal: CancellationToken::new(),
                        host_event_rx: Mutex::new(Some(host_event_rx)),
                        host_responders,
                    })),
                    message: None,
                })
            }
        }
    }

    #[napi]
    pub async fn create_session(&self) -> Result<String> {
        let meta = self
            .agent
            .create_session("repl")
            .await
            .map_err(|e| Error::from_reason(format!("create session: {e}")))?;

        serde_json::to_string(&meta).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    #[napi]
    pub async fn list_sessions(&self, limit: Option<u32>) -> Result<String> {
        let sessions = self
            .agent
            .sessions()
            .list(limit.unwrap_or(20) as usize)
            .await
            .map_err(|e| Error::from_reason(format!("list sessions: {e}")))?;

        serde_json::to_string(&sessions).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    #[napi]
    pub async fn list_sessions_with_text(&self, limit: Option<u32>) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .list_with_text(limit.unwrap_or(0) as usize)
            .await
            .map_err(|e| Error::from_reason(format!("list sessions with text: {e}")))?;
        serde_json::to_string(&items).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// One session's text, for the resume pane's focused row. Returns `null`
    /// when the session is gone.
    #[napi]
    pub async fn session_with_text(&self, session_id: String) -> Result<Option<String>> {
        let item = self
            .agent
            .sessions()
            .with_text(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("session with text: {e}")))?;
        match item {
            Some(item) => serde_json::to_string(&item)
                .map(Some)
                .map_err(|e| Error::from_reason(format!("serialize: {e}"))),
            None => Ok(None),
        }
    }

    #[napi]
    pub async fn rename_session(&self, session_id: String, title: String) -> Result<String> {
        let session = self
            .agent
            .rename_session(&session_id, &title)
            .await
            .map_err(|e| Error::from_reason(format!("rename session: {e}")))?;
        serde_json::to_string(&session).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Fork `source_id` into a new persistent session inheriting its context.
    #[napi]
    pub async fn fork_session(&self, source_id: String, title: Option<String>) -> Result<String> {
        let meta = self
            .agent
            .fork_session(&source_id, title.as_deref())
            .await
            .map_err(|e| Error::from_reason(format!("fork session: {e}")))?;
        serde_json::to_string(&meta).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Fork ancestry, root first and `session_id` last. Empty when unknown.
    #[napi]
    pub async fn session_lineage(&self, session_id: String) -> Result<String> {
        let chain = self
            .agent
            .sessions()
            .lineage(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("session lineage: {e}")))?;
        serde_json::to_string(&chain).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    #[napi]
    pub async fn delete_session(&self, session_id: String) -> Result<bool> {
        self.agent
            .delete_session(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("delete session: {e}")))
    }

    #[napi]
    pub fn background_processes(&self, session_id: String) -> Result<String> {
        serialize_process_summaries(self.agent.background_processes(&session_id))
    }

    #[napi]
    pub async fn stop_background_process(
        &self,
        session_id: String,
        task_id: String,
    ) -> Result<Option<String>> {
        let summary = self
            .agent
            .stop_background_process(&session_id, &task_id)
            .await
            .map_err(|e| Error::from_reason(format!("stop background process: {e}")))?;
        summary.map(serialize_process_summary).transpose()
    }

    /// Detach every foreground shell in a session so the turn can be reclaimed.
    ///
    /// The processes keep running; only the waiting ends. Returns how many moved.
    #[napi]
    pub fn background_foreground_processes(&self, session_id: String) -> u32 {
        self.agent
            .background_foreground_processes(&session_id, BackgroundReason::UserRequested)
            as u32
    }

    /// Same detach, attributed to a queued message needing delivery.
    ///
    /// Steering is only inspected between tool calls, so a foreground shell
    /// holds a typed message until it finishes. Detaching lets the message land
    /// while the command keeps running.
    #[napi]
    pub fn background_foreground_processes_for_message(&self, session_id: String) -> u32 {
        self.agent
            .background_foreground_processes(&session_id, BackgroundReason::MessageDelivery)
            as u32
    }

    /// Blocking `task_output` waits in flight for this session.
    ///
    /// Such a wait holds the turn while the task it watches is already
    /// backgrounded, so no foreground shell exists to detach.
    #[napi]
    pub fn blocking_task_waits(&self, session_id: String) -> u32 {
        self.agent.blocking_task_waits(&session_id) as u32
    }

    /// End in-flight blocking waits, returning how many were released. The
    /// watched tasks keep running; only the waiting ends.
    #[napi]
    pub fn release_blocking_task_waits(&self, session_id: String) -> u32 {
        self.agent.release_blocking_task_waits(&session_id) as u32
    }

    /// Completion notices queued for this session but not yet delivered.
    ///
    /// Does not consume them: only a turn can carry them, so the UI polls this
    /// to decide whether to open one.
    #[napi]
    pub fn pending_process_notifications(&self, session_id: String) -> u32 {
        self.agent.pending_process_notifications(&session_id) as u32
    }

    #[napi]
    pub fn pending_process_wake_notifications(&self, session_id: String) -> u32 {
        self.agent.pending_process_wake_notifications(&session_id) as u32
    }

    #[napi]
    pub async fn stop_all_background_processes(&self, session_id: String) -> Result<String> {
        serialize_process_summaries(self.agent.stop_all_background_processes(&session_id).await)
    }

    /// Kill every background process across all sessions without awaiting.
    /// Safe to call immediately before `fastExit`, which skips async teardown.
    #[napi]
    pub fn kill_all_background_processes_now(&self) -> u32 {
        self.agent.kill_all_background_processes_now() as u32
    }

    /// Load transcript for a session.
    #[napi]
    pub async fn load_transcript(&self, session_id: String) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .transcript(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("load transcript: {e}")))?;

        serde_json::to_string(&evot::conversation::input::transcript_views(&items))
            .map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Load the effective context transcript for a session, after control markers.
    #[napi]
    pub async fn load_context_transcript(&self, session_id: String) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .context_transcript(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("load context transcript: {e}")))?;

        serde_json::to_string(&evot::conversation::input::transcript_views(&items))
            .map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Load a bounded resume view without superseded history or Engine-only
    /// compact snapshot fields.
    #[napi]
    pub async fn load_resume_transcript(&self, session_id: String) -> Result<String> {
        let items = self
            .agent
            .sessions()
            .resume_transcript(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("load resume transcript: {e}")))?;

        serde_json::to_string(&evot::conversation::input::transcript_views(&items))
            .map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Find a single session by ID.
    #[napi]
    pub async fn find_session(&self, session_id: String) -> Result<Option<String>> {
        let meta = self
            .agent
            .sessions()
            .find(&session_id)
            .await
            .map_err(|e| Error::from_reason(format!("find session: {e}")))?;
        match meta {
            Some(m) => serde_json::to_string(&m)
                .map(Some)
                .map_err(|e| Error::from_reason(format!("serialize: {e}"))),
            None => Ok(None),
        }
    }

    /// Fork the agent for a side conversation (readonly, ephemeral).
    #[napi]
    pub fn fork(&self, system_prompt: String) -> Result<NapiForkedAgent> {
        let request = ForkRequest { system_prompt };
        let forked = self
            .agent
            .fork(request)
            .map_err(|e| Error::from_reason(format!("fork: {e}")))?;
        Ok(NapiForkedAgent::new(forked))
    }

    /// List agent variables as JSON array of {key, value, updated_at}.
    #[napi]
    pub fn list_variables(&self) -> Result<String> {
        match self.agent.variables() {
            Some(vars) => {
                let items: Vec<_> = vars
                    .list_global()
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                            "key": v.key,
                            "value": v.value,
                            "updated_at": v.updated_at,
                        })
                    })
                    .collect();
                serde_json::to_string(&items)
                    .map_err(|e| Error::from_reason(format!("serialize: {e}")))
            }
            None => Ok("[]".to_string()),
        }
    }

    /// Set an agent variable (persisted).
    #[napi]
    pub async fn set_variable(&self, key: String, value: String) -> Result<()> {
        match self.agent.variables() {
            Some(vars) => vars
                .set_global(key, value)
                .await
                .map_err(|e| Error::from_reason(format!("set variable: {e}"))),
            None => Err(Error::from_reason("variables not available")),
        }
    }

    /// Delete an agent variable. Returns true if it existed.
    #[napi]
    pub async fn delete_variable(&self, key: String) -> Result<bool> {
        match self.agent.variables() {
            Some(vars) => vars
                .delete_global(&key)
                .await
                .map_err(|e| Error::from_reason(format!("delete variable: {e}"))),
            None => Err(Error::from_reason("variables not available")),
        }
    }

    /// Get config info: active provider/protocol, env path, base URL, and configured models.
    /// Reloads the config file so edits are visible without restarting the CLI.
    #[napi]
    pub fn config_info(&self) -> Result<String> {
        let config = self.load_config()?;
        let llm = self.agent.llm();
        let provider = llm.provider.clone();
        let env_path = config.env_file_path.to_string_lossy().to_string();
        let has_api_key = !llm.api_key.is_empty();
        let available = self.collect_models(&config);
        let thinking_level = ModelSelection::display_thinking_level_for(&llm);
        let info = evot::api::ConfigInfo {
            provider,
            protocol: llm.protocol.to_string(),
            env_path,
            has_api_key,
            base_url: Some(llm.base_url),
            available_models: available,
            thinking_level,
            judge: config.judge.as_ref().map(|judge| judge.model.clone()),
            default_model: config.cloud_default_model.clone(),
        };
        serde_json::to_string(&info).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    /// Get configured models as provider-qualified specs. Provider qualification
    /// keeps entries distinct when multiple providers expose the same model id;
    /// config info also carries each provider's wire protocol.
    #[napi]
    pub fn available_models(&self) -> Result<Vec<String>> {
        let config = self.load_config()?;
        Ok(self
            .collect_models(&config)
            .into_iter()
            .filter_map(|entry| entry.get("spec")?.as_str().map(str::to_string))
            .collect())
    }

    fn load_config(&self) -> Result<evot::api::Config> {
        evot::api::Config::load_with_env_file(Some(&self.env_file_path))
            .map_err(|e| Error::from_reason(format!("config reload failed: {e}")))
    }

    fn collect_models(&self, config: &evot::api::Config) -> Vec<serde_json::Value> {
        evot::api::model_catalog(
            config,
            &self.agent.llm(),
            &crate::cloud_model_meta(),
            &crate::cloud_provider_groups(),
        )
    }

    /// Switch the active provider by model spec.
    #[napi]
    pub fn set_provider(&self, provider: String) -> Result<()> {
        let config = self.load_config()?;
        self.agent
            .set_model_by_spec(&config, &provider)
            .map_err(|e| Error::from_reason(format!("invalid provider: {e}")))
    }

    /// Re-resolve the live model selection after login, logout, or key
    /// recovery. Returns false only when nothing is configured any more, i.e.
    /// the one case that needs `/login`.
    #[napi]
    pub fn reload_selection(&self) -> Result<bool> {
        let config = self.load_config()?;
        Ok(self.agent.reload_selection(&config).has_model())
    }

    /// Like `reload_selection`, but reports where the selection landed:
    /// `kept`, `followed` (same model id, new provider), `switched`
    /// (different model), or `unconfigured`. Lets the UI announce only real
    /// movement instead of diffing display state.
    #[napi]
    pub fn reload_selection_outcome(&self) -> Result<String> {
        let config = self.load_config()?;
        let outcome = match self.agent.reload_selection(&config) {
            SelectionReload::Kept => "kept",
            SelectionReload::Followed => "followed",
            SelectionReload::Switched => "switched",
            SelectionReload::Unconfigured => "unconfigured",
        };
        Ok(outcome.to_string())
    }

    /// Reload provider/model selection from disk for session resume. Unlike an
    /// interactive switch, this reapplies the current configured thinking level.
    /// Returns false when the saved selection is unavailable and the current
    /// live selection was refreshed instead.
    #[napi]
    pub fn reload_provider(&self, provider: String) -> Result<bool> {
        let config = self.load_config()?;
        self.agent
            .reload_provider_for_resume(&config, &provider)
            .map_err(|e| Error::from_reason(format!("invalid provider: {e}")))
    }

    /// Advance the thinking level to the next tier the current model supports,
    /// wrapping around, and persist it as the default for future sessions
    /// (pi-style double write: the session records its own level per run).
    /// Returns the new level's display label, or `null` when the model has no
    /// selectable reasoning levels.
    #[napi]
    pub fn cycle_thinking_level(&self) -> Option<String> {
        evot::api::cycle_thinking_level(&self.agent, &self.env_file_path)
    }

    /// Apply a named thinking level and persist it as the default, the same
    /// double write `cycle_thinking_level` performs. Unlike `cycle`, the caller
    /// names the tier, so the model picker can commit a model and its effort in
    /// one gesture. Returns the new display label, or `null` when the level is
    /// unknown or the active model does not offer it — the caller then leaves
    /// the live selection untouched rather than silently clamping.
    #[napi]
    pub fn set_thinking_level(&self, level: String) -> Option<String> {
        evot::api::set_thinking_level(&self.agent, &self.env_file_path, &level)
    }

    /// Make a cloud model the account's default for future sessions, on this
    /// and every other machine, without touching the live selection. Returns
    /// the pinned model id, or `null` when the model is BYOK / nobody is
    /// logged in (local config already remembers those). Errors when the
    /// server refuses the pin.
    #[napi]
    pub async fn pin_default_model(
        &self,
        provider: String,
        model: String,
    ) -> Result<Option<String>> {
        match evot::api::pin_default_model(&self.env_file_path, &provider, &model).await {
            Ok(evot::api::PinOutcome::Pinned(model)) => Ok(Some(model)),
            Ok(evot::api::PinOutcome::NotCloud) => Ok(None),
            Err(e) => Err(Error::from_reason(format!("pin default model: {e}"))),
        }
    }

    /// Apply a named thinking level when supported by the active model.
    /// Used on session resume so the session's recorded effort wins over the
    /// config default applied by `reload_provider`.
    #[napi]
    pub fn restore_thinking_level(&self, level: String) {
        self.agent.restore_thinking_level(&level);
    }

    /// Set execution limits (max turns, tokens, duration).
    #[napi]
    pub fn set_limits(
        &self,
        max_turns: Option<u32>,
        max_tokens: Option<f64>,
        max_duration_secs: Option<f64>,
    ) {
        let mut limits = self.agent.limits();
        if let Some(t) = max_turns {
            limits.max_turns = t;
        }
        if let Some(t) = max_tokens {
            limits.max_total_tokens = t as u64;
        }
        if let Some(d) = max_duration_secs {
            limits.max_duration_secs = d as u64;
        }
        self.agent.with_limits(limits);
    }

    /// Append extra text to the system prompt.
    #[napi]
    pub fn append_system_prompt(&self, extra: String) {
        self.agent.append_system_prompt(&extra);
    }

    #[napi]
    pub fn add_skills_dirs(&self, dirs: Vec<String>) {
        let paths: Vec<PathBuf> = dirs.into_iter().map(PathBuf::from).collect();
        self.agent.add_skills_dirs(paths);
    }

    #[napi]
    pub fn set_skill_names(&self, names: Vec<String>) -> Result<()> {
        self.agent
            .set_skill_names(names)
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// The fully-resolved, ordered skills directories the agent scans (managed
    /// builtins + global + config/env-file EVOT_SKILLS_DIRS + claude).
    /// The CLI reads this so `/skill list` and the banner match what the agent
    /// actually loads, instead of re-deriving from process.env alone.
    #[napi]
    pub fn skills_dirs(&self) -> Vec<String> {
        self.agent
            .skills_dirs()
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    }

    /// Start an abortable manual session compaction.
    #[napi]
    pub fn compact(
        &self,
        session_id: String,
        custom_instructions: Option<String>,
    ) -> NapiCompaction {
        NapiCompaction::start(self.agent.clone(), session_id, custom_instructions)
    }

    /// Start a disposable suggestion with the current model snapshot as the
    /// fallback when no dedicated service is published. Never touches the run.
    #[napi]
    pub fn suggest_next_prompt(
        &self,
        context_json: String,
    ) -> Result<crate::suggestion::NapiSuggestion> {
        let request = evot::suggestion::parse_request(&context_json).map_err(Error::from_reason)?;
        Ok(crate::suggestion::NapiSuggestion::start(
            request,
            self.agent.llm(),
        ))
    }

    /// Send a steering message into a running session.
    #[napi]
    pub fn steer(&self, session_id: String, text: String, content_json: Option<String>) {
        let input = if let Some(json) = content_json {
            if let Ok(blocks) = parse_content_blocks(&json) {
                if blocks.is_empty() {
                    vec![evot_engine::Content::Text { text }]
                } else {
                    blocks
                }
            } else {
                vec![evot_engine::Content::Text { text }]
            }
        } else {
            vec![evot_engine::Content::Text { text }]
        };
        self.agent.steer(&session_id, input);
    }

    /// Send a follow-up message to a running session.
    #[napi]
    pub fn follow_up(&self, session_id: String, text: String) {
        self.agent.follow_up(&session_id, &text);
    }

    /// Abort a running session.
    #[napi]
    pub fn abort_run(&self, session_id: String) {
        self.agent.abort_run(&session_id);
    }
}

fn process_summary_json(summary: &evot_engine::tools::ProcessSummary) -> serde_json::Value {
    serde_json::json!({
        "task_id": summary.task_id,
        "command": summary.command,
        "description": summary.description,
        "recent_output": summary.recent_output,
        "quiet_for_ms": summary.quiet_for.as_millis(),
        "cwd": summary.cwd,
        "output_path": summary.output_path,
        "status": summary.status.as_str(),
        "exit_code": summary.exit_code,
        "elapsed_ms": summary.elapsed.as_millis(),
        "output_file_truncated": summary.output_file_truncated,
        "stopped_by_user": summary.stopped_by_user,
    })
}

fn serialize_process_summary(summary: evot_engine::tools::ProcessSummary) -> Result<String> {
    serde_json::to_string(&process_summary_json(&summary))
        .map_err(|e| Error::from_reason(format!("serialize background process: {e}")))
}

fn serialize_process_summaries(
    summaries: Vec<evot_engine::tools::ProcessSummary>,
) -> Result<String> {
    let values = summaries
        .iter()
        .map(process_summary_json)
        .collect::<Vec<_>>();
    serde_json::to_string(&values)
        .map_err(|e| Error::from_reason(format!("serialize background processes: {e}")))
}
