use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use evot::agent::require_approval;
use evot::agent::ToolApproval;
use evot::agent::ToolApprovalRequest;
use evot::agent::ToolApprover;
use evot_engine::AgentTool;
use evot_engine::Content;
use evot_engine::ToolContext;
use evot_engine::ToolError;
use evot_engine::ToolResult;

struct Probe(Arc<AtomicBool>);

#[async_trait::async_trait]
impl AgentTool for Probe {
    fn name(&self) -> &str {
        "probe"
    }
    fn label(&self) -> &str {
        "Probe"
    }
    fn description(&self) -> &str {
        "records whether it ran"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        self.0.store(true, Ordering::SeqCst);
        Ok(ToolResult {
            content: vec![Content::Text { text: "ran".into() }],
            details: serde_json::Value::Null,
            retention: Default::default(),
        })
    }
}

struct Fixed(ToolApproval);

#[async_trait::async_trait]
impl ToolApprover for Fixed {
    async fn approve(&self, _request: ToolApprovalRequest) -> ToolApproval {
        self.0
    }
}

struct Never;

#[async_trait::async_trait]
impl ToolApprover for Never {
    async fn approve(&self, _request: ToolApprovalRequest) -> ToolApproval {
        std::future::pending().await
    }
}

fn ctx() -> ToolContext {
    ToolContext {
        tool_call_id: "call-1".into(),
        tool_name: "probe".into(),
        cancel: tokio_util::sync::CancellationToken::new(),
        on_update: None,
        on_progress: None,
        cwd: std::env::temp_dir(),
        path_guard: Arc::new(evot_engine::PathGuard::open()),
        spill: None,
        supports_image: true,
    }
}

fn wrapped(approver: impl ToolApprover + 'static) -> (Box<dyn AgentTool>, Arc<AtomicBool>) {
    let ran = Arc::new(AtomicBool::new(false));
    let approver: Arc<dyn ToolApprover> = Arc::new(approver);
    let mut tools = require_approval(vec![Box::new(Probe(ran.clone()))], &approver);
    (tools.remove(0), ran)
}

#[tokio::test]
async fn denied_call_never_executes() {
    let (tool, ran) = wrapped(Fixed(ToolApproval::Deny));
    let result = tool.execute(serde_json::json!({}), ctx()).await;
    match result {
        Err(error) => assert!(error.to_string().contains("denied"), "{error}"),
        Ok(_) => panic!("denied call ran"),
    }
    assert!(!ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn allowed_call_executes() {
    let (tool, ran) = wrapped(Fixed(ToolApproval::Allow));
    assert!(tool.execute(serde_json::json!({}), ctx()).await.is_ok());
    assert!(ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn cancellation_while_waiting_never_executes() {
    let (tool, ran) = wrapped(Never);
    let ctx = ctx();
    ctx.cancel.cancel();
    assert!(matches!(
        tool.execute(serde_json::json!({}), ctx).await,
        Err(ToolError::Cancelled)
    ));
    assert!(!ran.load(Ordering::SeqCst));
}
