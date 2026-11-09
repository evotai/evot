//! Current tool availability at the model boundary, independent of UI state.

use std::collections::BTreeSet;

use crate::types::AgentTool;
use crate::types::Content;
use crate::types::Message;

/// History can outlive a run-scoped capability (for example, `/loop stop`
/// removes the scheduler tools), or name a tool this run never had (an
/// imported session, a hallucinated call). Preserve that history, but
/// explicitly retire its tool-dependent instructions in the next model request.
/// Derive this from the actual run tools so resume, retries and custom history
/// conversion cannot miss a one-shot UI notification. The reminder is
/// request-local, not another persisted user turn.
pub fn tool_availability_reminder(
    messages: &[Message],
    tools: &[Box<dyn AgentTool>],
) -> Option<Message> {
    let mut unavailable: BTreeSet<&str> = messages
        .iter()
        .filter_map(|message| match message {
            Message::Assistant { content, .. } => Some(content),
            _ => None,
        })
        .flatten()
        .filter_map(|block| match block {
            Content::ToolCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    // Match each distinct name once, not every call in a long-lived session.
    unavailable.retain(|name| !tools.iter().any(|tool| tool.matches_call_name(name)));
    if unavailable.is_empty() {
        return None;
    }

    // JSON quoting keeps names as data, not instructions. Tool definitions in
    // this request remain the authority; historical calls never grant access.
    let names = serde_json::json!(unavailable);
    Some(Message::runtime_user(
        format!(
            "<system-reminder>\n\
             Tools called earlier in this conversation are not declared in this \
             run: {names}.\n\
             Earlier instructions to call these tools or continue a workflow that \
             requires them are no longer active. Do not call them, emulate them with \
             other tools, or restart their workflow on your own. If the user wants \
             that workflow back, say so and let them re-enable it. Follow the user's \
             current request using only the tools declared now.\n\
             </system-reminder>"
        ),
        "tool_availability",
        None,
    ))
}
