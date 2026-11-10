use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde::Serialize;
use serde_json::json;

use super::message::Content;
use super::message::Retention;
use super::path_guard::PathGuard;

/// Per-tool parameter alias mapping: canonical name → accepted alternatives.
pub type AliasMap = &'static [(&'static str, &'static [&'static str])];

/// Tool definition sent to the LLM (schema only, no execute fn)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/// Callback for streaming partial results during tool execution.
///
/// Tools call this to emit progress updates (e.g., partial output, status messages)
/// that are forwarded as `AgentEvent::ToolExecutionUpdate` events for UI consumption.
/// Partial results are **not** sent to the LLM — only the final `ToolResult` is.
pub type ToolUpdateFn = Arc<dyn Fn(ToolResult) + Send + Sync>;

/// Callback for emitting user-facing progress messages during tool execution.
///
/// Each invocation emits an `AgentEvent::ProgressMessage` event. Unlike `ToolUpdateFn`,
/// these are simple text messages intended for user-facing display (e.g., status lines,
/// notifications), not structured tool results.
pub type ProgressFn = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpillProgress {
    pub kind: String,
    pub path: String,
    pub size_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl SpillProgress {
    pub fn write(path: impl Into<String>, size_bytes: usize, preview_bytes: usize) -> Self {
        Self {
            kind: "write".to_string(),
            path: path.into(),
            size_bytes,
            preview_bytes: Some(preview_bytes),
            duration_ms: None,
        }
    }

    pub fn read(path: impl Into<String>, size_bytes: usize, duration_ms: u64) -> Self {
        Self {
            kind: "read".to_string(),
            path: path.into(),
            size_bytes,
            preview_bytes: None,
            duration_ms: Some(duration_ms),
        }
    }

    pub fn to_progress_text(&self) -> String {
        format!("__evot_spill_event__ {}", json!(self))
    }
}

/// Context passed to tool execution. Bundles all per-invocation state.
///
/// Using a struct instead of individual parameters future-proofs the trait —
/// adding fields to `ToolContext` is non-breaking.
pub struct ToolContext {
    /// The ID of this tool call (for correlation).
    pub tool_call_id: String,
    /// The name of the tool being invoked.
    pub tool_name: String,
    /// Cancellation token — check `is_cancelled()` in long-running tools.
    pub cancel: tokio_util::sync::CancellationToken,
    /// Optional callback for streaming partial `ToolResult`s (UI/logging only).
    pub on_update: Option<ToolUpdateFn>,
    /// Optional callback for emitting user-facing progress messages.
    pub on_progress: Option<ProgressFn>,
    /// Working directory for path resolution.
    pub cwd: PathBuf,
    /// Path access guard — restricts file tools to allowed directories.
    pub path_guard: Arc<PathGuard>,
    /// Optional spill storage. Used by file tools to mark reads from spilled tool output.
    pub spill: Option<Arc<crate::spill::FsSpill>>,
    /// Whether the active model accepts image input. File tools consult this to
    /// annotate image reads that the model cannot see, mirroring pi's
    /// `getNonVisionImageNote`. Defaults to `true` (vision-capable).
    pub supports_image: bool,
}

impl Clone for ToolContext {
    fn clone(&self) -> Self {
        Self {
            tool_call_id: self.tool_call_id.clone(),
            tool_name: self.tool_name.clone(),
            cancel: self.cancel.clone(),
            on_update: self.on_update.clone(),
            on_progress: self.on_progress.clone(),
            cwd: self.cwd.clone(),
            path_guard: self.path_guard.clone(),
            spill: self.spill.clone(),
            supports_image: self.supports_image,
        }
    }
}

impl std::fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContext")
            .field("tool_call_id", &self.tool_call_id)
            .field("tool_name", &self.tool_name)
            .field("cancel", &self.cancel)
            .field("on_update", &self.on_update.as_ref().map(|_| "<callback>"))
            .field(
                "on_progress",
                &self.on_progress.as_ref().map(|_| "<callback>"),
            )
            .field("cwd", &self.cwd)
            .field("path_guard", &self.path_guard)
            .field("spill", &self.spill.as_ref().map(|_| "<spill>"))
            .finish()
    }
}

