use crate::agent::ToolMode;
use crate::error::EvotError;
use crate::error::Result;

/// Process-wide ACP server settings. Fixed at startup so a client cannot
/// widen them per request.
#[derive(Clone, Debug)]
pub struct AcpOptions {
    /// Tools sessions may give the model; see [`tool_mode`].
    pub mode: ToolMode,
    /// Send `session/request_permission` before every tool call; only an
    /// explicit allow runs it.
    pub ask_permission: bool,
    /// Keep sessions in memory only; `session/resume` then works only within
    /// this process.
    pub ephemeral: bool,
    /// Version reported in `initialize.agentInfo`.
    pub agent_version: String,
}

impl AcpOptions {
    /// Whether tool calls in this server's sessions wait for the client.
    pub(super) fn asks_permission(&self) -> bool {
        self.ask_permission && self.mode != ToolMode::Chat
    }
}

/// `--tools` value → tool mode: `full` (the REPL's coding toolset),
/// `readonly` (read and search only), or `none` (the model can only answer).
pub fn tool_mode(value: &str) -> Result<ToolMode> {
    match value {
        "full" => Ok(ToolMode::Interactive),
        "readonly" => Ok(ToolMode::Readonly),
        "none" => Ok(ToolMode::Chat),
        other => Err(EvotError::Conf(format!(
            "invalid ACP tool policy '{other}' (expected full, readonly, or none)"
        ))),
    }
}

/// `--permission` value → whether the client approves each tool call:
/// `ask` or `allow`.
pub fn ask_permission(value: &str) -> Result<bool> {
    match value {
        "ask" => Ok(true),
        "allow" => Ok(false),
        other => Err(EvotError::Conf(format!(
            "invalid ACP permission policy '{other}' (expected ask or allow)"
        ))),
    }
}
