use evot_engine::provider::StreamConfig;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::StopReason;
use evot_engine::ThinkingLevel;

use super::SuggestionEndpoint;
use super::SuggestionHints;
use super::SuggestionMessage;

const HISTORY_TOKENS: usize = 4_096;
const TOKEN_HEADROOM: usize = 1_024;
/// Enough output for three short replies, including CJK.
const OUTPUT_TOKENS: u32 = 192;
const REWRITE_OUTPUT_TOKENS: u32 = 320;

// Prediction is deliberately a small side request, not the coding agent.
const INSTRUCTIONS: &str = r#"[SUGGESTION MODE: Suggest what the user might naturally type next into evot.]

Predict what the USER intends to type, not an assistant response. A task may still be running or interrupted; do not assume it finished.
THE TEST: Would they think "I was just about to type that"?

1. A DRAFT IN PROGRESS is the strongest evidence of intent. Keep its prefix exact, even when the user changes direction.
2. Otherwise, THE LATEST ASSISTANT MESSAGE MATTERS MOST when it asks a question that is still unanswered, offers choices or requests confirmation: suggest direct replies covering different options. Later tool execution may have overtaken that message; use workflow chronology, not the last prose alone.
3. Use the current workflow stage to select the next intention, not merely the last task detail. Follow recent user goals, not unrelated new tasks.
4. An answered turn is not proof that the overall goal is complete. Reports about remote work in progress, pending results or concrete next steps can support a next intention without a question mark. A completed request need not have a next message. Before suggesting, identify a real unresolved decision, requirement or new intent. Do not turn the user's original request back into a question about whether the delivered feature works, repeat facts just answered, or ask for tests/review already reported complete. Delivery notes are not a request for approval. Without clear remaining intent, return no candidates; an empty composer is not an invitation to invent follow-up work. An explicit draft or attached image can establish a new intent and still takes priority.

Do not invent missing personal details, paths, credentials, facts or preferences. Questions and clarification requests must address genuine unknowns; discard any candidate whose answer is already in the recent conversation. Avoid generic praise, assistant-voice and explanations. Give up to 3 distinct, concise intentions, most likely first; fewer is fine. Usually 2-12 words each, without a word minimum for short answers or CJK. Differences must change the action, scope or constraint, not just politeness or word order. Keep fewer strong options rather than padding near-duplicates; do not force a stop/cancel option without context.

LANGUAGE IS MANDATORY: use the draft's language, or the most recent user message when the draft is only an identifier or absent. Infer language from prose, not code, paths, identifiers or product names; never switch to the assistant's language."#;

const LINE_FORMAT: &str = "\n\nOUTPUT FORMAT: Reply with up to 3 distinct suggestions, one per line, most likely first. No numbering, bullets, quotes or explanation. Stay silent if no clearly supported continuation exists.";

/// When the user has typed part of a message, candidates must continue it.
/// The reply is the whole message so the model reads naturally; the prefix is
/// stripped locally before ghost text is shown.
fn draft_instruction(draft: &str) -> String {
    format!(
        "\n\nDRAFT IN PROGRESS (literal prefix, including its spaces):\n{draft}\nReturn complete messages starting with this exact prefix and naturally finishing the user's intent. Do not rewrite the prefix."
    )
}

fn rewrite_instruction(prefix: &str, suffix: &str) -> Option<String> {
    // JSON preserves caret-adjacent spaces and multi-line input unambiguously.
    let context =
        serde_json::to_string(&serde_json::json!({ "prefix": prefix, "suffix": suffix })).ok()?;
    Some(format!(
        "\n\nCURSOR REWRITE MODE: the editor contains this literal text around the caret:\n{context}\nKeep prefix EXACTLY unchanged; replace, do not append to, the old suffix. An empty prefix means rewriting the whole draft.\nOUTPUT FORMAT: ONLY a JSON array of up to 3 replacement suffix strings, never the prefix. Preserve needed leading spaces, partial words and escaped line breaks. Do not repeat the old suffix; use [] when no clearly supported improvement or next intent exists."
    ))
}

