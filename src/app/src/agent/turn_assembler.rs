//! Per-turn preparation, independent of agent/session lifecycle supervision.
//!
//! Agent setters and admitted run factories share this component. Mutable
//! assembly settings remain live between turns; the selected LLM is supplied
//! separately as a per-run snapshot.

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
use super::prompt::SystemPrompt;
use super::run::engine::EngineOptions;
use super::run::policy::ExecutionBudget;
use super::run::policy::ToolAccess;
use super::run::runtime::TurnInput;
use super::sandbox::SandboxPolicy;
use super::tools::build_tools;
use super::tools::HostTools;
use super::tools::ToolMode;
use super::ExecutionLimits;
use super::Variables;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::LlmConfig;
use crate::session::Session;

pub struct TurnBuildRequest {
    pub input: Vec<evot_engine::Content>,
    pub host_tools: Option<HostTools>,
    /// Run-scoped tools from a prepared command, appended after the mode's set.
    pub extra_tools: Vec<Arc<dyn evot_engine::AgentTool>>,
    /// Gate for every tool call of the turn, applied after the set is final.
    pub approver: Option<Arc<dyn super::tools::ToolApprover>>,
    /// Dump/inspection callers must not drain pending process results.
    pub consume_process_notifications: bool,
    /// Selection replaced by the latest model switch, if any.
    pub previous_llm: Option<LlmConfig>,
    /// Existing run-local directory for temporary files, outside the project.
    pub scratch_dir: Option<PathBuf>,
}

pub struct TurnAssembler {
    pub(super) system_prompt_sections: RwLock<Vec<Section>>,
    pub(super) limits: RwLock<ExecutionLimits>,
    pub(super) skills_dirs: RwLock<Vec<PathBuf>>,
    pub(super) skill_names: RwLock<Option<Vec<String>>>,
    /// Memory vault the builtin `memory` skill reads and writes
    /// (`<state root>/memory`). Resolved from the config, never from `HOME`.
    pub(super) memory_dir: PathBuf,
    pub(super) spill_root: Option<PathBuf>,
    pub(super) variables: RwLock<Option<Arc<Variables>>>,
    pub(super) sandbox: SandboxPolicy,
    pub(super) provider_override: RwLock<Option<Arc<dyn evot_engine::provider::StreamProvider>>>,
    pub(super) processes: ProcessRegistry,
}

impl TurnAssembler {
    /// Builtin skills are written under the config's storage root and seed the
    /// skills directories, so every agent — including ephemeral and test
    /// agents — loads them without consulting `HOME`.
    pub fn new(config: &Config) -> Result<Self> {
        let builtin = super::prompt::skill::ensure_builtin_skills_dir(&config.storage.fs.root_dir)
            .map_err(|error| {
                EvotError::Agent(format!("cannot initialize builtin skills: {error}"))
            })?;
        Ok(Self {
            system_prompt_sections: RwLock::new(Vec::new()),
            limits: RwLock::new(ExecutionLimits::default()),
            skills_dirs: RwLock::new(vec![builtin]),
            skill_names: RwLock::new(None),
            memory_dir: config.storage.fs.root_dir.join("memory"),
            spill_root: Some(config.storage.fs.root_dir.clone()),
            variables: RwLock::new(None),
            sandbox: SandboxPolicy::from_config(&config.sandbox),
            provider_override: RwLock::new(None),
            processes: ProcessRegistry::new(),
        })
    }

    /// Root of the on-disk session archive, when storage is on disk.
    pub(super) fn sessions_dir(&self) -> Option<PathBuf> {
        self.spill_root.as_ref().map(|root| root.join("sessions"))
    }

