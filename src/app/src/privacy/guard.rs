//! [`GuardedTool`]: the tool boundary. Every tool the agent runs is wrapped
//! in one, so each call is checked by [`super::egress`] before it runs,
//! with the values the model saw as placeholders already put back. A call
//! that would send a secret where the user has not said it may go fails
//! without running; the model is told why.
use std::sync::Arc;

use evot_engine::AgentTool;
use evot_engine::ToolContext;
use evot_engine::ToolError;
use evot_engine::ToolResult;

use super::masker::Masker;
use super::notice::unavailable_message;
use super::record::Target;
use super::service;
use crate::blocking::blocking_io;

pub struct GuardedTool {
    inner: Box<dyn AgentTool>,
    /// Fixed masker; `None` follows the settings file.
    masker: Option<Arc<Masker>>,
    /// The session the calls belong to, for the record.
    session: Option<String>,
}

impl GuardedTool {
    pub fn new(inner: Box<dyn AgentTool>, session: Option<String>) -> Self {
        Self {
            inner,
            masker: None,
            session,
        }
    }

    pub fn with_masker(inner: Box<dyn AgentTool>, masker: Arc<Masker>) -> Self {
        Self {
            inner,
            masker: Some(masker),
            session: None,
        }
    }

    /// Check one call; `Err` is what the model is told instead of a result.
    async fn check(&self, params: &serde_json::Value, ctx: &ToolContext) -> Result<(), ToolError> {
        let unavailable = |error| ToolError::Failed(unavailable_message(error));
        let fixed = self.masker.clone();
        let name = self.inner.name().to_string();
        let arguments = params.clone();
        let cwd = ctx.cwd.clone();
        // Configuration I/O and analysis are one blocking batch, not two
        // pool hops. Dropping this future cancels the worker's token.
        let work = blocking_io("privacy egress", move |cancel| {
            let masker = match fixed {
                Some(masker) => masker,
                None => service::current(cancel)?,
            };
            let report = masker.check_call_cancellable(&name, &arguments, &cwd, cancel)?;
            Ok((masker, report))
        });
        let (masker, report) = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(ToolError::Cancelled),
            result = work => result.map_err(unavailable)?,
        };
        if report.is_empty() {
            return Ok(());
        }
        let mut record = report.record(Target::Egress);
        record.session = self.session.clone();
        record.tool = Some(self.inner.name().to_string());
        let reason = record.reason();
        service::keep(&masker, record).await;
        if report.blocked() {
            return Err(ToolError::Failed(report.egress_notice(&reason)));
        }
        Ok(())
    }
}

/// Every tool in `tools` behind the guard.
pub fn guard_tools(
    tools: Vec<Box<dyn AgentTool>>,
    session: Option<String>,
) -> Vec<Box<dyn AgentTool>> {
    tools
        .into_iter()
        .map(|tool| Box::new(GuardedTool::new(tool, session.clone())) as Box<dyn AgentTool>)
        .collect()
}

#[async_trait::async_trait]
impl AgentTool for GuardedTool {
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
    fn ends_turn(&self) -> bool {
        self.inner.ends_turn()
    }
    fn resolve_name(&self, model: &str) -> String {
        self.inner.resolve_name(model)
    }
    fn matches_call_name(&self, called_name: &str) -> bool {
        self.inner.matches_call_name(called_name)
    }
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        self.check(&params, &ctx).await?;
        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        self.inner.execute(params, ctx).await
    }
}
