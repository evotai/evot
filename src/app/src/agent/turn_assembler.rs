//! Per-turn preparation, independent of agent/session lifecycle supervision.
//!
//! Agent setters and admitted run factories share this component. Mutable
//! assembly settings remain live between turns; the selected LLM is supplied
//! separately as a per-run snapshot.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use super::processes::ProcessRegistry;
use super::prompt::bind_workspace_sections;
use super::prompt::dynamic_sections;
use super::prompt::load_turn_skills;
use super::prompt::prompt_mode;
use super::prompt::skills_prompt_section;
use super::prompt::DynamicContext;
use super::prompt::Section;
use super::run::engine::EngineOptions;
use super::run::policy::ExecutionBudget;
use super::run::runtime::TurnInput;
use super::sandbox::SandboxPolicy;
use super::tools::build_tools;
use super::tools::HostTools;
use super::tools::ToolMode;
use super::ExecutionLimits;
use super::Variables;
use crate::conf::Config;
use crate::conf::LlmConfig;
use crate::error::EvotError;
use crate::error::Result;
use crate::sessions::Session;

pub struct TurnBuildRequest {
    pub input: Vec<evot_engine::Content>,
    pub host_tools: Option<HostTools>,
    /// Dump/inspection callers must not drain pending process results.
    pub consume_process_notifications: bool,
}

pub struct TurnAssembler {
    pub(super) system_prompt_sections: RwLock<Vec<Section>>,
    pub(super) limits: RwLock<ExecutionLimits>,
    pub(super) skills_dirs: RwLock<Vec<PathBuf>>,
    pub(super) skill_names: RwLock<Option<Vec<String>>>,
    pub(super) spill_root: Option<PathBuf>,
    pub(super) variables: RwLock<Option<Arc<Variables>>>,
    pub(super) sandbox: SandboxPolicy,
    pub(super) provider_override: RwLock<Option<Arc<dyn evot_engine::provider::StreamProvider>>>,
    pub(super) processes: ProcessRegistry,
    /// Prune verdicts per session, kept across runs so the judge is not asked
    /// the same questions every prompt. Judge-decided only; lost on restart,
    /// which merely costs one re-ask.
    pub(super) prune_ledgers: RwLock<
        HashMap<String, Arc<tokio::sync::Mutex<evot_engine::context::compaction::PruneLedger>>>,
    >,
}

impl TurnAssembler {
    pub fn new(config: &Config) -> Self {
        Self {
            system_prompt_sections: RwLock::new(Vec::new()),
            limits: RwLock::new(ExecutionLimits::default()),
            skills_dirs: RwLock::new(Vec::new()),
            skill_names: RwLock::new(None),
            spill_root: match config.storage.backend {
                crate::conf::StorageBackend::Fs => Some(config.storage.fs.root_dir.clone()),
                _ => None,
            },
            variables: RwLock::new(None),
            sandbox: SandboxPolicy::from_config(&config.sandbox),
            provider_override: RwLock::new(None),
            processes: ProcessRegistry::new(),
            prune_ledgers: RwLock::new(HashMap::new()),
        }
    }

    /// Root of the on-disk session archive, when storage is on disk.
    pub(super) fn sessions_dir(&self) -> Option<PathBuf> {
        self.spill_root.as_ref().map(|root| root.join("sessions"))
    }

    /// Forks inherit limits and sandbox policy, but not skills, variables,
    /// provider overrides, spill storage, or session process managers.
    pub(super) fn fork(&self) -> Self {
        Self {
            system_prompt_sections: RwLock::new(Vec::new()),
            limits: RwLock::new(self.limits.read().clone()),
            skills_dirs: RwLock::new(Vec::new()),
            skill_names: RwLock::new(None),
            spill_root: None,
            variables: RwLock::new(None),
            sandbox: SandboxPolicy {
                enabled: self.sandbox.enabled,
                extra_dirs: self.sandbox.extra_dirs.clone(),
            },
            provider_override: RwLock::new(None),
            processes: ProcessRegistry::new(),
            prune_ledgers: RwLock::new(HashMap::new()),
        }
    }

    fn build_system_prompt(&self, mode: ToolMode, cwd: &str) -> (String, Vec<Section>) {
        let mut sections = self.system_prompt_sections.read().clone();
        bind_workspace_sections(&mut sections, cwd);
        let ctx = DynamicContext {
            mode: prompt_mode(mode),
            sandbox: self.sandbox.enabled,
            variables: self
                .variables
                .read()
                .as_ref()
                .map(|v| v.variable_names())
                .unwrap_or_default(),
        };
        sections.extend(dynamic_sections(&ctx));
        let text = sections
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        (text, sections)
    }