/// A contiguous recent suffix, independently bounded from callers. Like
/// Codex, skip sampling if the prompt cannot leave 1024 tokens of headroom.
pub fn prompt_config(
    endpoint: &SuggestionEndpoint,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
) -> Option<StreamConfig> {
    let draft = hints.draft();
    let rewriting = hints.suffix.is_some();
    if draft.is_some_and(|draft| {
        (draft.trim_start().starts_with('/') && hints.command.is_none())
            || (!rewriting && (draft.chars().count() > 400 || draft.contains('\n')))
    }) {
        return None;
    }
    let recovering = hints
        .workflow
        .as_ref()
        .is_some_and(|workflow| workflow.recoverable());
    if !hints.is_explicit() && !recovering && messages.last()?.role != "assistant" {
        return None;
    }
    if messages
        .iter()
        .any(|m| !matches!(m.role.as_str(), "user" | "assistant"))
    {
        return None;
    }
    let window = if endpoint.context_window == 0 {
        8192
    } else {
        endpoint.context_window as usize
    };
    // Same shape as Codex: a recent native-message suffix followed by one
    // prediction instruction. Never reintroduce the start of a long session.
    let draft_section = match hints.suffix.as_deref() {
        Some(suffix) => rewrite_instruction(hints.draft.as_deref().unwrap_or_default(), suffix)?,
        None => format!(
            "{}{LINE_FORMAT}",
            draft.map(draft_instruction).unwrap_or_default()
        ),
    };
    let command_section = if let Some(command) = &hints.command {
        let metadata = serde_json::to_string(command).ok()?;
        format!("\n\nCOMMAND ARGUMENT ASSISTANCE: the user is typing this registered command:\n{metadata}\nKeep the command and prefix unchanged. Complete arguments per this usage and the user's intent; never execute, change commands or invent IDs, paths or flags. Add a leading space if an argument follows the bare command name.")
    } else {
        String::new()
    };
    // Legacy activity is only a fallback; workflow is the authoritative state.
    let activity = match hints
        .workflow
        .as_ref()
        .map(|workflow| workflow.runtime.execution.as_str())
        .or(hints.activity.as_deref())
    {
        Some("running" | "retrying") => {
            "\nCurrent task state: running. The user may steer without waiting for completion."
        }
        Some("waiting") => "\nCurrent task state: waiting. Do not assume the task has completed.",
        _ => "",
    };
    let workflow_section = match &hints.workflow {
        Some(workflow) => workflow.instruction()?,
        None => String::new(),
    };
    let references = super::references::instruction(
        hints.draft.as_deref().unwrap_or_default(),
        hints.suffix.as_deref().unwrap_or_default(),
        !hints.images.is_empty(),
    );
    let images = super::images::content(hints)?;
    let final_instruction = format!(
        "<next_prompt_suggestion>\n{INSTRUCTIONS}{workflow_section}{draft_section}{command_section}{activity}{references}\n</next_prompt_suggestion>"
    );
    let fixed_tokens = evot_engine::context::estimate_tokens(&final_instruction)
        + evot_engine::context::content_tokens(&images)
        + 64;
    // Images are user input, not history: reserve their budget rather than
    // silently dropping them or overflowing when several images are pasted.
    let budget = if images.is_empty() {
        HISTORY_TOKENS
    } else {
        HISTORY_TOKENS.min(window.saturating_sub(TOKEN_HEADROOM + fixed_tokens + 64))
    };
    let recent = recent_context(messages, budget)?;
    if !hints.is_explicit()
        && ((!recovering && !recent.iter().any(|message| message.role == "assistant"))
            || !recent.iter().any(|message| message.role == "user"))
    {
        return None;
    }
    let input_tokens = recent
        .iter()
        .map(|message| evot_engine::context::estimate_tokens(&message.text) + 16)
        .sum::<usize>()
        + fixed_tokens;
    if input_tokens >= window.saturating_sub(TOKEN_HEADROOM) {
        return None;
    }
    let mut native_messages: Vec<Message> = recent
        .iter()
        .map(|message| {
            if message.role == "user" {
                Message::user(message.text.clone())
            } else {
                Message::Assistant {
                    content: vec![Content::Text {
                        text: message.text.clone(),
                    }],
                    stop_reason: StopReason::Stop,
                    model: String::new(),
                    provider: String::new(),
                    usage: Default::default(),
                    timestamp: 0,
                    error_message: None,
                    response_id: None,
                }
            }
        })
        .collect();
    let mut instruction = Message::user(final_instruction);
    if let Message::User { content, .. } = &mut instruction {
        content.extend(images);
    }
    native_messages.push(instruction);
    let protocol = endpoint.parsed_protocol()?;
    let output_tokens = if rewriting {
        REWRITE_OUTPUT_TOKENS
    } else {
        OUTPUT_TOKENS
    };
    let model_config = crate::conf::resolve_model_config(
        protocol,
        "evot-suggestion",
        &endpoint.model,
        Some(&endpoint.base_url),
        Default::default(),
        Default::default(),
        (endpoint.context_window > 0).then_some(endpoint.context_window),
        Some(output_tokens),
        Some(!hints.images.is_empty()),
    );
    Some(StreamConfig {
        model: endpoint.model.clone(),
        api_key: endpoint.api_key.clone(),
        system_prompt: String::new(),
        messages: native_messages,
        tools: Vec::new(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: Some(output_tokens),
        model_config: Some(model_config),
        cache_config: Default::default(),
        prompt_cache_key: None,
        client: None,
    })
}

fn message_tokens(message: &SuggestionMessage) -> Option<usize> {
    Some(evot_engine::context::estimate_tokens(
        &serde_json::to_string(message).ok()?,
    ))
}

/// Match the UI budget defensively for direct addon callers too. Never drop a
/// final question just because the answer before it is long.
fn recent_context(messages: &[SuggestionMessage], budget: usize) -> Option<Vec<SuggestionMessage>> {
    let latest_user = messages.iter().rposition(|message| message.role == "user");
    let mut recent = Vec::new();
    let mut remaining = budget;
    for (index, original) in messages.iter().enumerate().rev() {
        if original.text.trim().is_empty() {
            return None;
        }
        let reserve = if index + 1 == messages.len() {
            match latest_user {
                Some(index) => message_tokens(&messages[index])?.min(1024),
                None => 0,
            }
        } else {
            0
        };
        let budget = remaining.saturating_sub(reserve);
        let mut message = original.clone();
        if message_tokens(&message)? > budget {
            if index + 1 != messages.len() && Some(index) != latest_user {
                break;
            }
            let chars: Vec<char> = message.text.chars().collect();
            let mut low = 0;
            let mut high = chars.len().min(budget * 4);
            message.text.clear();
            while low <= high {
                let keep = (low + high) / 2;
                let head = keep / 5;
                let candidate = SuggestionMessage {
                    role: original.role.clone(),
                    text: format!(
                        "{}\n[... middle omitted ...]\n{}",
                        chars[..head].iter().collect::<String>(),
                        chars[chars.len() - (keep - head)..]
                            .iter()
                            .collect::<String>()
                    ),
                };
                if message_tokens(&candidate)? <= budget {
                    message = candidate;
                    low = keep + 1;
                } else {
                    if keep == 0 {
                        break;
                    }
                    high = keep - 1;
                }
            }
        }
        if message.text.is_empty() {
            break;
        }
        remaining = remaining.saturating_sub(message_tokens(&message)?);
        recent.push(message);
    }
    recent.reverse();
    Some(recent)
}
