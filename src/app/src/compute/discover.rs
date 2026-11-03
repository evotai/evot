//! Find machines this computer appears able to reach, without connecting.
//!
//! Sources are local files only: ssh config (with `Include`), shell history,
//! and an optional `tailscale status` snapshot supplied by the caller. Shell
//! history is reduced to ssh targets here; no other history text leaves this
//! module.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::model::ComputeCandidate;
use super::validate;
use crate::error::Result;

const MAX_CANDIDATES: usize = 10;
const MAX_HISTORY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_INCLUDE_DEPTH: usize = 4;
const RECENT_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Hosts that accept ssh for git, not shell work.
const GIT_HOSTS: &[&str] = &[
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "ssh.dev.azure.com",
    "vs-ssh.visualstudio.com",
    "codeberg.org",
    "git.sr.ht",
    "gitee.com",
    "ssh.github.com",
    "altssh.gitlab.com",
];

/// ssh options that consume the next argument (or the rest of the token).
const SSH_VALUE_OPTIONS: &str = "BbcDEeFIiJLlmOoPpQRSWw";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SshConfigHost {
    pub alias: String,
    pub host_name: String,
    pub user: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SshConfig {
    pub hosts: Vec<SshConfigHost>,
    pub includes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryHit {
    pub target: String,
    pub at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TailscalePeer {
    pub dns_name: String,
    pub host_name: String,
}

/// Everything read from local files in one pass.
#[derive(Debug, Clone, Default)]
pub struct LocalScan {
    pub config_hosts: Vec<SshConfigHost>,
    pub history: Vec<HistoryHit>,
}

// ---------------------------------------------------------------------------
// ssh config
// ---------------------------------------------------------------------------

fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let split = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..split].to_ascii_lowercase();
    let value = line[split..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .trim()
        .trim_matches('"')
        .to_string();
    Some((key, value))
}

/// Parse `Host` blocks. Wildcard and negated patterns are skipped; `Match`
/// blocks end the current `Host` block.
pub fn parse_ssh_config(content: &str) -> SshConfig {
    let mut config = SshConfig::default();
    let mut current: Vec<usize> = Vec::new();
    for line in content.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    config.hosts.push(SshConfigHost {
                        alias: alias.to_string(),
                        ..SshConfigHost::default()
                    });
                    current.push(config.hosts.len() - 1);
                }
            }
            "match" => current.clear(),
            "hostname" => {
                for index in &current {
                    if let Some(host) = config.hosts.get_mut(*index) {
                        if host.host_name.is_empty() {
                            host.host_name = value.clone();
                        }
                    }
                }
            }
            "user" => {
                for index in &current {
                    if let Some(host) = config.hosts.get_mut(*index) {
                        if host.user.is_empty() {
                            host.user = value.clone();
                        }
                    }
                }
            }
            "include" => config
                .includes
                .extend(value.split_whitespace().map(str::to_string)),
            _ => {}
        }
    }
    config
}

/// Resolve one `Include` pattern relative to `~/.ssh`. Only `*` and `?` in the
/// final path component are expanded, which covers `config.d/*`.
fn include_paths(pattern: &str, ssh_dir: &Path, home: &Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = pattern.strip_prefix("~/") {
        home.join(rest)
    } else if pattern.starts_with('/') {
        PathBuf::from(pattern)
    } else {
        ssh_dir.join(pattern)
    };
    let Some(file_pattern) = path.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    if !file_pattern.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| wildcard_match(file_pattern, name))
        })
        .map(|entry| entry.path())
        .collect();
    paths.sort();
    paths
}

/// `*` and `?` glob match on a single name.
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(star_at) = star {
            p = star_at + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

fn read_ssh_config(
    path: &Path,
    ssh_dir: &Path,
    home: &Path,
    depth: usize,
    hosts: &mut Vec<SshConfigHost>,
    cancel: &CancellationToken,
) {
    if depth > MAX_INCLUDE_DEPTH || cancel.is_cancelled() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    // ssh reads an Include where it appears, so keep that order: parse the
    // text between Include lines as its own chunk.
    let mut chunk = String::new();
    for line in content.lines() {
        let include = split_directive(line).filter(|(key, _)| key == "include");
        let Some((_, patterns)) = include else {
            chunk.push_str(line);
            chunk.push('\n');
            continue;
        };
        hosts.extend(parse_ssh_config(&chunk).hosts);
        chunk.clear();
        for pattern in patterns.split_whitespace() {
            for include in include_paths(pattern, ssh_dir, home) {
                read_ssh_config(&include, ssh_dir, home, depth + 1, hosts, cancel);
            }
        }
    }
    hosts.extend(parse_ssh_config(&chunk).hosts);
}

// ---------------------------------------------------------------------------
// shell history
// ---------------------------------------------------------------------------

fn strip_prefix_words(segment: &str) -> &str {
    let mut rest = segment.trim();
    loop {
        let word_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..word_end];
        let is_prefix =
            matches!(
                word,
                "sudo" | "exec" | "command" | "time" | "nohup" | "then" | "do" | "else" | "{" | "("
            ) || (word.contains('=') && !word.starts_with('-') && !word.starts_with('='));
        if !is_prefix || word_end == rest.len() {
            return rest;
        }
        rest = rest[word_end..].trim_start();
    }
}

