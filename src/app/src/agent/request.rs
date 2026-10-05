use std::path::PathBuf;

use super::tools::HostTools;
use super::tools::ToolMode;
use super::Run;
use crate::conf::LlmConfig;
use crate::error::EvotError;
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct ExecutionLimits {
    pub max_turns: u32,
    pub max_total_tokens: u64,
    pub max_duration_secs: u64,
}

impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            max_turns: 512,
            max_total_tokens: 100_000_000,
            max_duration_secs: 3600,
        }
    }
}

pub struct QueryRequest {
    pub input: Vec<evot_engine::Content>,
    pub session_id: Option<String>,
    pub mode: ToolMode,
    pub source: String,
    pub llm: Option<LlmConfig>,
    pub host_tools: Option<HostTools>,
    pub cwd: Option<String>,
}

impl QueryRequest {
    pub fn text(prompt: impl Into<String>) -> Self {
        Self {
            input: vec![evot_engine::Content::Text {
                text: prompt.into(),
            }],
            session_id: None,
            mode: ToolMode::Headless,
            source: String::new(),
            llm: None,
            host_tools: None,
            cwd: None,
        }
    }

    pub fn with_input(input: Vec<evot_engine::Content>) -> Self {
        Self {
            input,
            session_id: None,
            mode: ToolMode::Headless,
            source: String::new(),
            llm: None,
            host_tools: None,
            cwd: None,
        }
    }

    pub fn input_text(&self) -> String {
        crate::conversation::convert::extract_content_text(&self.input)
    }

    pub fn session_id(mut self, id: Option<String>) -> Self {
        self.session_id = id;
        self
    }

    pub fn mode(mut self, mode: ToolMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn llm(mut self, llm: LlmConfig) -> Self {
        self.llm = Some(llm);
        self
    }

    pub fn host_tools(mut self, host_tools: Option<HostTools>) -> Self {
        self.host_tools = host_tools;
        self
    }

    pub fn source(mut self, source: impl Into<String>) -> Self {
        self.source = source.into();
        self
    }

    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

pub enum SubmitOutcome {
    Run(Run),
    Command(String),
}

/// Commands that run as an ordinary agent turn with a prepared prompt.
pub(super) struct PromptCommandContext<'a> {
    pub skills_dirs: &'a [PathBuf],
    pub storage: &'a dyn crate::storage::Storage,
    pub session: &'a crate::sessions::Session,
    pub llm: &'a LlmConfig,
}

pub(super) async fn expand_prompt_command(
    mut request: QueryRequest,
    ctx: &PromptCommandContext<'_>,
) -> Result<QueryRequest> {
    use crate::command::clip_session_prompt;
    use crate::command::parse_command;
    use crate::command::Command;

    let text = match parse_command(&request.input_text()) {
        Some(Command::ClipSession) => {
            let memory = crate::agent::prompt::skill::load_skill(ctx.skills_dirs, "memory")
                .map_err(|error| EvotError::Agent(format!("cannot load memory skill: {error}")))?;
            let instructions = crate::agent::prompt::skill::load_skill_instructions(&memory)
                .map_err(|error| EvotError::Agent(format!("cannot read memory skill: {error}")))?;
            clip_session_prompt(&instructions)
        }
        Some(Command::SessionSearch(search)) => {
            let skill = crate::agent::prompt::skill::load_skill(ctx.skills_dirs, "session-search")
                .map_err(|error| {
                    EvotError::Agent(format!("cannot load session-search skill: {error}"))
                })?;
            let instructions = crate::agent::prompt::skill::load_skill_instructions(&skill)
                .map_err(|error| {
                    EvotError::Agent(format!("cannot read session-search skill: {error}"))
                })?;
            let current_session_id = ctx.session.session_id().await;
            let (history, _, _) = ctx.session.context_snapshot().await;
            let history_tokens = evot_engine::context::total_tokens(&history)
                .max(ctx.session.meta().await.context_tokens);
            let window = ctx.llm.model_config.context_window() as usize;
            // Reserve output and system/tools/skill overhead; search evidence
            // must not dominate the model window even in an empty conversation.
            let budget = window
                .saturating_sub(history_tokens)
                .saturating_sub((ctx.llm.model_config.max_tokens() as usize).min(8_192))
                .saturating_sub(8_192)
                .min(window / 2);
            let candidates = crate::search::SessionCandidates::collect(
                ctx.storage,
                &search,
                chrono::Utc::now(),
                &current_session_id,
                budget,
            )
            .await?;
            candidates.prompt(&search.query, &instructions)?
        }
        _ => return Ok(request),
    };
    request.input = vec![evot_engine::Content::Text { text }];
    Ok(request)
}
