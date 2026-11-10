//! Wire DTOs for cloud scheduled tasks.
//!
//! These types are a published contract with the cloud API. Added fields must
//! stay backward-readable, so every non-essential field carries `serde(default)`.

use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRunSummary {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub delivery_status: String,
    pub scheduled_for: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskStats {
    #[serde(default)]
    pub window_days: i64,
    #[serde(default)]
    pub runs: i64,
    #[serde(default)]
    pub completed: i64,
    #[serde(default)]
    pub succeeded: i64,
    #[serde(default)]
    pub execution_success_rate: Option<f64>,
    #[serde(default)]
    pub delivery_attempted: i64,
    #[serde(default)]
    pub delivery_sent: i64,
    #[serde(default)]
    pub delivery_success_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub revision: i64,
    pub name: String,
    pub cron: String,
    pub timezone: String,
    pub instruction: String,
    pub executor_id: String,
    #[serde(default = "default_model_policy")]
    pub model_policy: String,
    #[serde(default)]
    pub model_spec: String,
    #[serde(default)]
    pub thinking_level: String,
    #[serde(default)]
    pub workspace_ref: String,
    #[serde(default)]
    pub delivery_channel: String,
    #[serde(default)]
    pub delivery_target: String,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: i64,
    #[serde(default = "default_max_lateness_seconds")]
    pub max_lateness_seconds: i64,
    pub enabled: bool,
    pub next_run_at: i64,
    #[serde(default)]
    pub last_run: Option<TaskRunSummary>,
    #[serde(default)]
    pub recent_runs: Vec<TaskRunSummary>,
    #[serde(default)]
    pub stats: TaskStats,
}

fn default_model_policy() -> String {
    "default".to_string()
}

fn default_timeout_seconds() -> i64 {
    900
}

fn default_max_lateness_seconds() -> i64 {
    14_400
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskList {
    pub tasks: Vec<Task>,
    pub cache: CacheStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStatus {
    pub ready: bool,
    pub synced_at: i64,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatedTask {
    pub task: Task,
    pub next_runs: Vec<i64>,
}

/// A published task link, as `POST /v1/tasks/{id}/share` answers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskShareCreated {
    pub id: String,
    pub url: String,
}

/// The task share snapshot contract as served by `/share/t/{id}/task.json`.
///
/// `schema_version` belongs to the snapshot, independent of the session share
/// schema and of the server release. Unknown future versions are refused by
/// `TaskShareSnapshot::verify` rather than half-read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskShareSnapshot {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub evot_version: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    pub data: TaskShareData,
}

/// The recipe: schedule, model, instruction. Never a delivery target, owner,
/// executor or workspace; `delivery_target_masked` is display-only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskShareData {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cron: String,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default = "default_model_policy")]
    pub model_policy: String,
    #[serde(default)]
    pub model_spec: String,
    #[serde(default)]
    pub thinking_level: String,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: i64,
    #[serde(default = "default_max_lateness_seconds")]
    pub max_lateness_seconds: i64,
    #[serde(default)]
    pub delivery_channel: String,
    #[serde(default)]
    pub delivery_target_masked: String,
}

impl TaskShareSnapshot {
    pub const SCHEMA_VERSION: u32 = 1;

    /// Accept only what this client knows how to import.
    pub fn verify(self) -> crate::base::error::Result<Self> {
        if self.kind != "task" {
            return Err(crate::base::error::EvotError::Conf(
                "this link is not a shared task".into(),
            ));
        }
        if self.schema_version > Self::SCHEMA_VERSION {
            return Err(crate::base::error::EvotError::Conf(format!(
                "this shared task uses schema v{}; update evot to import it",
                self.schema_version
            )));
        }
        if self.data.name.trim().is_empty()
            || self.data.cron.trim().is_empty()
            || self.data.instruction.trim().is_empty()
        {
            return Err(crate::base::error::EvotError::Conf(
                "shared task is missing its name, schedule or instruction".into(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimedRun {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub scheduled_for: i64,
    pub expires_at: i64,
    pub task_snapshot: Task,
    pub lease_token: String,
}
