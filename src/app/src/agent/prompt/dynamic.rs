//! Per-turn prompt sections appended after the static base.
//!
//! The static base (see [`super::SystemPrompt::base`]) is built once and stays
//! constant for the process. These sections vary per request — by interaction
//! mode (language for a human at the terminal, finishing-work and reporting
//! rules for unattended runs) and by runtime state (sandbox, variables) — so
//! they live after the prompt-cache boundary and are recomputed each turn.
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
    /// Oneshot / API / channel-driven, no human to converse with.
    Headless,
    /// Forked, read-only conversation.
    Readonly,
    /// Tool-free conversation: no shell, so sandbox and variable notes are moot.
    Chat,
}

/// Runtime inputs that decide which dynamic sections apply this turn.
pub struct DynamicContext {
    pub mode: PromptMode,
    pub sandbox: bool,
    pub variables: Vec<String>,
}

/// Response-language guideline. Meaningful only for a human at the terminal,
/// so it rides on [`PromptMode::Interactive`].
const LANGUAGE_SECTION: &str = "\
Use the language established by the user's requests and preferences. \
Runtime notifications and tool output do not change that language. \
Technical terms, code, identifiers, file paths, and command names stay \
in their original form — never translate them.";

/// Headless runs have nobody to say "continue": a turn that ends with doable
/// work left is a failed task. Ordinary obstacles are worked through;
/// deliberate blockers are reported, and risky actions still need confirmation.
const FINISHING_WORK_SECTION: &str = "\
# Finishing work\n\
Avoid stopping while you still owe work the user asked for. Be persistent and \
do not stop unless needed. Carry on with work that does not depend on the \
user's answer; status notes are welcome, but do not end the turn to invite \
redirection or offer to wait.\n\
You may meet ordinary obstacles like errors, timeouts, locked files, empty \
results or failing tools. Diagnose them first, and when they are not real \
blockers, work through them with the access you have (wait and retry, fix the \
request, use another tool or source) rather than stopping.\n\
If someone clearly decided something is a hard blocker, such as a file marked \
not to be touched, access that was intentionally withheld, or a safety \
guardrail, leave it alone, say plainly what you found, and look for another \
safe way to finish the task. Stop early only when the task cannot move forward \
without user input, or when the blocker is deliberate and should not be worked \
past. This does not override the need for confirmation on risky or destructive \
actions.";

/// Headless output is delivered to readers who never saw the tool calls, so the
/// final message has to stand on its own.
const COMMUNICATING_SECTION: &str = "\
# Communicating clearly\n\
Write for an intelligent but low-context reader who has not seen your tool \
calls, your reasoning or the files you opened. Messages should be \
self-contained: put the key points in the first few sentences, and do not use \
references or ideas in line 1 that only make sense after line 12.\n\
Use plain words and clear full sentences. Do not use a term or abbreviation \
you made up during the work; say what the thing is. Prefer short sentences, \
one idea per sentence, active voice, and the same word for the same thing. Use \
flowing prose where ideas connect and bullets for lists of separate items. \
Leave out unnecessary details, but keep the key context.";

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
        PromptMode::Interactive => sections.push(Section {
            name: "language",
            text: LANGUAGE_SECTION.to_string(),
        }),
        PromptMode::Headless => {
            sections.push(Section {
                name: "finishing_work",
                text: FINISHING_WORK_SECTION.to_string(),
            });
            sections.push(Section {
                name: "communicating",
                text: COMMUNICATING_SECTION.to_string(),
            });
        }
        PromptMode::Readonly => {}
        // Sandbox rules and variable names only matter to a shell.
        PromptMode::Chat => return sections,
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
        ToolMode::Headless => PromptMode::Headless,
        ToolMode::Readonly => PromptMode::Readonly,
        ToolMode::Chat => PromptMode::Chat,
    }
}
