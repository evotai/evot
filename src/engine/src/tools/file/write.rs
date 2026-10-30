//! Write tool — write content to files.

use async_trait::async_trait;

use super::diff;
use super::mutex::acquire_file_lock;
use crate::types::*;

/// Write content to a file. Creates parent directories if needed.
pub struct WriteFileTool;

impl Default for WriteFileTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WriteFileTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> &str {
        "write"
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "Write".into())]
    }

    fn label(&self) -> &str {
        "Write File"
    }

    fn description(&self) -> &str {
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. \
         Automatically creates parent directories."
    }

    fn prompt_snippet(&self) -> Option<&str> {
        Some("Create or overwrite files")
    }

    fn prompt_guidelines(&self) -> Vec<&str> {
        vec!["Use write only for new files or complete rewrites."]
    }

    fn prefer_over(&self) -> Option<(&str, &str)> {
        Some(("create files", "cat with a heredoc or echo redirection"))
    }

    fn parameter_aliases(&self) -> Option<crate::tools::validation::AliasMap> {
        Some(&[("path", &["file_path", "filePath", "file"] as &[&str])])
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to write (relative or absolute). Emit path first, before content."
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            },
            "required": ["path", "content"]
        })
    }

    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        let path = params["path"].as_str()?;
        Some(format!("cat > {}", path))
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let path_str = params["path"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'path' parameter".into()))?;
        let content = params["content"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'content' parameter".into()))?;

        let path = ctx.path_guard.resolve_path(&ctx.cwd, path_str)?;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Acquire per-file lock to serialize mutations on the same file
        let _lock = acquire_file_lock(&path).await;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Read old content before writing (for diff display)
        let old_content = tokio::fs::read_to_string(&path).await.ok();

        // Create parent directories
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| ToolError::Failed(format!("Cannot create directory: {}", e)))?;
            }
        }

        let bytes = content.len();
        let existed = old_content.is_some();
        let old = old_content.as_deref().unwrap_or("");
        let diff_result = diff::unified_diff(old, content, path_str);

        // Emit preview diff before writing (for immediate UI rendering)
        if let Some(ref on_update) = ctx.on_update {
            on_update(ToolResult {
                content: vec![],
                details: serde_json::json!({
                    "preview": true,
                    "diff": diff_result.unified,
                    "added_lines": diff_result.added_lines,
                    "removed_lines": diff_result.removed_lines,
                }),
                retention: Retention::CurrentRun,
            });
        }

        tokio::fs::write(&path, content)
            .await
            .map_err(|e| ToolError::Failed(format!("Cannot write {}: {}", path.display(), e)))?;

        Ok(ToolResult {
            content: vec![Content::Text {
                text: format!("Wrote {} bytes to {}", bytes, path_str),
            }],
            details: serde_json::json!({
                "path": path_str,
                "bytes": bytes,
                "created": !existed,
                "diff": diff_result.unified,
                "preview_rendered": ctx.on_update.is_some(),
            }),
            retention: Retention::Normal,
        })
    }
}