    /// Forks inherit limits and sandbox policy, but not skills, variables,
    /// provider overrides, spill storage, or session process managers. Their
    /// system prompt is the given `sections`, not the parent's.
    pub(super) fn fork(&self, sections: Vec<Section>) -> Self {
        Self {
            system_prompt_sections: RwLock::new(sections),
            limits: RwLock::new(self.limits.read().clone()),
            skills_dirs: RwLock::new(Vec::new()),
            skill_names: RwLock::new(None),
            memory_dir: self.memory_dir.clone(),
            spill_root: None,
            variables: RwLock::new(None),
            sandbox: SandboxPolicy {
                enabled: self.sandbox.enabled,
                extra_dirs: self.sandbox.extra_dirs.clone(),
            },
            provider_override: RwLock::new(None),
            processes: ProcessRegistry::new(),
        }
    }

    fn build_system_prompt_sections(&self, mode: ToolMode, cwd: &str) -> Vec<Section> {
        let mut sections = if mode == ToolMode::Chat {
            // The coding identity, tool guidance, and workspace instructions
            // all describe a toolset a tool-free turn does not have.
            SystemPrompt::chat(cwd).1
        } else {
            let mut sections = self.system_prompt_sections.read().clone();
            bind_workspace_sections(&mut sections, cwd);
            sections
        };
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
        sections
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
            input,
            host_tools,
            extra_tools,
            approver,
            consume_process_notifications,
            previous_llm,
            scratch_dir,
        } = request;
        let mut input = crate::session::conversation::input::PreparedInput::user(input);
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
        let mut envs = variables.map(|v| v.all_env_pairs()).unwrap_or_default();
        // Values the shell is given show up in tool output with no context a
        // rule could see; the provider key may be echoed by a misbehaving tool.
        crate::privacy::remember_secrets(
            envs.iter()
                .map(|(_, value)| value.as_str())
                .chain([llm.api_key.as_str()]),
        );
        // System dirs cover skill scan directories and the builtin memory vault.
        let cwd = session.meta().await.cwd;
        let cwd_path = std::path::Path::new(&cwd);
        let skill_dirs = self.skills_dirs.read().clone();
        let selected_skill_names = self.skill_names.read().clone();
        let policy = mode.policy();
        // Skills and run-scoped tools only matter when the model can call tools.
        let tool_free = policy.tools == ToolAccess::None;
        let skills = if tool_free {
            Vec::new()
        } else {
            load_turn_skills(&skill_dirs, selected_skill_names.as_deref())?
        };
        let mut system_dirs = skill_dirs.clone();
        if let Err(e) = std::fs::create_dir_all(&self.memory_dir) {
            tracing::warn!(
                "cannot create memory dir {}: {e}",
                self.memory_dir.display()
            );
        }
        system_dirs.push(self.memory_dir.clone());
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
        if let Some(scratch) = &scratch_dir {
            system_dirs.push(scratch.clone());
            // Apply after remembering secrets: a managed directory is not a
            // credential. Run-local temp settings override inherited variables.
            const SCRATCH_ENVS: [&str; 4] = ["EVOT_SCRATCH_DIR", "TMPDIR", "TMP", "TEMP"];
            envs.retain(|(key, _)| !SCRATCH_ENVS.contains(&key.as_str()));
            for key in SCRATCH_ENVS {
                envs.push((key.into(), scratch.to_string_lossy().into_owned()));
            }
        }
        let sandbox_rt = self.sandbox.build_runtime(cwd_path, &system_dirs)?;
        let process_manager = if policy.background_processes {
            Some(self.processes.acquire(session_id)?)
        } else {
            None
        };
        // Compute machines are reached with ssh through bash.
        let compute_section = if !tool_free && sandbox_rt.allow_bash {
            enabled_compute_machines()
                .await
                .and_then(|machines| crate::cloud::compute::prompt::prompt_section(&machines))
        } else {
            None
        };
        let mut tools = build_tools(
            policy,
            envs,
            sandbox_rt.allow_bash,
            sandbox_rt.bash_sandbox_dirs,
            process_manager.clone(),
            host_tools,
        );
        if !tool_free {
            tools.extend(extra_tools.into_iter().map(super::tools::shared_tool));
        }
        // An embedding client may insist on approving each call before it runs.
        if let Some(approver) = &approver {
            tools = super::tools::require_approval(tools, approver);
        }
        let mut sections = self.build_system_prompt_sections(mode, &cwd);
        if let Some(scratch) = &scratch_dir {
            sections.push(Section {
                name: "scratch",
                text: format!(
                    "Run scratch directory: {}\n\n\
                     Put all temporary scripts, downloads, intermediate data, and debug logs in this directory, never in the project workspace. \
                     Use absolute scratch paths with read/write/edit tools. Before shell commands that generate temporary files, cd to \"$EVOT_SCRATCH_DIR\" or use explicit scratch paths. \
                     EVOT_SCRATCH_DIR, TMPDIR, TMP, and TEMP are set to this directory for shell subprocesses. \
                     Some utilities ignore temp environment variables; for mktemp, always pass an explicit template such as \"$EVOT_SCRATCH_DIR/evot.XXXXXX\". \
                     The current working directory remains the workspace for project reads and intentional project changes; do not move source edits or requested final project artifacts into scratch.",
                    scratch.display(),
                ),
            });
        }
        if let Some(section) = skills_prompt_section(&skills) {
            let insert_at = sections
                .iter()
                .position(|section| matches!(section.name, "environment" | "dynamic_boundary"))
                .unwrap_or(sections.len());
            sections.insert(insert_at, section);
        }
        if let Some(text) = compute_section {
            sections.push(Section {
                name: "compute",
                text,
            });
        }
        let system_prompt = sections
            .iter()
            .map(|section| section.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let (prior_messages, compaction_state, transcript_seq) = session.context_snapshot().await;
        let compaction_llm = previous_llm.filter(|previous| {
            previous.model != llm.model
                && last_assistant_model(&prior_messages) == Some(previous.model.as_str())
        });
        // Replay normalization belongs at the engine LLM boundary, not here.
        if consume_process_notifications {
            if let Some(process_manager) = &process_manager {
                // Tasks the transcript announced but this process never ran
                // died with an earlier evot; say so once before the model
                // treats them as live watchers. Checked before the drain so
                // a task that finished in this process is never mistaken
                // for one.
                let orphans =
                    super::orphaned_tasks::orphaned_tasks(&prior_messages, process_manager);
                if let Some(notice) = super::orphaned_tasks::orphan_notice(&orphans) {
                    if self.processes.mark_orphans_announced(session_id) {
                        input.runtime(
                            notice,
                            "previous_process_tasks",
                            Some("Previous-process background tasks are no longer running".into()),
                        );
                    }
                }
                for notification in process_manager.take_notifications() {
                    input.runtime(notification, "background_task", None);
                }
            }
        }
        let (input, provenance) = input.finish();
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
                compaction_llm,
                compaction_state,
            },
            history: prior_messages,
            input,
            provenance,
            session,
            transcript_seq,
        })
    }
}

/// Model that produced the most recent assistant message in the history.
fn last_assistant_model(messages: &[evot_engine::AgentMessage]) -> Option<&str> {
    messages.iter().rev().find_map(|message| match message {
        evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant { model, .. }) => {
            Some(model.as_str())
        }
        _ => None,
    })
}

/// Enabled Compute machines, or `None` when there are none or the store
/// cannot be read (a broken file must not break the turn).
async fn enabled_compute_machines() -> Option<Vec<crate::cloud::compute::ComputeMachine>> {
    let service = crate::cloud::compute::ComputeService::default_location().ok()?;
    let machines: Vec<_> = match service.list().await {
        Ok(machines) => machines.into_iter().filter(|m| m.enabled).collect(),
        Err(error) => {
            tracing::warn!(%error, "compute machines unavailable this turn");
            return None;
        }
    };
    (!machines.is_empty()).then_some(machines)
}
