//! Compute machine records persisted in `~/.evotai/compute.json`.
//!
//! This is a published persistent format: every non-identity field carries a
//! serde default so older documents stay readable, and the document carries
//! its own schema version independent of any server or catalog version.

use serde::Deserialize;
use serde::Serialize;

/// Current `compute.json` schema version. A missing version is legacy v0,
/// which has the same shape; anything newer than this is rejected.
pub const COMPUTE_SCHEMA_VERSION: u32 = 1;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ComputeDocument {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub machines: Vec<ComputeMachine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputeMachine {
    pub id: String,
    pub name: String,
    pub ssh_target: String,
    /// What the user wants this machine used for. The agent reads it to decide
    /// which work belongs here.
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Hardware and tools from the most recent successful check.
    #[serde(default)]
    pub profile: Option<MachineProfile>,
    /// Outcome of the most recent check, successful or not.
    #[serde(default)]
    pub last_check: Option<MachineCheck>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct MachineProfile {
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub cpus: u32,
    #[serde(default)]
    pub mem_gb: u32,
    #[serde(default)]
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Ok,
    /// Timed out, refused, or the name did not resolve.
    Unreachable,
    /// Reachable, but non-interactive authentication failed.
    Auth,
    /// The host key is not in known_hosts yet.
    NeedsTrust,
    /// The host key differs from the one in known_hosts.
    HostKeyChanged,
    /// Any other failure; the message says what happened.
    #[default]
    #[serde(other)]
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct MachineCheck {
    #[serde(default)]
    pub checked_at: String,
    #[serde(default)]
    pub status: CheckStatus,
    #[serde(default)]
    pub message: String,
}

/// One machine this computer appears able to reach, found without connecting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputeCandidate {
    /// What to pass to `ssh`: an alias from ssh config or `user@host`.
    pub target: String,
    /// Resolved HostName for an ssh config alias.
    #[serde(default)]
    pub host_name: String,
    /// Where it was found: `ssh_config`, `shell_history`, `tailscale`.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Times it appears in shell history.
    #[serde(default)]
    pub connections: u32,
    /// Unix seconds of the most recent history entry, when recorded.
    #[serde(default)]
    pub last_used: Option<i64>,
    /// A reason to think twice, e.g. the name suggests a database server.
    #[serde(default)]
    pub warning: String,
}

/// Result of one read-only probe over ssh.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProbeResult {
    pub target: String,
    pub check: MachineCheck,
    #[serde(default)]
    pub profile: Option<MachineProfile>,
    /// The target is already a `Host` alias in `~/.ssh/config`. Otherwise
    /// adding the machine creates one named after it.
    #[serde(default)]
    pub ssh_alias: bool,
}

/// Fields a caller may set when adding a machine.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewMachine {
    pub name: String,
    pub ssh_target: String,
    pub description: String,
    #[serde(default)]
    pub profile: Option<MachineProfile>,
    #[serde(default)]
    pub last_check: Option<MachineCheck>,
}

/// Fields a caller may change. Omitted fields keep their values; the ssh
/// target is fixed for the life of a machine.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MachinePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}