/// A tool the agent can call. Implement this trait for your tools.
#[async_trait::async_trait]
pub trait AgentTool: Send + Sync {
    /// Unique tool name (used in LLM tool_use)
    fn name(&self) -> &str;
    /// Human-readable label for UI
    fn label(&self) -> &str;
    /// Description for the LLM
    fn description(&self) -> &str;
    /// JSON Schema for parameters
    fn parameters_schema(&self) -> serde_json::Value;
    /// One-line capability summary for the system prompt's "Available tools"
    /// list. Tools returning `None` are omitted from the list (still usable).
    fn prompt_snippet(&self) -> Option<&str> {
        None
    }
    /// Usage guidelines this tool contributes to the system prompt's
    /// "Guidelines" section. Default: none.
    fn prompt_guidelines(&self) -> Vec<&str> {
        Vec::new()
    }
    /// "Prefer this dedicated tool" mapping for the system prompt's tool-usage
    /// section, as `(action phrase, alternatives to avoid)`. The tool's own
    /// name is filled in by the prompt builder using the model-resolved alias
    /// (e.g. Claude sees `Grep`), so this returns only the surrounding text.
    /// Rendered as: ``To {action}, use `{name}` instead of {alternatives}.``
    /// `None` = the tool contributes no such line (e.g. bash, the fallback).
    fn prefer_over(&self) -> Option<(&str, &str)> {
        None
    }
    /// Parameter alias mappings for input normalization.
    /// Returns canonical_name → accepted_alternatives pairs.
    /// Default: no aliases.
    fn parameter_aliases(&self) -> Option<AliasMap> {
        None
    }
    /// Tool-specific compatibility shim for raw arguments before schema
    /// validation. Implementations may normalize known legacy shapes, but must
    /// leave unrecognized malformed input unchanged so validation can report it.
    fn prepare_arguments(&self, args: &serde_json::Value) -> serde_json::Value {
        args.clone()
    }
    /// Preview the system command that will be executed, if applicable.
    ///
    /// Returns `None` for tools that don't invoke external commands.
    /// Used by the UI to display the full command being run.
    fn preview_command(&self, _params: &serde_json::Value) -> Option<String> {
        None
    }

    /// Model-specific name aliases: (model_pattern, llm_name).
    /// If model contains pattern (case-insensitive), use that name for LLM.
    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![]
    }

    /// A successful call settles the run: the loop records the result and
    /// ends without asking the model for a follow-up response. For tools
    /// whose result carries nothing the model should act on now (e.g.
    /// scheduling a later wakeup). Default: false.
    fn ends_turn(&self) -> bool {
        false
    }

    /// Resolve the tool name to present to a given model.
    fn resolve_name(&self, model: &str) -> String {
        let model_lower = model.to_lowercase();
        for (pattern, alias) in self.name_aliases() {
            if model_lower.contains(&pattern.to_lowercase()) {
                return alias;
            }
        }
        self.name().to_string()
    }

    /// Check if a called tool name matches this tool (case-insensitive).
    /// Matches against the base name and all known aliases regardless of model.
    fn matches_call_name(&self, called_name: &str) -> bool {
        let called_lower = called_name.to_lowercase();
        if self.name().to_lowercase() == called_lower {
            return true;
        }
        self.name_aliases()
            .iter()
            .any(|(_, alias)| alias.to_lowercase() == called_lower)
    }

    /// Execute the tool.
    ///
    /// The `ctx` parameter provides per-invocation context:
    /// - `ctx.tool_call_id` / `ctx.tool_name` — for correlation and logging
    /// - `ctx.cancel` — cancellation token; check `is_cancelled()` in long-running tools
    /// - `ctx.on_update` — optional callback for streaming partial `ToolResult`s (UI/logging only)
    /// - `ctx.on_progress` — optional callback for user-facing progress text (`ProgressMessage`)
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub content: Vec<Content>,
    #[serde(default)]
    pub details: serde_json::Value,
    #[serde(default)]
    pub retention: Retention,
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("{0}")]
    Failed(String),
    #[error("Tool not found: {0}")]
    NotFound(String),
    #[error("Invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("Cancelled")]
    Cancelled,
}
