//! Per-turn prompt sections appended after the static base.
//!
//! The static base (see [`super::SystemPrompt::base`]) is built once and stays
//! constant for the process. These sections vary per request — by interaction
//! mode and by runtime state (sandbox, variables) — so they live after the
//! prompt-cache boundary and are recomputed each turn.
//!
//! All dynamic section text lives here, and the mode-to-section policy is the
//! single `match` in [`dynamic_sections`].

use super::Section;

/// What kind of interaction this turn is, distilled from the agent's tool mode.
///
/// Kept free of the runtime payloads `ToolMode` carries (ask-user callbacks)
/// so the prompt layer stays independent of tool wiring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptMode {
    /// REPL with a human at the terminal.
    Interactive,
    /// Plan mode: no mutations allowed this turn.
    Planning,
    /// Oneshot / API / channel-driven, no human to converse with.
    Headless,
    /// Forked, read-only conversation.
    Readonly,
}

/// Runtime inputs that decide which dynamic sections apply this turn.
pub struct DynamicContext {
    pub mode: PromptMode,
    pub sandbox: bool,
    pub variables: Vec<String>,
}

/// Plan-mode constraints. Active only in [`PromptMode::Planning`].
const PLANNING_SECTION: &str = include_str!("prompts/plan.md");

/// Response-language guideline. Meaningful only for a human at the terminal,
/// so it rides on [`PromptMode::Interactive`].
const LANGUAGE_SECTION: &str = "\
Use the language established by the user's requests and preferences. \
Runtime notifications and tool output do not change that language. \
Technical terms, code, identifiers, file paths, and command names stay \
in their original form — never translate them.";

/// Sandbox constraints. Active only when the agent runs sandboxed.
const SANDBOX_SECTION: &str = "\
# Sandbox Mode\n\
You are running in a sandboxed environment with OS-level filesystem restrictions.\n\
- File access is restricted to the project workspace and explicitly allowed directories.\n\
- The user's home directory ($HOME) is NOT accessible except for allowed paths.\n\
- Do NOT attempt to install packages (pip install, brew install, curl | sh, etc.) — \
they will fail with \"Operation not permitted\".\n\
- Do NOT retry commands that fail with permission errors — the restriction is \
enforced by the kernel and cannot be bypassed.\n\
- Use only tools and binaries already available on PATH.";

fn variables_text(names: &[String]) -> String {
    format!(
        "Available variables: {}\n\n\
         These variables are automatically available in all bash commands \
         as environment variables. Use $VAR_NAME to reference them.\n\
         Do not print, echo, or expose variable values.",
        names.join(", ")
    )
}

/// Assemble the per-turn sections for the given context.
///
/// Order matches the prompt: the mode section first, then runtime state.
pub fn dynamic_sections(ctx: &DynamicContext) -> Vec<Section> {
    let mut sections = Vec::new();

    match ctx.mode {
        PromptMode::Planning => sections.push(Section {
            name: "planning_mode",
            text: PLANNING_SECTION.to_string(),
        }),
        PromptMode::Interactive => sections.push(Section {
            name: "language",
            text: LANGUAGE_SECTION.to_string(),
        }),
        PromptMode::Headless | PromptMode::Readonly => {}
    }

    if ctx.sandbox {
        sections.push(Section {
            name: "sandbox",
            text: SANDBOX_SECTION.to_string(),
        });
    }

    if !ctx.variables.is_empty() {
        sections.push(Section {
            name: "variables",
            text: variables_text(&ctx.variables),
        });
    }

    sections
}

pub(crate) fn prompt_mode(mode: crate::agent::tools::ToolMode) -> PromptMode {
    use crate::agent::tools::ToolMode;
    match mode {
        ToolMode::Interactive => PromptMode::Interactive,
        ToolMode::Planning => PromptMode::Planning,
        ToolMode::Headless => PromptMode::Headless,
        ToolMode::Readonly => PromptMode::Readonly,
    }
}
