//! Every machine is added under an ssh alias, so the model, prompts and
//! transcripts only ever see the name, never an address. A target that is
//! not already a `Host` in `~/.ssh/config` gets one, named after the machine.

use std::path::Path;

use tokio_util::sync::CancellationToken;

use super::discover;
use super::discover::SshConfigHost;
use crate::error::EvotError;
use crate::error::Result;

/// Whether `target` is a `Host` alias in the ssh config under `home`.
pub fn is_config_alias(home: &Path, target: &str, cancel: &CancellationToken) -> bool {
    !target.contains('@')
        && discover::config_hosts(home, cancel)
            .iter()
            .any(|host| host.alias == target)
}

/// `user@host` → (`user`, `host`); brackets around an IPv6 host are dropped.
pub fn split_target(target: &str) -> (&str, &str) {
    let (user, host) = target.rsplit_once('@').unwrap_or(("", target));
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    (user, host)
}

/// The `Host` block evot appends for `alias`.
pub fn host_block(alias: &str, target: &str) -> String {
    let (user, host) = split_target(target);
    let mut block = format!("# Added by evot /compute\nHost {alias}\n  HostName {host}\n");
    if !user.is_empty() {
        block.push_str(&format!("  User {user}\n"));
    }
    block
}

/// The alias to store for a new machine named `name` reached at `target`.
/// An existing alias is kept as is; otherwise `name` is added to
/// `~/.ssh/config`, or reused when it already points at the same host.
/// Blocking.
pub fn ensure_alias(
    home: &Path,
    name: &str,
    target: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    let hosts = discover::config_hosts(home, cancel);
    if !target.contains('@') && hosts.iter().any(|host| host.alias == target) {
        return Ok(target.to_string());
    }
    if let Some(existing) = hosts.iter().find(|host| host.alias == name) {
        return if same_host(existing, target) {
            Ok(name.to_string())
        } else {
            Err(EvotError::Conf(format!(
                "~/.ssh/config already has Host {name} for another machine; choose another name"
            )))
        };
    }
    append_block(&home.join(".ssh").join("config"), &host_block(name, target))?;
    Ok(name.to_string())
}

fn same_host(existing: &SshConfigHost, target: &str) -> bool {
    let (user, host) = split_target(target);
    existing.host_name.eq_ignore_ascii_case(host) && (user.is_empty() || existing.user == user)
}

/// Append to the ssh config without truncating it in place. A symlinked
/// config (dotfile managers) is written through to its target.
fn append_block(config: &Path, block: &str) -> Result<()> {
    let path = std::fs::canonicalize(config).unwrap_or_else(|_| config.to_path_buf());
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            std::fs::create_dir_all(dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    let mut content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(EvotError::Io(error)),
    };
    if !content.is_empty() {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push('\n');
    }
    content.push_str(block);
    crate::atomic_file::write_private_atomic(&path, content.as_bytes())
}
