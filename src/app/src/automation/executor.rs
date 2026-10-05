//! Executor identity and capability registration.

use crate::auth::AuthState;
use crate::conf::ChannelsConfig;
use crate::error::Result;

/// Executor identity is shared by every instance of one cloud user.
///
/// A run becomes claimable by whichever live instance polls for it — and the
/// only process that polls is the one that bound the embedded server's port,
/// so "the :8082 owner fetches the work" holds per machine and across
/// machines. Deriving the id from `hostname` or an instance name orphaned
/// tasks the moment the network renamed the host: nothing running could
/// still claim them.
pub fn executor_id(user_id: &str) -> String {
    use sha2::Digest;

    let digest = sha2::Sha256::digest(user_id.as_bytes());
    format!("exec_{}", hex(&digest[..12]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn executor_name(executor_id: &str) -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| executor_id.to_string())
}

/// Attach the reporting machine to failures using the existing error string.
/// The shared executor registration is mutable and cannot identify a past run.
/// Keep successful reports empty and the original error intact for older clients.
pub fn error_with_executor(error: &str, hostname: &str) -> String {
    if error.is_empty() {
        return String::new();
    }
    let hostname: String = hostname.chars().filter(|ch| !ch.is_control()).collect();
    let hostname = hostname.trim();
    let hostname = if hostname.is_empty() {
        "Unknown host"
    } else {
        hostname
    };
    format!("{error}\nExecutor: {hostname}")
}

/// What this device can do for scheduled tasks right now. Recomputed from
/// config on every poll so console edits take effect without a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutorCapabilities {
    pub feishu_ready: bool,
}

impl ExecutorCapabilities {
    pub fn from_channels(channels: &ChannelsConfig) -> Self {
        Self {
            feishu_ready: channels.feishu.as_ref().is_some_and(|feishu| {
                !feishu.app_id.trim().is_empty() && !feishu.app_secret.trim().is_empty()
            }),
        }
    }

    fn wire(&self) -> serde_json::Value {
        serde_json::json!({"feishu": {"ready": self.feishu_ready}})
    }

    /// Identity of one registration payload. Registration is repeated only when
    /// this changes, so a steady state costs no extra requests.
    pub fn fingerprint(&self, user_id: &str, executor_id: &str, name: &str) -> String {
        format!(
            "{user_id}|{executor_id}|{name}|feishu={}",
            self.feishu_ready
        )
    }
}

/// Only advertise tasks whose delivery can be resolved on this device.
/// Pin the revision so an edit between listing and claiming cannot assign an
/// incompatible snapshot. Paused tasks remain eligible for manual runs.
pub fn eligible_tasks(
    channels: &ChannelsConfig,
    tasks: &[super::model::Task],
) -> std::collections::BTreeMap<String, i64> {
    tasks
        .iter()
        .filter(|task| {
            super::delivery::validate(channels, &task.delivery_channel, &task.delivery_target)
                .is_ok()
        })
        .map(|task| (task.id.clone(), task.revision))
        .collect()
}

pub async fn register_executor(
    auth: &AuthState,
    id: &str,
    name: &str,
    capabilities: &ExecutorCapabilities,
) -> Result<()> {
    super::client::register_executor(auth, id, name, capabilities.wire()).await
}
