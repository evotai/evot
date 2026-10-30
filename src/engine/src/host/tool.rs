//! [`HostTool`]: an [`AgentTool`] whose execution is delegated to the host.
//!
//! The engine builds one `HostTool` per [`HostToolSpec`] the host registers.
//! Its `execute` forwards the call over the [`HostBridge`] and maps the
//! [`HostToolResponse`] back into a [`ToolResult`]. This is the single,
//! reusable mechanism behind every host-owned tool (ask_user and any future
//! domain tool) — the engine holds no tool-specific logic.

use async_trait::async_trait;

use super::bridge::HostError;
use super::bridge::SharedHost;
use super::protocol::HostToolCall;
use super::protocol::HostToolSpec;
use crate::types::*;

/// An agent tool that delegates execution to the host process.
pub struct HostTool {
    spec: HostToolSpec,
    host: SharedHost,
}

impl HostTool {
    pub fn new(spec: HostToolSpec, host: SharedHost) -> Self {
        Self { spec, host }
    }
}

#[async_trait]
impl AgentTool for HostTool {
    fn name(&self) -> &str {
        &self.spec.name
    }

    fn label(&self) -> &str {
        &self.spec.label
    }

    fn description(&self) -> &str {
        &self.spec.description
    }

    fn parameters_schema(&self) -> serde_json::Value {
        self.spec.parameters_schema.clone()
    }

    fn prompt_snippet(&self) -> Option<&str> {
        self.spec.prompt_snippet.as_deref()
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        self.spec.name_aliases.clone()
    }

    fn ends_turn(&self) -> bool {
        self.spec.ends_turn
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let call = HostToolCall {
            tool_name: self.spec.name.clone(),
            tool_call_id: ctx.tool_call_id.clone(),
            arguments: params,
        };

        // Idle-clock accounting (excluding this wait from the execution
        // duration limit) is handled uniformly by the loop for every tool, so
        // there is nothing tool-specific to do here.
        let response = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(ToolError::Cancelled),
            response = self.host.execute_tool(call) => response,
        };

        match response {
            Ok(resp) => {
                if resp.is_error {
                    // Surface tool-reported failure as a ToolError so the loop
                    // records it consistently with in-engine tools.
                    let text = merge_text(&resp.content);
                    Err(ToolError::Failed(text))
                } else {
                    Ok(ToolResult {
                        content: resp.content,
                        details: resp.details,
                        retention: Retention::Normal,
                    })
                }
            }
            Err(HostError::Cancelled) => Err(ToolError::Cancelled),
            Err(e) => Err(ToolError::Failed(e.to_string())),
        }
    }
}

fn merge_text(content: &[Content]) -> String {
    let mut out = String::new();
    for c in content {
        if let Content::Text { text } = c {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    if out.is_empty() {
        "Tool reported an error".to_string()
    } else {
        out
    }
}
