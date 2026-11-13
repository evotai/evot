use std::io::BufRead;
use std::path::Path;

use crate::base::error::EvotError;
use crate::base::error::Result;

pub(super) fn load_env_file(path: &Path) -> Result<Vec<(String, String)>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = std::fs::File::open(path)
        .map_err(|e| EvotError::Conf(format!("failed to open {}: {e}", path.display())))?;
    let reader = std::io::BufReader::new(file);
    let mut pairs = Vec::new();
    for line in reader.lines() {
        let line =
            line.map_err(|e| EvotError::Conf(format!("failed to read {}: {e}", path.display())))?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Strip optional "export " prefix
        let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            if !key.is_empty() {
                pairs.push((key, value));
            }
        }
    }
    Ok(pairs)
}

pub(super) fn load_process_env() -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (key, value) in std::env::vars() {
        if is_relevant_key(&key) {
            pairs.push((key, value));
        }
    }
    pairs
}

pub(super) fn ensure_env_file(path: &Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    // Never replace a user file that appears between the existence check and
    // creation (for example, during concurrent startup).
    crate::base::atomic_file::create_private_atomic(path, default_env_content().as_bytes())?;
    Ok(())
}

fn default_env_content() -> &'static str {
    r#"# EVOT_LLM_THINKING_LEVEL=medium
# Global reasoning effort. One of off, minimal, low, medium, high, xhigh, max.
# Default: medium. Applies to every provider unless overridden per provider via
# EVOT_LLM_{PROVIDER}_THINKING_LEVEL below. Levels a model does not support are
# clamped to the nearest tier it does (searching upward first, then downward).
# Anthropic: off disables thinking; minimal/low=low, medium=medium, high=high.
#   xhigh/max=strongest efforts when the active model supports those tiers.
# OpenAI-compatible: each level maps to the matching reasoning_effort value,
#   except xhigh/max which need explicit model support (e.g. gpt-5.6).

# EVOT_LLM_ANTHROPIC_API_KEY=
# EVOT_LLM_ANTHROPIC_BASE_URL=https://api.anthropic.com
# EVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-20250514
# Multiple models: EVOT_LLM_ANTHROPIC_MODEL=claude-sonnet-4-6,claude-opus-4-6
# Or OpenAI Responses (must be selected explicitly)
# EVOT_LLM_OPENAI_API_KEY=
# EVOT_LLM_OPENAI_BASE_URL=https://api.openai.com/v1
# EVOT_LLM_OPENAI_MODEL=gpt-5.5
# EVOT_LLM_OPENAI_PROTOCOL=openai_responses

# Per-provider reasoning effort (overrides the global level above):
# EVOT_LLM_ANTHROPIC_THINKING_LEVEL=xhigh
# EVOT_LLM_DEEPSEEK_THINKING_LEVEL=off
"#
}

/// Legacy key prefixes for backward compatibility.
const LEGACY_PREFIXES: &[&str] = &["EVOT_ANTHROPIC_", "EVOT_OPENAI_"];

/// Non-LLM keys we still care about.
const OTHER_RELEVANT_PREFIXES: &[&str] = &[
    "EVOT_SERVER_",
    "EVOT_STORAGE_",
    "EVOT_CHANNEL_",
    "EVOT_SANDBOX",
    "EVOT_SKILLS_DIRS",
    "EVOT_SESSION_HOOK",
    "EVOT_ID",
    "EVOT_THINKING_LEVEL",
];

fn is_relevant_key(key: &str) -> bool {
    if key.starts_with("EVOT_LLM_") {
        return true;
    }
    for prefix in LEGACY_PREFIXES {
        if key.starts_with(prefix) {
            return true;
        }
    }
    for prefix in OTHER_RELEVANT_PREFIXES {
        if key.starts_with(prefix) {
            return true;
        }
    }
    false
}
