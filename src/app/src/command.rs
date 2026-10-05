//! Slash-command parsing for `/clear`, `/compact`, etc.
//!
//! Commands are core domain operations executed by the agent; channels and the
//! gateway only forward user text here.

// ---------------------------------------------------------------------------
// Command — parsed gateway commands
// ---------------------------------------------------------------------------

pub enum Command {
    Clear,
    Compact {
        custom_instructions: Option<String>,
    },
    /// Hidden `/_dump` — emit current system prompt + tools as JSON.
    /// Optional argument is an output path. When None, the agent picks a
    /// timestamped default under `~/.evotai/dumps/`.
    Dump {
        target: Option<String>,
    },
    /// `/clip all` — distill durable knowledge from the current conversation
    /// into the memory vault through a normal LLM turn. Bare `/clip` is a TUI
    /// command that saves the latest assistant reply locally.
    ClipSession,
    /// `/sessions <query> [--days N | --since 2w | --all]` — search past
    /// sessions by meaning with the session-search skill over locally prepared
    /// evidence. Bare `/sessions` is a TUI command (the resume selector).
    SessionSearch(crate::search::SessionSearch),
    UsageError(String),
}

/// Build the prompt `/clip all` expands into. The command injects the memory
/// workflow instead of asking the model to discover it from the skill index.
pub fn clip_session_prompt(memory_instructions: &str) -> String {
    format!(
        "The `memory` skill is already loaded for this command. Archive the durable knowledge \
         from this conversation into the memory vault now. Do not claim that the memory skill \
         is unavailable. Follow the skill instructions below.\n\n\
         ---\n{memory_instructions}"
    )
}

/// Queue guard shared by product adapters. This mirrors CLI command-shape
/// recognition, not execution parsing: paths and a lone slash remain prompts.
pub fn is_queued_command(text: &str) -> bool {
    let token = text.split_whitespace().next().unwrap_or("");
    match token.strip_prefix('/') {
        Some(name) => {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        }
        None => false,
    }
}

pub fn parse_command(text: &str) -> Option<Command> {
    let trimmed = text.trim();
    let lower = trimmed.to_lowercase();

    if lower == "/clear" {
        return Some(Command::Clear);
    }
    if lower == "/compact" || lower.starts_with("/compact ") {
        let arg = trimmed
            .strip_prefix("/compact")
            .or_else(|| trimmed.strip_prefix("/COMPACT"))
            .map(str::trim)
            .unwrap_or("");
        return Some(Command::Compact {
            custom_instructions: (!arg.is_empty()).then(|| arg.to_string()),
        });
    }
    if lower == "/_dump" || lower.starts_with("/_dump ") {
        let arg = trimmed
            .strip_prefix("/_dump")
            .or_else(|| trimmed.strip_prefix("/_DUMP"))
            .map(str::trim)
            .unwrap_or("");
        let target = (!arg.is_empty()).then(|| arg.to_string());
        return Some(Command::Dump { target });
    }
    if lower == "/clip all" {
        return Some(Command::ClipSession);
    }
    if let Some(args) = trimmed.strip_prefix("/sessions ") {
        return Some(match crate::search::SessionSearch::parse(args) {
            Some(search) => Command::SessionSearch(search),
            None => Command::UsageError(
                "Usage: /sessions <query> [--days N | --since 2w | --all]".to_string(),
            ),
        });
    }
    if lower == "/clip" || lower.starts_with("/clip ") {
        return Some(Command::UsageError(
            "/clip saves the last reply locally in the TUI; use `/clip all` to distill this session into memory".to_string(),
        ));
    }
    None
}
