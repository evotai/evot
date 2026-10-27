//! Per-call tool approval: a run can require an outside party (e.g. an ACP
//! client) to allow each tool call before it executes.

use std::sync::Arc;

use evot_engine::AgentTool;
use evot_engine::ToolContext;
use evot_engine::ToolError;
use evot_engine::ToolResult;

/// One tool call awaiting a decision. `args` are the validated arguments the
/// tool would run with.
#[derive(Clone, Debug)]
pub struct ToolApprovalRequest {
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: serde_json::Value,
    pub preview_command: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolApproval {
    Allow,
    Deny,
}

/// Decides whether a tool call may run. Any failure to decide must deny.
#[async_trait::async_trait]
pub trait ToolApprover: Send + Sync {
    async fn approve(&self, request: ToolApprovalRequest) -> ToolApproval;
}

/// Message the model sees for a denied call.
pub(crate) const DENIED_MESSAGE: &str =
    "The user denied this tool call. Do not retry it; continue without it or answer directly.";

/// Wrap every tool so it executes only after `approver` allows the call.
pub fn require_approval(
    tools: Vec<Box<dyn AgentTool>>,
    approver: &Arc<dyn ToolApprover>,
) -> Vec<Box<dyn AgentTool>> {
    tools
        .into_iter()
        .map(|inner| {
            Box::new(ApprovedTool {
                inner,
                approver: approver.clone(),
            }) as Box<dyn AgentTool>
        })
        .collect()
}

struct ApprovedTool {
    inner: Box<dyn AgentTool>,
    approver: Arc<dyn ToolApprover>,
}

#[async_trait::async_trait]
impl AgentTool for ApprovedTool {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn label(&self) -> &str {
        self.inner.label()
    }
    fn description(&self) -> &str {
        self.inner.description()
    }
    fn parameters_schema(&self) -> serde_json::Value {
        self.inner.parameters_schema()
    }
    fn prompt_snippet(&self) -> Option<&str> {
        self.inner.prompt_snippet()
    }
    fn prompt_guidelines(&self) -> Vec<&str> {
        self.inner.prompt_guidelines()
    }
    fn prefer_over(&self) -> Option<(&str, &str)> {
        self.inner.prefer_over()
    }
    fn parameter_aliases(&self) -> Option<evot_engine::tools::validation::AliasMap> {
        self.inner.parameter_aliases()
    }
    fn prepare_arguments(&self, args: &serde_json::Value) -> serde_json::Value {
        self.inner.prepare_arguments(args)
    }
    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        self.inner.preview_command(params)
    }
    fn name_aliases(&self) -> Vec<(String, String)> {
        self.inner.name_aliases()
    }
    fn resolve_name(&self, model: &str) -> String {
        self.inner.resolve_name(model)
    }
    fn matches_call_name(&self, called_name: &str) -> bool {
        self.inner.matches_call_name(called_name)
    }
    fn ends_turn(&self) -> bool {
        self.inner.ends_turn()
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let request = ToolApprovalRequest {
            tool_call_id: ctx.tool_call_id.clone(),
            tool_name: self.inner.name().to_string(),
            preview_command: self.inner.preview_command(&params),
            args: params.clone(),
        };
        let decision = tokio::select! {
            decision = self.approver.approve(request) => decision,
            _ = ctx.cancel.cancelled() => return Err(ToolError::Cancelled),
        };
        match decision {
            ToolApproval::Allow if !ctx.cancel.is_cancelled() => {
                self.inner.execute(params, ctx).await
            }
            ToolApproval::Allow => Err(ToolError::Cancelled),
            ToolApproval::Deny => Err(ToolError::Failed(DENIED_MESSAGE.to_string())),
        }
    }
}
