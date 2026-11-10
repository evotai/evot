use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// Independent of pi's session version and the server release version.
#[derive(Debug, Serialize, Deserialize)]
pub struct ShareUpload {
    #[serde(default)]
    pub schema_version: u32,
    pub evot_version: String,
    pub session_id: String,
    pub title: Option<String>,
    pub data: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShareCreated {
    pub id: String,
    pub url: String,
}

/// Display-only observation, never model context. Version zero is legacy.
///
/// `kind` / `data` are additive: absent means the original plain UI notice.
/// Structured kinds are allowlisted by `record_notices` before persistence.
#[derive(Debug, Serialize, Deserialize)]
pub struct ShareNotice {
    #[serde(default)]
    pub schema_version: u32,
    pub level: String,
    pub text: String,
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub data: Value,
}