/// The target of one `ssh ...` invocation, or `None` when the line is not a
/// plain interactive ssh to a recognisable host.
pub fn ssh_target_from_command(command: &str) -> Option<String> {
    let mut words = command.split_whitespace();
    let program = words.next()?;
    if program != "ssh" && !program.ends_with("/ssh") {
        return None;
    }
    let mut user = String::new();
    let mut target: Option<String> = None;
    let mut words = words.peekable();
    while let Some(word) = words.next() {
        if word == "--" {
            target = words.next().map(str::to_string);
            break;
        }
        if let Some(flags) = word.strip_prefix('-') {
            if flags.is_empty() {
                return None;
            }
            for (index, flag) in flags.char_indices() {
                if SSH_VALUE_OPTIONS.contains(flag) {
                    let inline = &flags[index + flag.len_utf8()..];
                    let value = if inline.is_empty() {
                        words.next().unwrap_or_default().to_string()
                    } else {
                        inline.to_string()
                    };
                    if flag == 'l' {
                        user = value;
                    }
                    break;
                }
            }
            continue;
        }
        target = Some(word.to_string());
        break;
    }
    let target = target?;
    if target.contains("://")
        || target.contains(['$', '`', '\'', '"', '{', '}', '*', '(', ')', '<', '>'])
    {
        return None;
    }
    let target = if !user.is_empty() && !target.contains('@') {
        format!("{user}@{target}")
    } else {
        target
    };
    let target = validate::ssh_target(&target).ok()?;
    let host = host_part(&target).to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]") || is_git_host(&host) {
        return None;
    }
    Some(target)
}

