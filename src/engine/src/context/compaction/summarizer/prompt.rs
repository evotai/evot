//! Summarization prompts — system prompt and user prompt templates.

/// System prompt for all summarization calls.
pub const SYSTEM_PROMPT: &str = "\
You are a context summarization assistant. Your task is to read a conversation \
between a user and an AI coding assistant, then produce a structured summary \
following the exact format specified.\n\n\
Do NOT continue the conversation. Do NOT respond to any questions in the \
conversation. ONLY output the structured summary wrapped in <summary> tags.\n\n\
Distinguish user requests from automated <task-notification> events, even when \
both use the user role. Preserve background-task IDs, descriptions, status, and \
output locations alongside pending work. Preserve the user's language preferences.";

/// Shared output format. Deliberately short: summary generation is the slow
/// phase of compaction and output length is the dominant cost, so the prompt
/// asks for a handoff, not a transcript.
const FORMAT: &str = "\
Wrap your final summary in <summary> tags. Use this EXACT format:\n\n\
<summary>\n\
## Goal\n\
[What the user is trying to accomplish; one line per distinct task]\n\n\
## Constraints & Preferences\n\
- [User-stated constraints, preferences, language; or \"(none)\"]\n\n\
## Progress\n\
- [Completed work and key decisions with brief rationale; one line each]\n\n\
## Files and Code Sections\n\
- [Full path: what changed or why it matters; or \"(none)\"]\n\n\
## Open Issues\n\
- [Unresolved errors, blockers, pending background tasks with IDs; or \"(none)\"]\n\n\
## Current Work\n\
[The latest user request and the state needed to continue it]\n\n\
## Next Steps\n\
1. [Ordered, concrete]\n\
</summary>\n\n\
Guidelines:\n\
- Be concise: target under 600 words. Never narrate turn by turn.\n\
- Keep exact file paths, identifiers, commands, and error messages; drop tool output otherwise.\n\
- Omit anything that no longer affects the remaining work.\n\
- The summary must stand alone for an LLM resuming the task.";

/// Initial summarization prompt (no previous summary).
pub const INITIAL_PROMPT: &str = "\
The messages above are a conversation to summarize. Create a context checkpoint \
summary that another LLM will use to continue the work.\n\n";

/// Update prompt (merge new messages into existing summary).
pub const UPDATE_PROMPT: &str = "\
A previous summary exists. New messages were sent since that summary. Rewrite the \
summary so it covers both, merging rather than appending: keep goals, constraints, \
and decisions that still matter, fold completed items into Progress, and drop what \
is obsolete. The result must not grow with each update.\n\n";

/// Turn prefix summarization prompt (for split turns).
pub const TURN_PREFIX_PROMPT: &str = "\
This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.\n\n\
Summarize the prefix to provide context for the retained suffix. \
Wrap your final summary in <summary> tags.\n\n\
<summary>\n\
## Original Request\n\
[What did the user ask for in this turn?]\n\n\
## Early Progress\n\
- [Key decisions and work done in the prefix]\n\n\
## Context for Suffix\n\
- [Information needed to understand the retained recent work]\n\
</summary>\n\n\
Be concise. Focus on what's needed to understand the kept suffix.";

/// Extract the summary content from `<summary>` tags. If the LLM omits the
/// closing tag (common with truncated output), take everything after the opening
/// tag. If no tags are present, return the raw text.
pub fn extract_summary(raw: &str) -> String {
    const OPEN: &str = "<summary>";
    const CLOSE: &str = "</summary>";

    let lowercase = raw.to_ascii_lowercase();
    if let Some(start) = lowercase.find(OPEN) {
        let content_start = start + OPEN.len();
        let after_open = &raw[content_start..];
        if let Some(end) = lowercase[content_start..].find(CLOSE) {
            return after_open[..end].trim().to_string();
        }
        return after_open.trim().to_string();
    }
    raw.trim().to_string()
}

/// Append optional user guidance to the task instructions, outside the
/// `<conversation>` data block.
fn with_custom_instructions(mut prompt: String, instructions: Option<&str>) -> String {
    if let Some(instructions) = instructions.filter(|value| !value.trim().is_empty()) {
        prompt.push_str("\n\nAdditional focus: ");
        prompt.push_str(instructions.trim());
    }
    prompt
}

/// Build the user message for initial summarization.
pub fn format_initial(conversation: &str, custom_instructions: Option<&str>) -> String {
    with_custom_instructions(
        format!("<conversation>\n{conversation}\n</conversation>\n\n{INITIAL_PROMPT}{FORMAT}"),
        custom_instructions,
    )
}

/// Build the user message for incremental update.
pub fn format_update(
    conversation: &str,
    previous_summary: &str,
    custom_instructions: Option<&str>,
    previous_summary_over_soft_cap: bool,
) -> String {
    let length_guidance = if previous_summary_over_soft_cap {
        "\n\nIMPORTANT: Keep the updated summary near the current summary's length. \
         Condense or remove the least important details while preserving goals, \
         decisions, file paths, unresolved work, and the latest state."
    } else {
        ""
    };
    with_custom_instructions(
        format!(
            "<conversation>\n{conversation}\n</conversation>\n\n\
             <previous-summary>\n{previous_summary}\n</previous-summary>\n\n\
             {UPDATE_PROMPT}{FORMAT}{length_guidance}"
        ),
        custom_instructions,
    )
}

/// Build the user message for turn prefix summarization. `/compact`
/// instructions apply to the split prefix as well as to the history.
pub fn format_turn_prefix(turn_prefix_text: &str, custom_instructions: Option<&str>) -> String {
    with_custom_instructions(
        format!("<conversation>\n{turn_prefix_text}\n</conversation>\n\n{TURN_PREFIX_PROMPT}"),
        custom_instructions,
    )
}
