use std::path::PathBuf;
use std::sync::Arc;

use evot::api::Agent;
use evot::api::ForkRequest;
use evot::api::HostTools;
use evot::api::ModelSelection;
use evot::api::QueryRequest;
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
    pub(crate) env_file_path: String,
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
            judge: None,
            default_model: config.cloud_default_model.clone(),
            session_hook: config.session_hook.clone(),
        };
        serde_json::to_string(&info).map_err(|e| Error::from_reason(format!("serialize: {e}")))
    }

    pub(crate) fn load_config(&self) -> Result<evot::api::Config> {
        evot::api::Config::load_with_env_file(Some(&self.env_file_path))
            .map_err(|e| Error::from_reason(format!("config reload failed: {e}")))
    }

    pub(crate) fn collect_models(&self, config: &evot::api::Config) -> Vec<serde_json::Value> {
        evot::api::model_catalog(
            config,
            &self.agent.llm(),
            &crate::cloud_model_meta(),
            &crate::cloud_provider_groups(),
        )
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
