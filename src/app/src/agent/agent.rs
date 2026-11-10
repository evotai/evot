use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use super::request::ExecutionLimits;
use super::run::registry::RunRegistry;
use super::turn_assembler::TurnAssembler;
use super::variables::Variables;
use crate::agent::models::ModelSelection;
use crate::agent::prompt::Section;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::LlmConfig;
use crate::session::storage::open_storage;
use crate::session::storage::MemoryStorage;
use crate::session::storage::Storage;
use crate::session::SessionGates;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

pub struct Agent {
    pub(super) selection: ModelSelection,
    pub(super) system_prompt: RwLock<String>,
    pub(super) assembler: Arc<TurnAssembler>,
    pub(super) cwd: String,
    pub(super) storage: Arc<dyn Storage>,
    /// session_id → (run_id, handle, done_flag)
    pub(super) active_runs: Arc<RunRegistry>,
    /// Fixed sharded gates linearize start/clear/delete per session without
    /// retaining one lock per historical session.
    pub(super) session_lifecycle_gates: SessionGates,
}

impl Agent {
    pub fn new(config: &Config, cwd: impl Into<String>) -> Result<Arc<Self>> {
        let cwd = cwd.into();
        let storage = open_storage(&config.storage)?;
        Ok(Arc::new(Self::new_inner(config, cwd, storage)?))
    }

    /// Agent whose sessions live only in memory: no session archive, no
    /// spilled tool results, nothing left on disk after the process exits.
    pub fn new_ephemeral(config: &Config, cwd: impl Into<String>) -> Result<Arc<Self>> {
        let mut agent = Self::new_inner(config, cwd.into(), Arc::new(MemoryStorage::new()))?;
        let mut assembler = TurnAssembler::new(config);
        assembler.spill_root = None;
        agent.assembler = Arc::new(assembler);
        Ok(Arc::new(agent))
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
        crate::privacy::remember_secrets(variables.secret_values());
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

    pub fn variables(&self) -> Option<Arc<Variables>> {
        self.assembler.variables.read().clone()
    }

    pub fn storage(&self) -> Arc<dyn Storage> {
        self.storage.clone()
    }
}
