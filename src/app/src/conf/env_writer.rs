use std::path::Path;

use crate::base::error::EvotError;
use crate::base::error::Result;

/// Markers delimiting the evot-managed region of the env file. Everything the
/// dashboard writes lives between these lines; anything a user adds outside is
/// preserved verbatim across saves. Mirrors the convention used by tools like
/// `conda init` and `nvm` when they edit shell rc files.
const BEGIN_MARKER: &str = "# >>> evot managed (edited via dashboard) >>>";
const END_MARKER: &str = "# <<< evot managed <<<";

/// A titled group of `key=value` pairs rendered together under one comment
/// header inside the managed block.
#[derive(Debug, Clone)]
pub struct EnvGroup {
    pub title: String,
    pub pairs: Vec<(String, String)>,
}

impl EnvGroup {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            pairs: Vec::new(),
        }
    }

    pub fn push(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.pairs.push((key.into(), value.into()));
    }
}

/// Parse the assignment key from a raw line, if it is an active (non-comment)
/// `KEY=...` / `export KEY=...` assignment. Comments and blanks return `None`.
fn active_key(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        return None;
    }
    let body = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, _) = body.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    Some(key)
}

/// Prefixes identifying env keys that evot owns. Any active assignment whose
/// key starts with one of these and sits outside the managed block is removed
/// on save, so stale providers, relocated secrets, and legacy keys never
/// linger as duplicates. Keys outside this namespace are always preserved.
const MANAGED_PREFIXES: &[&str] = &[
    "EVOT_LLM_",
    "EVOT_CHANNEL_FEISHU_",
    // Legacy single-provider keys, superseded by EVOT_LLM_{NAME}_*.
    "EVOT_ANTHROPIC_",
    "EVOT_OPENAI_",
];

fn is_managed_key(key: &str) -> bool {
    MANAGED_PREFIXES.iter().any(|p| key.starts_with(p))
}

pub fn remove_keys(path: &Path, discard: impl Fn(&str) -> bool) -> Result<bool> {
    let transaction = super::env_transaction::EnvTransaction::open(path)?;
    remove_keys_locked(&transaction, discard)
}

pub(crate) fn remove_keys_locked(
    transaction: &super::env_transaction::EnvTransaction,
    discard: impl Fn(&str) -> bool,
) -> Result<bool> {
    let path = transaction.path();
    if !path.exists() {
        return Ok(false);
    }
    let existing = std::fs::read_to_string(path)
        .map_err(|e| EvotError::Conf(format!("failed to read {}: {e}", path.display())))?;

    let kept: Vec<&str> = existing
        .lines()
        .filter(|line| !active_key(line).is_some_and(&discard))
        .collect();
    if kept.len() == existing.lines().count() {
        return Ok(false);
    }

    write_atomic(path, &tidy_managed_block(&kept))?;
    Ok(true)
}

fn tidy_managed_block(lines: &[&str]) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut in_block = false;
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed == BEGIN_MARKER {
            in_block = true;
        } else if trimmed == END_MARKER {
            in_block = false;
        } else if in_block {
            let orphan_header = trimmed.starts_with('#')
                && lines
                    .get(i + 1)
                    .is_none_or(|next| active_key(next).is_none());
            let repeated_blank =
                trimmed.is_empty() && out.last().is_some_and(|prev| prev.trim().is_empty());
            if orphan_header || repeated_blank {
                continue;
            }
        }
        out.push(line);
    }

    let mut content = out.join("\n");
    content.push('\n');
    content
}

/// Write the given groups into the env file at `path` as a single managed
/// block, replacing any previous managed block.
///
/// Guarantees:
/// - **Authoritative**: the managed block holds the complete evot config
///   (including secrets), so values are never split across the file.
/// - **Deduplicated**: any active assignment for an evot-managed key found
///   outside the block is dropped, so keys never appear twice.
/// - **Grouped**: pairs are rendered under their group's comment header in the
///   order given, never interleaved.
/// - **Non-destructive**: user comments and keys outside evot's namespace are
///   preserved in place; the managed block is regenerated at the end.
///
/// Written atomically (temp file + rename); on Unix the mode is tightened to
/// `0o600` since the file may hold provider secrets.
pub fn write_grouped(path: &Path, groups: &[EnvGroup]) -> Result<()> {
    let transaction = super::env_transaction::EnvTransaction::open(path)?;
    write_grouped_locked(&transaction, groups)
}

pub(crate) fn write_grouped_locked(
    transaction: &super::env_transaction::EnvTransaction,
    groups: &[EnvGroup],
) -> Result<()> {
    let path = transaction.path();
    let existing = if path.exists() {
        std::fs::read_to_string(path)
            .map_err(|e| EvotError::Conf(format!("failed to read {}: {e}", path.display())))?
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                EvotError::Conf(format!("failed to create {}: {e}", parent.display()))
            })?;
        }
        String::new()
    };

    let preamble = strip_managed_region(&existing);
    let block = render_block(groups);

    let mut content = String::new();
    let trimmed_preamble = preamble.trim_end();
    if !trimmed_preamble.is_empty() {
        content.push_str(trimmed_preamble);
        content.push_str("\n\n");
    }
    content.push_str(&block);
    write_atomic(path, &content)
}

/// Return the file content with the old managed block removed and any active
/// assignment for an evot-managed key dropped. Comments and keys outside
/// evot's namespace survive.
fn strip_managed_region(content: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut in_block = false;
    for line in content.lines() {
        let t = line.trim();
        if t == BEGIN_MARKER {
            in_block = true;
            continue;
        }
        if t == END_MARKER {
            in_block = false;
            continue;
        }
        if in_block {
            continue;
        }
        // Drop stale active assignments for keys evot manages (dedupe + cleanup
        // of deleted providers). Comments and foreign keys are kept.
        if let Some(key) = active_key(line) {
            if is_managed_key(key) {
                continue;
            }
        }
        out.push(line);
    }
    out.join("\n")
}

/// Render the managed block: begin marker, each group under its header,
/// blank-line separated, then the end marker.
fn render_block(groups: &[EnvGroup]) -> String {
    let mut s = String::new();
    s.push_str(BEGIN_MARKER);
    s.push('\n');
    for group in groups {
        if group.pairs.is_empty() {
            continue;
        }
        s.push_str("\n# ");
        s.push_str(&group.title);
        s.push('\n');
        for (key, value) in &group.pairs {
            s.push_str(key);
            s.push('=');
            s.push_str(value);
            s.push('\n');
        }
    }
    s.push_str(END_MARKER);
    s.push('\n');
    s
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    crate::base::atomic_file::write_private_atomic(path, content.as_bytes())
}
