use std::path::PathBuf;
use std::sync::Arc;

use super::tools::HostTools;
use super::tools::ToolApprover;
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
    /// Tools scoped to this run only, added by a prepared command (e.g.
    /// `/sessions` attaches `session_search`). Never part of ordinary turns.
    pub extra_tools: Vec<Arc<dyn evot_engine::AgentTool>>,
    /// When set, every tool call in this run waits for this approver.
    pub approver: Option<Arc<dyn ToolApprover>>,
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
            extra_tools: Vec::new(),
            approver: None,
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
            extra_tools: Vec::new(),
            approver: None,
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

    pub fn approver(mut self, approver: Arc<dyn ToolApprover>) -> Self {
        self.approver = Some(approver);
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
    pub storage: Arc<dyn crate::storage::Storage>,
    pub session: &'a crate::sessions::Session,
}

pub(super) async fn expand_prompt_command(
    mut request: QueryRequest,
    ctx: &PromptCommandContext<'_>,
) -> Result<QueryRequest> {
    use crate::command::clip_session_prompt;
    use crate::command::command_prompt;
    use crate::command::parse_command;
    use crate::command::Command;

    let input_text = request.input_text();
    let text = match parse_command(&input_text) {
        Some(Command::ClipSession) => {
            let memory = crate::agent::prompt::skill::load_skill(ctx.skills_dirs, "memory")
                .map_err(|error| EvotError::Agent(format!("cannot load memory skill: {error}")))?;
            let instructions = crate::agent::prompt::skill::load_skill_instructions(&memory)
                .map_err(|error| EvotError::Agent(format!("cannot read memory skill: {error}")))?;
            command_prompt("clip", &input_text, &clip_session_prompt(&instructions))
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
            request
                .extra_tools
                .push(Arc::new(crate::search::SessionSearchTool::new(
                    ctx.storage.clone(),
                    current_session_id,
                )));
            command_prompt(
                "sessions",
                &input_text,
                &session_search_prompt(&search.query, &instructions, chrono::Utc::now())?,
            )
        }
        _ => return Ok(request),
    };
    request.input = vec![evot_engine::Content::Text { text }];
    Ok(request)
}

/// The `/sessions` prompt: skill instructions plus the raw request and
/// today's date, so the model can turn "最近半个月" into a day count itself.
fn session_search_prompt(
    query: &str,
    instructions: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String> {
    // JSON separates arbitrary user text from workflow instructions.
    let query = serde_json::to_string(query)?;
    Ok(format!(
        "The `session-search` skill is already loaded and the `session_search` tool is \
         available for this request only. Follow the skill instructions below.\n\n\
         {instructions}\n\nCurrent UTC time: {}\n\nSearch request (JSON string): {query}",
        now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    ))
}
