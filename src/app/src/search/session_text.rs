use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionWithText {
    #[serde(flatten)]
    pub session: SessionMeta,
    pub search_text: String,
    /// Real user turns, oldest first — what the session was actually asked to
    /// do. `search_text` flattens every role into one blob, so a UI that wants
    /// to show only the user's side of the conversation cannot recover it from
    /// there.
    pub user_prompts: Vec<String>,
    /// The first real user turn, kept even when `user_prompts` is trimmed to the
    /// tail of a long session: it says what the session set out to do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    /// Paths passed to edit/write tool calls, deduplicated in first-seen order.
    /// What the session actually changed — the most reliable recognition
    /// signal after the prompts themselves.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_paths: Vec<String>,
}

impl SessionWithText {
    /// Derive every searchable and displayable field from one transcript.
    ///
    /// The single extraction point for both the resume list and its preview
    /// pane: a second implementation elsewhere would let the same session read
    /// differently depending on which load populated it.
    pub fn extract(session: SessionMeta, entries: &[TranscriptEntry]) -> Self {
        Self {
            search_text: collect_search_text(&session, entries),
            user_prompts: collect_user_prompts(entries),
            first_prompt: collect_first_prompt(entries),
            changed_paths: collect_changed_paths(entries),
            session,
        }
    }
}

/// Max characters of combined transcript body included per session in the
/// flat `search_text`. Metadata (id/title/cwd/source/model) is always included
/// on top of this budget.
const TRANSCRIPT_TEXT_BUDGET: usize = 6000;

/// Most recent user turns kept per session. A resume UI shows a handful of
/// lines, so collecting every prompt of a 900-turn session only costs memory.
const USER_PROMPT_LIMIT: usize = 24;

/// Max characters kept per user turn. Long pasted prompts are truncated: the
/// point is recognizing the session, not reading it back.
const USER_PROMPT_MAX_CHARS: usize = 300;

/// The session's real user turns, oldest first, newest-biased when truncated.
/// Compaction's synthetic summary prompt is skipped — it is boilerplate the
/// user never typed.
fn collect_user_prompts(entries: &[TranscriptEntry]) -> Vec<String> {
    let mut prompts: Vec<String> = Vec::new();
    for entry in entries {
        let TranscriptItem::User { text, .. } = &entry.item else {
            continue;
        };
        if crate::compact::context_view::is_compact_summary_text(text) {
            continue;
        }
        let text = normalize_ws(text);
        if text.is_empty() {
            continue;
        }
        prompts.push(clip_head(&text, USER_PROMPT_MAX_CHARS));
    }
    // Keep the tail: the latest turns say where the session left off, which is
    // what a user scanning a resume list is trying to recall.
    if prompts.len() > USER_PROMPT_LIMIT {
        prompts.drain(..prompts.len() - USER_PROMPT_LIMIT);
    }
    prompts
}

/// The first real user turn, or `None` when the session has none.
fn collect_first_prompt(entries: &[TranscriptEntry]) -> Option<String> {
    entries.iter().find_map(|entry| {
        let TranscriptItem::User { text, .. } = &entry.item else {
            return None;
        };
        if crate::compact::context_view::is_compact_summary_text(text) {
            return None;
        }
        let text = normalize_ws(text);
        (!text.is_empty()).then(|| clip_head(&text, USER_PROMPT_MAX_CHARS))
    })
}

/// Distinct paths this session edited or wrote, capped so a long session's
/// list stays a summary rather than a manifest.
const CHANGED_PATH_LIMIT: usize = 32;

fn collect_changed_paths(entries: &[TranscriptEntry]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for entry in entries {
        let TranscriptItem::Assistant { content, .. } = &entry.item else {
            continue;
        };
        for block in content {
            let crate::types::AssistantBlock::ToolCall { name, input, .. } = block else {
                continue;
            };
            if !matches!(name.as_str(), "edit" | "write" | "file_edit" | "file_write") {
                continue;
            }
            let Some(path) = ["path", "file_path", "file"]
                .iter()
                .find_map(|key| input.get(key).and_then(|value| value.as_str()))
                .map(str::trim)
                .filter(|path| !path.is_empty())
            else {
                continue;
            };
            if !paths.iter().any(|seen| seen == path) {
                paths.push(path.to_string());
            }
            if paths.len() == CHANGED_PATH_LIMIT {
                return paths;
            }
        }
    }
    paths
}

fn collect_search_text(session: &SessionMeta, entries: &[TranscriptEntry]) -> String {
    let mut parts = Vec::new();
    parts.push(session.session_id.clone());
    if let Some(t) = &session.custom_title {
        parts.push(t.clone());
    }
    if let Some(t) = &session.title {
        parts.push(t.clone());
    }
    parts.push(session.cwd.clone());
    parts.push(session.source.clone());
    parts.push(session.model.clone());

    // Conversation text is more useful for recalling a session than verbose
    // command output, so give it the budget first. Thinking is searchable too:
    // it often contains details learned from images or other non-text inputs.
    let mut conversation = Vec::new();
    let mut tool_results = Vec::new();
    for entry in entries {
        collect_item_text(&entry.item, &mut conversation, &mut tool_results);
    }

    let conversation = clip_representative(&conversation.join(" "), TRANSCRIPT_TEXT_BUDGET);
    let remaining = TRANSCRIPT_TEXT_BUDGET.saturating_sub(conversation.chars().count());
    if !conversation.is_empty() {
        parts.push(conversation);
    }
    let tool_results = clip_representative(&tool_results.join(" "), remaining);
    if !tool_results.is_empty() {
        parts.push(tool_results);
    }
    parts.join(" ")
}

/// Collapse every run of whitespace (including newlines) into a single space
/// and trim the ends, so multi-line message bodies become one searchable line.
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Keep a bounded, representative excerpt from both ends of a long body.
fn clip_representative(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    if max <= 3 {
        return s.chars().take(max).collect();
    }

    let content = max - 3;
    let head = content / 2;
    let tail = content - head;
    let start: String = s.chars().take(head).collect();
    let end: String = s.chars().skip(count - tail).collect();
    format!("{start} … {end}")
}

/// Keep the opening of a body, marking a cut with a trailing ellipsis. Unlike
/// [`clip_representative`], a single user turn reads top-down: its first
/// sentence carries the intent, so the tail is what goes.
fn clip_head(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

fn collect_item_text(
    item: &TranscriptItem,
    conversation: &mut Vec<String>,
    tool_results: &mut Vec<String>,
) {
    let push = |parts: &mut Vec<String>, text: &str| {
        let text = normalize_ws(text);
        if !text.is_empty() {
            parts.push(text);
        }
    };

    match item {
        TranscriptItem::User { text, .. } | TranscriptItem::System { text } => {
            push(conversation, text);
        }
        TranscriptItem::Assistant { content, .. } => {
            for block in content {
                match block {
                    crate::types::AssistantBlock::Text { text }
                    | crate::types::AssistantBlock::Thinking { text, .. } => {
                        push(conversation, text);
                    }
                    _ => {}
                }
            }
        }
        TranscriptItem::ToolResult { content, .. } => push(tool_results, content),
        _ => {}
    }
}
