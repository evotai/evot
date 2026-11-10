use std::sync::Arc;

use crate::agent::prompt::SystemPrompt;
use crate::agent::Agent;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;

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

    // The agent already scans its builtin skills; add the user's global dir,
    // the configured dirs, and Claude Code's skills when that dir exists.
    let mut skills_dirs = vec![crate::base::paths::skills_dir()?];
    skills_dirs.extend(conf.skills_dirs.clone());
    let claude = crate::base::paths::claude_skills_dir()?;
    if claude.is_dir() {
        skills_dirs.push(claude);
    }

    let agent = if ephemeral {
        Agent::new_ephemeral(conf, &cwd)?
    } else {
        Agent::new(conf, &cwd)?
    };
    let agent = agent
        .with_system_prompt_sections(system_prompt_text, system_prompt_sections)
        .add_skills_dirs(skills_dirs);
    tracing::info!(skills_dirs = ?agent.skills_dirs(), "agent skills directories");

    // Preserve the existing startup fallback; changing persistence error policy
    // is separate from moving the composition root.
    let storage = agent.storage();
    let records = storage.load_variables().await.unwrap_or_default();
    let variables = Arc::new(crate::agent::Variables::new(storage, records));
    agent.with_variables(variables);

    Ok(agent)
}