    pub async fn build_turn(
        &self,
        llm: &LlmConfig,
        mode: ToolMode,
        session: Arc<Session>,
        session_id: &str,
        request: TurnBuildRequest,
    ) -> Result<TurnInput> {
        let TurnBuildRequest {
            mut input,
            host_tools,
            consume_process_notifications,
        } = request;
        let llm = llm.clone();
        if llm.provider.is_empty() {
            return Err(EvotError::Conf(
                "No model available yet. Log in via the dashboard sidebar, run `evot login` here, or add a provider on the Models page."
                    .to_string(),
            ));
        }
        if llm.api_key.trim().is_empty() {
            return Err(EvotError::Conf(format!(
                "No API key set for provider '{}'. Add it in the dashboard settings \
                 or set EVOT_LLM_{}_API_KEY in your env file.",
                llm.provider,
                llm.provider.to_uppercase().replace('-', "_"),
            )));
        }
        let variables = self.variables.read().clone();
        let envs = variables.map(|v| v.all_env_pairs()).unwrap_or_default();
        // System dirs cover skill scan directories and the builtin memory vault.
        let cwd = session.meta().await.cwd;
        let cwd_path = std::path::Path::new(&cwd);
        let skill_dirs = self.skills_dirs.read().clone();
        let selected_skill_names = self.skill_names.read().clone();
        let skills = load_turn_skills(&skill_dirs, selected_skill_names.as_deref())?;
        let mut system_dirs = skill_dirs.clone();
        if let Ok(memory_dir) = crate::conf::paths::memory_dir() {
            if let Err(e) = std::fs::create_dir_all(&memory_dir) {
                tracing::warn!("cannot create memory dir {}: {e}", memory_dir.display());
            }
            system_dirs.push(memory_dir);
        }
        for skill in &skills {
            system_dirs.push(skill.base_dir.clone());
        }
        let session_dir = self
            .sessions_dir()
            .map(|sessions| sessions.join(session_id));
        let spill_dir = session_dir.as_ref().map(|dir| dir.join("tool-results"));
        if let Some(spill_dir) = &spill_dir {
            std::fs::create_dir_all(spill_dir)?;
            system_dirs.push(spill_dir.clone());
        }
        let sandbox_rt = self.sandbox.build_runtime(cwd_path, &system_dirs)?;
        let policy = mode.policy();
        let process_manager = if policy.background_processes {
            Some(self.processes.acquire(session_id)?)
        } else {
            None
        };
        let tools = build_tools(
            policy,
            envs,
            sandbox_rt.allow_bash,
            sandbox_rt.bash_sandbox_dirs,
            process_manager.clone(),
            host_tools,
        );
        let (mut system_prompt, mut sections) = self.build_system_prompt(mode, &cwd);
        if let Some(section) = skills_prompt_section(&skills) {
            let insert_at = sections
                .iter()
                .position(|section| matches!(section.name, "environment" | "dynamic_boundary"))
                .unwrap_or(sections.len());
            sections.insert(insert_at, section);
            system_prompt = sections
                .iter()
                .map(|section| section.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
        }
        let (prior_messages, compaction_state, transcript_seq) = session.context_snapshot().await;
        // Replay normalization belongs at the engine LLM boundary, not here.
        if consume_process_notifications {
            if let Some(process_manager) = &process_manager {
                input.extend(
                    process_manager
                        .take_notifications()
                        .into_iter()
                        .map(|text| evot_engine::Content::Text { text }),
                );
            }
        }
        input.retain(|content| match content {
            evot_engine::Content::Text { text } => !text.trim().is_empty(),
            _ => true,
        });
        Ok(TurnInput {
            options: EngineOptions {
                provider: llm.provider,
                protocol: llm.protocol,
                model: llm.model,
                api_key: llm.api_key,
                model_config: llm.model_config,
                system_prompt,
                system_prompt_sections: sections,
                limits: if policy.budget == ExecutionBudget::Unbounded {
                    None
                } else {
                    Some(self.limits.read().clone())
                },
                tools,
                thinking_level: llm.thinking_level,
                cwd: cwd_path.to_path_buf(),
                path_guard: sandbox_rt.path_guard,
                spill_dir,
                process_manager,
                prompt_cache_key: Some(session_id.to_string()),
                provider_override: self.provider_override.read().clone(),
                compaction_state,
                // Re-resolved every run: the catalog decides whether pruning
                // is on, and it can change while a session is open.
                judge: crate::judge::current_for_session(session_dir.as_deref(), Some(session_id)),
                prune_ledger: self
                    .prune_ledgers
                    .write()
                    .entry(session_id.to_string())
                    .or_default()
                    .clone(),
            },
            history: prior_messages,
            input,
            session,
            transcript_seq,
        })
    }
}
