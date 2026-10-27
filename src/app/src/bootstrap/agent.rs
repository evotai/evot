use std::sync::Arc;

use crate::agent::prompt::SystemPrompt;
use crate::agent::Agent;
use crate::conf::Config;
use crate::error::EvotError;
use crate::error::Result;

/// Construct the application shared by native and gateway entry points.
/// Channel startup and presentation belong to the caller, not this bootstrap.
pub async fn build_agent(conf: &Config) -> Result<Arc<Agent>> {
    build(conf, false).await
}

/// [`build_agent`] whose sessions live in memory only: nothing is written to
/// the session archive.
pub async fn build_ephemeral_agent(conf: &Config) -> Result<Arc<Agent>> {
    build(conf, true).await
}

async fn build(conf: &Config, ephemeral: bool) -> Result<Arc<Agent>> {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| EvotError::Run(format!("failed to get cwd: {e}")))?;

    let tools = crate::agent::tools::prompt_tools();
    let model = conf.active_llm().map(|l| l.model).unwrap_or_default();
    let (system_prompt_text, system_prompt_sections) = SystemPrompt::base(&cwd, &tools, &model);

    let mut skills_dirs = Vec::new();
    let builtin = crate::agent::prompt::skill::ensure_builtin_skills_dir()
        .map_err(|error| EvotError::Agent(format!("cannot initialize builtin skills: {error}")))?;
    skills_dirs.push(builtin);
    let global = crate::conf::paths::skills_dir()?;
    skills_dirs.push(global);
    skills_dirs.extend(conf.skills_dirs.clone());

    tracing::info!(skills_dirs = ?skills_dirs, "agent skills directories");

    let agent = if ephemeral {
        Agent::new_ephemeral(conf, &cwd)?
    } else {
        Agent::new(conf, &cwd)?
    };
    let agent = agent
        .with_system_prompt_sections(system_prompt_text, system_prompt_sections)
        .with_skills_dirs(skills_dirs);

    // Preserve the existing startup fallback; changing persistence error policy
    // is separate from moving the composition root.
    let storage = agent.storage();
    let records = storage.load_variables().await.unwrap_or_default();
    let variables = Arc::new(crate::agent::Variables::new(storage, records));
    agent.with_variables(variables);

    Ok(agent)
}
