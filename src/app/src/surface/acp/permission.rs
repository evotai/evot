//! `session/request_permission`: the client approves each tool call of a
//! session before it runs.

use std::collections::HashSet;
use std::sync::Arc;

use agent_client_protocol_schema::v1 as acp;
use parking_lot::Mutex;

use super::connection::Connection;
use super::projection::tool_kind;
use crate::agent::ToolApproval;
use crate::agent::ToolApprovalRequest;
use crate::agent::ToolApprover;

const ALLOW_ONCE: &str = "allow";
const ALLOW_ALWAYS: &str = "allow_always";
const REJECT_ONCE: &str = "reject";

pub(super) struct AcpApprover {
    pub(super) connection: Arc<Connection>,
    pub(super) session_id: String,
    /// Tools the client allowed for the rest of this session.
    pub(super) always_allowed: Arc<Mutex<HashSet<String>>>,
}

#[async_trait::async_trait]
impl ToolApprover for AcpApprover {
    async fn approve(&self, request: ToolApprovalRequest) -> ToolApproval {
        if self.always_allowed.lock().contains(&request.tool_name) {
            return self.allowed(&request.tool_call_id);
        }
        let title = request
            .preview_command
            .clone()
            .unwrap_or_else(|| request.tool_name.clone());
        let tool_call = acp::ToolCallUpdate::new(
            request.tool_call_id.clone(),
            acp::ToolCallUpdateFields::new()
                .title(title)
                .kind(tool_kind(&request.tool_name))
                .status(acp::ToolCallStatus::Pending)
                .raw_input(request.args.clone()),
        );
        let params = acp::RequestPermissionRequest::new(self.session_id.clone(), tool_call, vec![
            acp::PermissionOption::new(ALLOW_ONCE, "Allow", acp::PermissionOptionKind::AllowOnce),
            acp::PermissionOption::new(
                ALLOW_ALWAYS,
                format!("Always allow {}", request.tool_name),
                acp::PermissionOptionKind::AllowAlways,
            ),
            acp::PermissionOption::new(
                REJECT_ONCE,
                "Reject",
                acp::PermissionOptionKind::RejectOnce,
            ),
        ]);
        // No answer (disconnect, error) or an unusable one denies.
        let answer = self
            .connection
            .request("session/request_permission", params)
            .await;
        match answer.and_then(selected_option).as_deref() {
            Some(ALLOW_ONCE) => self.allowed(&request.tool_call_id),
            Some(ALLOW_ALWAYS) => {
                self.always_allowed.lock().insert(request.tool_name);
                self.allowed(&request.tool_call_id)
            }
            _ => ToolApproval::Deny,
        }
    }
}

impl AcpApprover {
    /// Tell the client the approved call is now running.
    fn allowed(&self, tool_call_id: &str) -> ToolApproval {
        let fields = acp::ToolCallUpdateFields::new().status(acp::ToolCallStatus::InProgress);
        self.connection.update(
            &self.session_id,
            acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
                tool_call_id.to_string(),
                fields,
            )),
        );
        ToolApproval::Allow
    }
}

/// The chosen option ID; `None` for cancellation or an unexpected shape.
fn selected_option(result: serde_json::Value) -> Option<String> {
    let response: acp::RequestPermissionResponse = serde_json::from_value(result).ok()?;
    match response.outcome {
        acp::RequestPermissionOutcome::Selected(selected) => Some(selected.option_id.0.to_string()),
        _ => None,
    }
}
