//! Variable management on `NapiAgent`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::agent::NapiAgent;

#[napi]
impl NapiAgent {
    /// List agent variables as JSON array of {key, value, updated_at}.
    #[napi]
    pub fn list_variables(&self) -> Result<String> {
        match self.agent.variables() {
            Some(vars) => {
                let items: Vec<_> = vars
                    .list_global()
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                            "key": v.key,
                            "value": v.value,
                            "updated_at": v.updated_at,
                        })
                    })
                    .collect();
                serde_json::to_string(&items)
                    .map_err(|e| Error::from_reason(format!("serialize: {e}")))
            }
            None => Ok("[]".to_string()),
        }
    }

    /// Set an agent variable (persisted).
    #[napi]
    pub async fn set_variable(&self, key: String, value: String) -> Result<()> {
        match self.agent.variables() {
            Some(vars) => vars
                .set_global(key, value)
                .await
                .map_err(|e| Error::from_reason(format!("set variable: {e}"))),
            None => Err(Error::from_reason("variables not available")),
        }
    }

    /// Delete an agent variable. Returns true if it existed.
    #[napi]
    pub async fn delete_variable(&self, key: String) -> Result<bool> {
        match self.agent.variables() {
            Some(vars) => vars
                .delete_global(&key)
                .await
                .map_err(|e| Error::from_reason(format!("delete variable: {e}"))),
            None => Err(Error::from_reason("variables not available")),
        }
    }
}
