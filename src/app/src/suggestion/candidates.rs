use super::SuggestionHints;
use super::SuggestionMessage;

const MAX_CANDIDATES: usize = 3;
pub(super) const MAX_CANDIDATE_CHARS: usize = 160;

/// Shared by the final response and completed candidates from the stream.
/// A partial string is never passed to this validator.
pub(super) fn validated(
    text: &str,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
) -> Vec<String> {
    let draft = hints.draft();
    let suffix = hints.suffix.as_deref();
    let original =
        suffix.map(|suffix| format!("{}{suffix}", hints.draft.as_deref().unwrap_or_default()));
    let reference = original
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .or(draft);
    let prose = reference.map(super::references::prose);
    let mut references: Vec<&str> = prose
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .into_iter()
        .collect();
    let draft_prose = super::references::prose(draft.unwrap_or_default());
    if draft.is_none()
        || (draft_prose.trim().is_ascii() && !draft_prose.trim().contains(char::is_whitespace))
    {
        if let Some(user) = messages.iter().rev().find(|message| message.role == "user") {
            references.push(&user.text);
        }
    }
    if references.is_empty() && prose.is_some() {
        references.push(""); // Attachment-only new draft: use the default language.
    }
    candidates(
        text,
        &references,
        draft,
        suffix,
        hints.command.as_ref().map(|command| command.name.as_str()),
    )
}

/// Legacy completion uses one full message per line. Cursor rewrites use JSON
/// strings containing only replacement suffixes, preserving spaces/newlines.
pub(super) fn candidates(
    text: &str,
    references: &[&str],
    draft: Option<&str>,
    suffix: Option<&str>,
    command: Option<&str>,
) -> Vec<String> {
    let raw = if suffix.is_some() {
        match serde_json::from_str::<Vec<String>>(text.trim()) {
            Ok(candidates) => candidates,
            Err(_) => return Vec::new(),
        }
    } else {
        text.lines()
            .filter_map(|line| filter(line, draft.is_some()))
            .collect()
    };
    let mut out: Vec<String> = Vec::new();
    let original = format!(
        "{}{}",
        draft.unwrap_or_default(),
        suffix.unwrap_or_default()
    );
    for candidate in raw {
        if suffix.is_some()
            && (candidate.trim().is_empty()
                || candidate.chars().any(|ch| ch.is_control() && ch != '\n')
                || suffix == Some(candidate.as_str()))
        {
            continue;
        }
        let full = if suffix.is_some() {
            format!("{}{candidate}", draft.unwrap_or_default())
        } else {
            candidate.clone()
        };
        if !super::references::preserved(&original, &full) {
            continue;
        }
        if command.is_some_and(|name| full.split_whitespace().next() != Some(name)) {
            continue;
        }
        // Script checking uses the complete message, not an isolated code name.
        if !full.starts_with('/')
            && !references
                .iter()
                .any(|reference| language_matches(reference, &full))
        {
            continue;
        }
        let candidate = if suffix.is_none() {
            match draft {
                Some(draft) => match continuation(&candidate, draft) {
                    Some(rest) => rest,
                    None => continue,
                },
                None => candidate,
            }
        } else {
            candidate
        };
        if candidate.chars().count() > MAX_CANDIDATE_CHARS
            || out
                .iter()
                .any(|existing| same_intent_text(existing, &candidate))
        {
            continue;
        }
        out.push(candidate);
        if out.len() == MAX_CANDIDATES {
            break;
        }
    }
    out
}

/// Catch obvious script switches even if the model disregards the language
/// instruction. Natural-language identity (e.g. English vs French) remains
/// the model's job; identifiers and inline/fenced code are not evidence.
fn language_matches(reference: &str, suggestion: &str) -> bool {
    let reference = super::references::prose(reference);
    let suggestion = super::references::prose(suggestion);
    let prose = reference
        .split('`')
        .step_by(2)
        .collect::<Vec<_>>()
        .join(" ");
    let script = |ch: char| match ch {
        '\u{3040}'..='\u{30ff}' => 1, // kana
        '\u{ac00}'..='\u{d7af}' => 2, // hangul
        '\u{4e00}'..='\u{9fff}' => 3, // han
        '\u{0400}'..='\u{052f}' => 4, // cyrillic
        '\u{0600}'..='\u{06ff}' => 5, // arabic
        '\u{0900}'..='\u{097f}' => 6, // devanagari
        _ => 0,
    };
    // Kana takes priority over shared Han; do not mistake Japanese for Chinese.
    let expected = if prose.chars().any(|ch| script(ch) == 1) {
        1
    } else if prose.chars().any(|ch| script(ch) == 2) {
        2
    } else {
        prose
            .chars()
            .map(script)
            .find(|value| *value != 0)
            .unwrap_or(0)
    };
    if expected == 0 {
        !suggestion.chars().any(|ch| script(ch) != 0)
    } else {
        suggestion.chars().any(|ch| script(ch) == expected)
    }
}

fn same_intent_text(left: &str, right: &str) -> bool {
    let normalize = |text: &str| {
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    normalize(left) == normalize(right)
}

/// Preserve the exact append text, including its leading space. Guessing
/// word boundaries breaks partial words ("Run t" + "ests") and punctuation.
fn continuation(candidate: &str, draft: &str) -> Option<String> {
    let rest = candidate.strip_prefix(draft.trim_start())?.trim_end();
    (!rest.trim().is_empty()).then(|| rest.to_string())
}

fn filter(text: &str, completing: bool) -> Option<String> {
    // Tolerate list markers even though the prompt forbids them.
    let text = text.trim();
    let text = text
        .strip_prefix(|ch: char| matches!(ch, '-' | '*' | '•'))
        .or_else(|| {
            text.trim_start_matches(|ch: char| ch.is_ascii_digit())
                .strip_prefix(['.', ')'])
                .filter(|_| text.starts_with(|ch: char| ch.is_ascii_digit()))
        })
        .map_or(text, str::trim);
    if text.is_empty()
        || text.eq_ignore_ascii_case("NONE")
        || text == "[]"
        || text.chars().count() > if completing { 560 } else { MAX_CANDIDATE_CHARS }
        || text.starts_with(['`', '"', '“', '<'])
        || text.chars().any(|ch| ch.is_control())
    {
        return None;
    }
    Some(text.to_string())
}
