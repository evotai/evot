use std::path::PathBuf;
use std::sync::Arc;

use super::message::AgentMessage;
use super::tool::AgentTool;
use crate::types::PathGuard;

// ---------------------------------------------------------------------------
// Agent context (passed to the loop)
// ---------------------------------------------------------------------------

pub struct AgentContext {
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<Box<dyn AgentTool>>,
    pub cwd: PathBuf,
    pub path_guard: Arc<PathGuard>,
    pub prompt_cache_key: Option<String>,
}