fn commands_in_line(line: &str) -> Vec<&str> {
    line.split([';', '|', '&'])
        .map(strip_prefix_words)
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Parse zsh (plain or extended), bash (optionally with `#<epoch>` lines), and
/// fish history into ssh targets with timestamps where recorded.
pub fn parse_history(content: &str) -> Vec<HistoryHit> {
    let mut hits: Vec<HistoryHit> = Vec::new();
    let mut pending_at: Option<i64> = None;
    let mut fish_hits: Vec<usize> = Vec::new();
    for raw in content.lines() {
        let line = raw.trim_end();
        // bash HISTTIMEFORMAT marker for the following command.
        if let Some(stamp) = line.strip_prefix('#') {
            if let Ok(at) = stamp.trim().parse::<i64>() {
                pending_at = Some(at);
                continue;
            }
        }
        // fish: `- cmd: ...` followed by `  when: <epoch>`.
        if let Some(when) = line.trim_start().strip_prefix("when:") {
            if let Ok(at) = when.trim().parse::<i64>() {
                for index in fish_hits.drain(..) {
                    if let Some(hit) = hits.get_mut(index) {
                        hit.at = Some(at);
                    }
                }
            }
            continue;
        }
        let (command, at) = if let Some(cmd) = line.strip_prefix("- cmd: ") {
            (cmd, None)
        } else if let Some(rest) = line.strip_prefix(": ") {
            // zsh extended history `: <start>:<elapsed>;<command>`
            match rest.split_once(';') {
                Some((meta, cmd)) => (
                    cmd,
                    meta.split(':')
                        .next()
                        .and_then(|s| s.trim().parse::<i64>().ok()),
                ),
                None => (line, None),
            }
        } else {
            (line, pending_at.take())
        };
        let is_fish = line.starts_with("- cmd: ");
        fish_hits.clear();
        for segment in commands_in_line(command) {
            if let Some(target) = ssh_target_from_command(segment) {
                hits.push(HistoryHit { target, at });
                if is_fish {
                    fish_hits.push(hits.len() - 1);
                }
            }
        }
    }
    hits
}

fn read_history(path: &Path) -> Vec<HistoryHit> {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if !metadata.is_file() || metadata.len() > MAX_HISTORY_BYTES {
        return Vec::new();
    }
    match std::fs::read(path) {
        Ok(bytes) => parse_history(&String::from_utf8_lossy(&bytes)),
        Err(_) => Vec::new(),
    }
}

/// Every concrete `Host` alias in `~/.ssh/config` under `home`, following
/// `Include`s. Blocking.
pub fn config_hosts(home: &Path, cancel: &CancellationToken) -> Vec<SshConfigHost> {
    let ssh_dir = home.join(".ssh");
    let mut hosts = Vec::new();
    read_ssh_config(
        &ssh_dir.join("config"),
        &ssh_dir,
        home,
        0,
        &mut hosts,
        cancel,
    );
    hosts
}

/// Read ssh config and shell history under `home`, plus `histfile` (the
/// shell's `$HISTFILE`) when given. Blocking; run through `blocking_io`.
pub fn scan_local(
    home: &Path,
    histfile: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<LocalScan> {
    let config_hosts = config_hosts(home, cancel);
    let mut history = Vec::new();
    let mut files = vec![home.join(".zsh_history"), home.join(".bash_history")];
    if let Some(path) = histfile {
        if !files.iter().any(|known| known == path) {
            files.push(path.to_path_buf());
        }
    }
    files.push(home.join(".local/share/fish/fish_history"));
    for file in files {
        if cancel.is_cancelled() {
            return Err(crate::blocking::cancelled("compute discovery"));
        }
        history.extend(read_history(&file));
    }
    Ok(LocalScan {
        config_hosts,
        history,
    })
}

/// Peers from `tailscale status --json`: online, and on systems that usually
/// run sshd.
pub fn parse_tailscale_status(json: &str) -> Vec<TailscalePeer> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    if value.get("BackendState").and_then(|v| v.as_str()) != Some("Running") {
        return Vec::new();
    }
    let Some(peers) = value.get("Peer").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<TailscalePeer> = peers
        .values()
        .filter(|peer| peer.get("Online").and_then(|v| v.as_bool()) == Some(true))
        .filter(|peer| {
            let os = peer
                .get("OS")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            matches!(os.as_str(), "linux" | "macos" | "freebsd" | "openbsd")
        })
        .filter_map(|peer| {
            let dns_name = peer
                .get("DNSName")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim_end_matches('.')
                .to_string();
            let host_name = peer
                .get("HostName")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let target = if dns_name.is_empty() {
                host_name.clone()
            } else {
                dns_name.clone()
            };
            validate::ssh_target(&target).ok()?;
            Some(TailscalePeer {
                dns_name: target,
                host_name,
            })
        })
        .collect();
    out.sort_by(|a, b| a.dns_name.cmp(&b.dns_name));
    out
}

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

/// The host portion of `user@host`.
pub fn host_part(target: &str) -> &str {
    target.rsplit_once('@').map_or(target, |(_, host)| host)
}

fn user_part(target: &str) -> &str {
    target.split_once('@').map_or("", |(user, _)| user)
}

fn is_git_host(host: &str) -> bool {
    GIT_HOSTS
        .iter()
        .any(|known| host.eq_ignore_ascii_case(known))
}

/// A reason to think twice before handing this machine work.
pub fn caution(names: &[&str]) -> String {
    let words: Vec<String> = names
        .iter()
        .flat_map(|name| {
            name.to_ascii_lowercase()
                .split(|c: char| !c.is_ascii_alphabetic())
                .filter(|w| !w.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();
    let has = |set: &[&str]| words.iter().any(|w| set.contains(&w.as_str()));
    if has(&["prod", "production", "prd", "live"]) {
        return "name suggests production".into();
    }
    if has(&[
        "db",
        "database",
        "mysql",
        "postgres",
        "postgresql",
        "pg",
        "redis",
        "mongo",
        "mongodb",
        "clickhouse",
    ]) {
        return "name suggests a database".into();
    }
    String::new()
}

fn insert(
    candidate: ComputeCandidate,
    order: &mut Vec<String>,
    map: &mut HashMap<String, ComputeCandidate>,
) {
    if !map.contains_key(&candidate.target) {
        order.push(candidate.target.clone());
        map.insert(candidate.target.clone(), candidate);
    }
}

fn candidate(target: String, host_name: String, source: Option<&str>) -> ComputeCandidate {
    ComputeCandidate {
        target,
        host_name,
        sources: source.map(|s| vec![s.to_string()]).unwrap_or_default(),
        connections: 0,
        last_used: None,
        warning: String::new(),
    }
}

/// Merge every source into ranked candidates, dropping targets already added.
pub fn rank(
    scan: &LocalScan,
    tailscale: &[TailscalePeer],
    existing_targets: &[String],
    now: i64,
) -> Vec<ComputeCandidate> {
    let mut order: Vec<String> = Vec::new();
    let mut by_target: HashMap<String, ComputeCandidate> = HashMap::new();

    let mut aliases: Vec<&SshConfigHost> = Vec::new();
    for host in &scan.config_hosts {
        let resolved = if host.host_name.is_empty() {
            &host.alias
        } else {
            &host.host_name
        };
        if is_git_host(&host.alias) || is_git_host(resolved) {
            continue;
        }
        if validate::ssh_target(&host.alias).is_err() || by_target.contains_key(&host.alias) {
            continue;
        }
        aliases.push(host);
        insert(
            candidate(
                host.alias.clone(),
                host.host_name.clone(),
                Some("ssh_config"),
            ),
            &mut order,
            &mut by_target,
        );
    }

    for hit in &scan.history {
        let host = host_part(&hit.target);
        let user = user_part(&hit.target);
        let alias = aliases.iter().find(|alias| {
            hit.target == alias.alias
                || (!alias.host_name.is_empty()
                    && alias.host_name.eq_ignore_ascii_case(host)
                    && (user.is_empty() || alias.user.is_empty() || alias.user == user))
        });
        let key = alias.map_or_else(|| hit.target.clone(), |alias| alias.alias.clone());
        if !by_target.contains_key(&key) {
            insert(
                candidate(key.clone(), String::new(), None),
                &mut order,
                &mut by_target,
            );
        }
        if let Some(candidate) = by_target.get_mut(&key) {
            candidate.connections += 1;
            if !candidate.sources.iter().any(|s| s == "shell_history") {
                candidate.sources.push("shell_history".into());
            }
            if let Some(at) = hit.at {
                candidate.last_used = Some(candidate.last_used.map_or(at, |prev| prev.max(at)));
            }
        }
    }

    for peer in tailscale {
        let existing = order.iter().find(|target| {
            let candidate_host = host_part(target);
            candidate_host.eq_ignore_ascii_case(&peer.dns_name)
                || candidate_host.eq_ignore_ascii_case(&peer.host_name)
                || by_target.get(*target).is_some_and(|c| {
                    !c.host_name.is_empty()
                        && (c.host_name.eq_ignore_ascii_case(&peer.dns_name)
                            || c.host_name.eq_ignore_ascii_case(&peer.host_name))
                })
        });
        match existing.cloned() {
            Some(target) => {
                if let Some(candidate) = by_target.get_mut(&target) {
                    if !candidate.sources.iter().any(|s| s == "tailscale") {
                        candidate.sources.push("tailscale".into());
                    }
                }
            }
            None => insert(
                candidate(
                    peer.dns_name.clone(),
                    peer.host_name.clone(),
                    Some("tailscale"),
                ),
                &mut order,
                &mut by_target,
            ),
        }
    }

    let mut candidates: Vec<ComputeCandidate> = order
        .into_iter()
        .filter_map(|target| by_target.remove(&target))
        .filter(|candidate| {
            !existing_targets.iter().any(|existing| {
                existing == &candidate.target
                    || (!candidate.host_name.is_empty()
                        && host_part(existing).eq_ignore_ascii_case(&candidate.host_name))
            })
        })
        .map(|mut candidate| {
            candidate.warning = caution(&[&candidate.target, &candidate.host_name]);
            candidate
        })
        .collect();

    let score = |candidate: &ComputeCandidate| -> i64 {
        let mut score = i64::from(candidate.connections);
        if candidate.sources.iter().any(|s| s == "ssh_config") {
            score += 3;
        }
        if candidate.sources.iter().any(|s| s == "tailscale") {
            score += 2;
        }
        if candidate
            .last_used
            .is_some_and(|at| now.saturating_sub(at) <= RECENT_SECONDS)
        {
            score += 5;
        }
        if !candidate.warning.is_empty() {
            score -= 5;
        }
        score
    };
    // Stable sort keeps discovery order for equal scores.
    candidates.sort_by(|a, b| {
        score(b)
            .cmp(&score(a))
            .then_with(|| b.last_used.unwrap_or(0).cmp(&a.last_used.unwrap_or(0)))
    });
    candidates.truncate(MAX_CANDIDATES);
    candidates
}
