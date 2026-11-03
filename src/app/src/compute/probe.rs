//! One read-only ssh round trip that reports hardware and installed tools.
//!
//! The probe never prompts: `BatchMode=yes` turns password and passphrase
//! prompts into failures, and `StrictHostKeyChecking=yes` refuses unknown or
//! changed host keys instead of accepting them.

use std::process::Stdio;
use std::time::Duration;

use super::model::CheckStatus;
use super::model::MachineCheck;
use super::model::MachineProfile;
use super::model::ProbeResult;
use super::validate;
use crate::error::Result;

const CONNECT_TIMEOUT_SECONDS: u32 = 5;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Tools worth knowing about when deciding where builds and tests can run,
/// and how to copy files and keep long jobs alive there.
pub const PROBED_TOOLS: &[&str] = &[
    "tmux",
    "rsync",
    "git",
    "make",
    "gcc",
    "cargo",
    "go",
    "node",
    "bun",
    "python3",
    "java",
    "docker",
    "nvidia-smi",
];

/// POSIX sh, run as `sh -c '<script>'` so the remote login shell (bash, zsh,
/// fish) only has to pass one single-quoted word through. Contains no single
/// quotes.
pub fn probe_script() -> String {
    let tools = PROBED_TOOLS.join(" ");
    let tool_loop =
        format!("for t in {tools}; do command -v $t >/dev/null 2>&1 && echo \"tool=$t\"; done");
    [
        // A non-interactive ssh shell often lacks the login PATH.
        "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin:/snap/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin\"",
        "p=\"\"",
        "[ -r /etc/os-release ] && p=$(. /etc/os-release; echo \"$PRETTY_NAME\")",
        "[ -z \"$p\" ] && command -v sw_vers >/dev/null 2>&1 && p=\"$(sw_vers -productName) $(sw_vers -productVersion)\"",
        "[ -z \"$p\" ] && p=$(uname -sr)",
        "echo \"os=$p\"",
        "echo \"arch=$(uname -m)\"",
        "c=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)",
        "echo \"cpus=$c\"",
        "m=$(awk \"/^MemTotal:/{print int(\\$2/1048576+0.5)}\" /proc/meminfo 2>/dev/null)",
        "[ -n \"$m\" ] || m=$(sysctl -n hw.memsize 2>/dev/null | awk \"{print int(\\$1/1073741824+0.5)}\")",
        "echo \"mem_gb=$m\"",
        tool_loop.as_str(),
        "echo probe=ok",
    ]
    .join("; ")
}

/// Parse `key=value` lines from the probe. Returns `None` unless the script
/// ran to its final marker.
pub fn parse_probe_output(stdout: &str) -> Option<MachineProfile> {
    let mut profile = MachineProfile::default();
    let mut complete = false;
    for line in stdout.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key {
            "os" => profile.os = value.chars().take(80).collect(),
            "arch" => profile.arch = value.chars().take(32).collect(),
            "cpus" => profile.cpus = value.parse().unwrap_or(0),
            "mem_gb" => profile.mem_gb = value.parse().unwrap_or(0),
            "tool" => {
                if PROBED_TOOLS.contains(&value) && !profile.tools.iter().any(|t| t == value) {
                    profile.tools.push(value.to_string());
                }
            }
            "probe" => complete = value == "ok",
            _ => {}
        }
    }
    complete.then_some(profile)
}

/// Turn ssh's stderr into a status the user can act on.
pub fn classify_failure(stderr: &str) -> (CheckStatus, String) {
    let text = stderr.to_ascii_lowercase();
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('@') && !line.starts_with("Warning"))
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>();
    if text.contains("remote host identification has changed") {
        return (
            CheckStatus::HostKeyChanged,
            "Host key changed since it was trusted".into(),
        );
    }
    if text.contains("host key verification failed") || text.contains("no matching host key") {
        return (
            CheckStatus::NeedsTrust,
            "Host key is not trusted yet; connect once with ssh to trust it".into(),
        );
    }
    if text.contains("permission denied") || text.contains("too many authentication failures") {
        return (
            CheckStatus::Auth,
            "Authentication failed without a prompt; add the key to ssh-agent or ssh config".into(),
        );
    }
    if text.contains("timed out")
        || text.contains("could not resolve")
        || text.contains("connection refused")
        || text.contains("no route to host")
        || text.contains("network is unreachable")
        || text.contains("connection closed")
        || text.contains("connection reset")
    {
        let message = if first.is_empty() {
            "Machine is not reachable".to_string()
        } else {
            first
        };
        return (CheckStatus::Unreachable, message);
    }
    (
        CheckStatus::Error,
        if first.is_empty() {
            "ssh failed".into()
        } else {
            first
        },
    )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn result(target: &str, status: CheckStatus, message: String) -> ProbeResult {
    ProbeResult {
        target: target.to_string(),
        check: MachineCheck {
            checked_at: now(),
            status,
            message,
        },
        profile: None,
        ssh_alias: false,
    }
}

/// Connect once and read the machine profile. Connection failures are a
/// normal result, not an error; only an invalid target is an error.
pub async fn probe(target: &str) -> Result<ProbeResult> {
    let target = validate::ssh_target(target)?;
    let mut command = tokio::process::Command::new("ssh");
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg(format!("ConnectTimeout={CONNECT_TIMEOUT_SECONDS}"))
        .arg("-o")
        .arg("StrictHostKeyChecking=yes")
        .arg("-o")
        .arg("LogLevel=ERROR")
        .arg("-T")
        .arg("--")
        .arg(&target)
        .arg(format!("sh -c '{}'", probe_script()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(result(
                &target,
                CheckStatus::Error,
                format!("could not start ssh: {error}"),
            ))
        }
    };
    let output = match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Ok(result(
                &target,
                CheckStatus::Error,
                format!("ssh failed: {error}"),
            ))
        }
        Err(_) => {
            return Ok(result(
                &target,
                CheckStatus::Unreachable,
                format!("No response within {}s", PROBE_TIMEOUT.as_secs()),
            ))
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        if let Some(profile) = parse_probe_output(&stdout) {
            let mut ok = result(&target, CheckStatus::Ok, String::new());
            ok.profile = Some(profile);
            return Ok(ok);
        }
        return Ok(result(
            &target,
            CheckStatus::Error,
            "Connected, but the remote shell did not run the probe".into(),
        ));
    }
    let (status, message) = classify_failure(&stderr);
    Ok(result(&target, status, message))
}
