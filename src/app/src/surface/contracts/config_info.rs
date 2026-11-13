use serde::Deserialize;
use serde::Serialize;

/// Published NAPI JSON envelope. Field spelling is intentionally independent
/// from Rust naming. Model entries remain extensible catalog-owned objects.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInfo {
    pub provider: String,
    pub protocol: String,
    pub env_path: String,
    pub has_api_key: bool,
    pub base_url: Option<String>,
    pub available_models: Vec<serde_json::Value>,
    pub thinking_level: String,
    /// Retired capability, retained only for historical addon JSON. Current
    /// writers leave it absent; it never enables model calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<String>,
    /// The account's pinned landing model (cloud wire id) from the server, so
    /// the picker can mark it. Absent when the account has no pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Resolved user-level lifecycle executable. Older addons omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_hook: Option<String>,
}
