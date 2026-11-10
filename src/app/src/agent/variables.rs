//! Variables — app-layer variable management with persistence.

use std::sync::Arc;

use parking_lot::RwLock;

use crate::base::error::Result;
use crate::session::storage::Storage;
use crate::types::VariableRecord;

// ---------------------------------------------------------------------------
// VariableInfo — projection for REPL display
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct VariableInfo {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

pub struct Variables {
    records: Arc<RwLock<Vec<VariableRecord>>>,
    storage: Arc<dyn Storage>,
}

impl Variables {
    pub fn new(storage: Arc<dyn Storage>, records: Vec<VariableRecord>) -> Self {
        Self {
            records: Arc::new(RwLock::new(records)),
            storage,
        }
    }

    // -- REPL-facing ---------------------------------------------------------

    pub fn list_global(&self) -> Vec<VariableInfo> {
        let mut items: Vec<VariableInfo> = self
            .records
            .read()
            .iter()
            .map(|r| VariableInfo {
                key: r.key.clone(),
                value: r.value.clone(),
                updated_at: r.updated_at.clone(),
            })
            .collect();

        items.sort_by(|a, b| a.key.cmp(&b.key));
        items
    }

    pub async fn set_global(&self, key: String, value: String) -> Result<()> {
        let record = VariableRecord {
            key,
            value,
            updated_at: now_iso8601(),
        };
        let merged = self.storage.upsert_variable(record).await?;
        *self.records.write() = merged;
        Ok(())
    }

    pub async fn delete_global(&self, key: &str) -> Result<bool> {
        let (removed, merged) = self.storage.remove_variable(key.to_string()).await?;
        *self.records.write() = merged;
        Ok(removed)
    }

    pub fn has_variables(&self) -> bool {
        !self.records.read().is_empty()
    }

    /// Return all variable values (for display-layer masking).
    pub fn secret_values(&self) -> Vec<String> {
        self.records
            .read()
            .iter()
            .map(|r| r.value.clone())
            .collect()
    }

    /// Return all variables as (key, value) pairs for bash env injection.
    pub fn all_env_pairs(&self) -> Vec<(String, String)> {
        let mut items: Vec<(String, String)> = self
            .records
            .read()
            .iter()
            .map(|r| (r.key.clone(), r.value.clone()))
            .collect();
        items.sort_by(|a, b| a.0.cmp(&b.0));
        items
    }

    /// Return all variable keys (for system prompt listing).
    pub fn variable_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.records.read().iter().map(|r| r.key.clone()).collect();
        names.sort();
        names.dedup();
        names
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
