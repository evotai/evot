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

/// Initial summarization prompt (no previous summary).
pub const INITIAL_PROMPT: &str = "\
The messages above are a conversation to summarize. Create a structured context \
checkpoint summary that another LLM will use to continue the work.\n\n\
Wrap your final summary in <summary> tags. Use this EXACT format:\n\n\
<summary>\n\
## Goal\n\
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]\n\n\
## Chronological Play-by-Play\n\
- Capture every significant turn in order: user messages, assistant replies, and tool invocations.\n\
- Use arrow notation to show flow, e.g. \"User requests refactor -> Assistant edits files A,B,C -> User asks for clarification\".\n\
- Paraphrase for brevity but preserve intent, technical detail, and outcomes.\n\n\
## Constraints & Preferences\n\
- [Any constraints, preferences, or requirements mentioned by user]\n\
- [Or \"(none)\" if none were mentioned]\n\n\
## Key Technical Work\n\
- [Key technical work done thus far]\n\n\
## Questions and Clarifications\n\
- [Questions the assistant asked, and clarifications the user provided]\n\
- [Or \"(none)\" if none were exchanged]\n\n\
## Files and Code Sections\n\
- [Important updated/created files with full paths and brief descriptions of changes]\n\
- [Or \"(none)\" if not applicable]\n\n\
## Error Resolution\n\
- [Errors encountered and how they were or are to be resolved]\n\
- [Or \"(none)\" if no errors were encountered]\n\n\
## Key Decisions\n\
- **[Decision]**: [Brief rationale]\n\n\
## Current Work\n\
[Details about the current task. Include the user's latest message and any context needed to continue the work.]\n\n\
## Next Steps\n\
1. [Ordered list of what should happen next]\n\n\
## Critical Context\n\
- [Any data, examples, or references needed to continue]\n\
- [Or \"(none)\" if not applicable]\n\
</summary>\n\n\
Guidelines:\n\
- Prioritize technical details over conversational elements\n\
- Maintain chronological order of events\n\
- Highlight unresolved issues and next steps clearly\n\
- Preserve exact file paths, function names, and error messages\n\
- Ensure the summary can stand alone as a reference document";

/// Update prompt (merge new messages into existing summary).
pub const UPDATE_PROMPT: &str = "\
A previous summary exists. New messages were sent since that summary. You must \
update the summary to cover these new messages.\n\n\
Wrap your final summary in <summary> tags. Use this EXACT format:\n\n\
<summary>\n\
## Goal\n\
[Preserve existing goals, add new ones if the task expanded]\n\n\
## Chronological Play-by-Play\n\
- Preserve existing play-by-play and append new turns in order\n\n\
## Constraints & Preferences\n\
- [Preserve existing, add new ones discovered]\n\n\
## Key Technical Work\n\
- [Include previously done AND newly completed work]\n\n\
## Questions and Clarifications\n\
- [Preserve existing, add new questions and clarifications]\n\n\
## Files and Code Sections\n\
- [Preserve existing, add newly updated/created files]\n\n\
## Error Resolution\n\
- [Preserve existing, add new errors and resolutions; remove resolved if no longer relevant]\n\n\
## Key Decisions\n\
- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n\
## Current Work\n\
[Update with the latest task. Include the user's latest message and context needed to continue.]\n\n\
## Next Steps\n\
1. [Update based on current state]\n\n\
## Critical Context\n\
- [Preserve important context, add new if needed]\n\
</summary>\n\n\
Guidelines:\n\
- Prioritize technical details over conversational elements\n\
- Maintain chronological order of events\n\
- Preserve exact file paths, function names, and error messages\n\
- If something is no longer relevant, you may remove it\n\
- Ensure the summary can stand alone as a reference document";

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
        format!("<conversation>\n{conversation}\n</conversation>\n\n{INITIAL_PROMPT}"),
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
             {UPDATE_PROMPT}{length_guidance}"
        ),
        custom_instructions,
    )
}

/// Build the user message for turn prefix summarization.
pub fn format_turn_prefix(turn_prefix_text: &str) -> String {
    format!("<conversation>\n{turn_prefix_text}\n</conversation>\n\n{TURN_PREFIX_PROMPT}")
}
