use serde::Deserialize;
use serde::Serialize;

/// Host tools use a separate envelope: they do not invent run/session ids.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload")]
pub enum HostEvent {
    #[serde(rename = "host_tool_call")]
    ToolCall {
        tool_name: String,
        tool_call_id: String,
        arguments: serde_json::Value,
    },
}
