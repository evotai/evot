//! Bounded semantic evidence, separate from resume's flat searchable text.

use std::path::Path;

use serde::Serialize;

use crate::compact::context_view::is_compact_summary_text;
use crate::types::AssistantBlock;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

const SESSION_CHARS: usize = 3_000;
const COMPACT_CHARS: usize = 1_200;

/// Ephemeral prompt data, not a persistent or addon contract.
#[derive(Debug, Serialize)]
pub struct SessionDigest {
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<String>,
    pub messages: Vec<MessageExcerpt>,
    pub omitted_messages: usize,
}

#[derive(Debug, Serialize)]
pub struct MessageExcerpt {
    pub role: &'static str,
    pub text: String,
}

impl SessionDigest {
    pub fn build(session: &SessionMeta, entries: &[TranscriptEntry]) -> Option<Self> {
        if !entries
            .iter()
            .any(|entry| real_user_text(&entry.item).is_some())
        {
            return None;
        }
        let compact =
            entries
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, entry)| match &entry.item {
                    TranscriptItem::Compact {
                        summary, messages, ..
                    } if !summary.trim().is_empty() => {
                        Some((index, summary.as_str(), messages.as_slice()))
                    }
                    _ => None,
                });
        let start = compact.map_or(0, |(index, _, _)| index + 1);
        // Compaction can leave a real conversation tail outside its summary.
        // Include that retained tail before newly appended messages, skipping
        // the synthetic summary user turn through the same excerpt extractor.
        let retained = compact.map_or(&[][..], |(_, _, messages)| messages);
        let excerpts: Vec<_> = retained
            .iter()
            .chain(entries[start..].iter().map(|entry| &entry.item))
            .filter_map(message_excerpt)
            .collect();
        let project = Path::new(&session.cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let mut digest = Self {
            session_id: session.session_id.clone(),
            title: excerpt(session.display_title().unwrap_or("Untitled"), 200),
            updated_at: session.updated_at.clone(),
            project: excerpt(project, 100),
            compact: compact.map(|(_, summary, _)| compact_excerpt(summary)),
            messages: Vec::new(),
            omitted_messages: excerpts.len(),
        };

        // Select by importance, then restore chronological order. Retain the
        // outcome first, user intent from both ends next, other replies last.
        let final_reply = excerpts
            .iter()
            .rposition(|message| message.role == "assistant");
        let users: Vec<_> = excerpts
            .iter()
            .enumerate()
            .filter_map(|(index, message)| (message.role == "user").then_some(index))
            .collect();
        let mut priority = Vec::new();
        if let Some(index) = final_reply {
            priority.push(index);
        }
        for offset in 0..users.len().div_ceil(2) {
            priority.push(users[offset]);
            let tail = users.len() - 1 - offset;
            if tail != offset {
                priority.push(users[tail]);
            }
        }
        priority.extend(
            excerpts
                .iter()
                .enumerate()
                .rev()
                .filter_map(|(index, message)| {
                    (message.role == "assistant" && Some(index) != final_reply).then_some(index)
                }),
        );
        let mut selected = Vec::new();
        for index in priority {
            let message = &excerpts[index];
            digest.messages.push(MessageExcerpt {
                role: message.role,
                text: message.text.clone(),
            });
            digest.omitted_messages -= 1;
            if serialized_chars(&digest) > SESSION_CHARS {
                digest.messages.pop();
                digest.omitted_messages += 1;
            } else {
                selected.push(index);
            }
        }
        // Selected excerpts were temporarily inserted in priority order.
        selected.sort_unstable();
        digest.messages = selected
            .into_iter()
            .map(|index| {
                let message = &excerpts[index];
                MessageExcerpt {
                    role: message.role,
                    text: message.text.clone(),
                }
            })
            .collect();
        Some(digest)
    }
}

fn real_user_text(item: &TranscriptItem) -> Option<&str> {
    match item {
        TranscriptItem::User { text, .. }
            if !text.trim().is_empty() && !is_compact_summary_text(text) =>
        {
            Some(text)
        }
        _ => None,
    }
}

fn message_excerpt(item: &TranscriptItem) -> Option<MessageExcerpt> {
    if let Some(text) = real_user_text(item) {
        return Some(MessageExcerpt {
            role: "user",
            text: excerpt(text, 300),
        });
    }
    let TranscriptItem::Assistant { content, .. } = item else {
        return None;
    };
    let text = content
        .iter()
        .filter_map(AssistantBlock::text)
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then(|| MessageExcerpt {
        role: "assistant",
        text: excerpt(&text, 200),
    })
}

/// Keep intent and conclusions when a long pasted message needs clipping.
fn excerpt(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = text.chars().count();
    if count <= max {
        return text;
    }
    let marker = " …[truncated]… ";
    let available = max.saturating_sub(marker.chars().count());
    let head: String = text.chars().take(available.div_ceil(2)).collect();
    let tail: String = text.chars().skip(count - available / 2).collect();
    format!("{head}{marker}{tail}")
}

fn compact_excerpt(summary: &str) -> String {
    // Section names are hints, not a schema. Unknown summary formats still
    // contribute a representative excerpt instead of disappearing.
    let mut sections = Vec::new();
    let mut current = String::new();
    let mut relevant = false;
    for line in summary.lines() {
        if line.starts_with('#') {
            if relevant && !current.trim().is_empty() {
                sections.push(std::mem::take(&mut current));
            }
            current.clear();
            let heading = line.trim_start_matches('#').trim().to_lowercase();
            relevant = matches!(
                heading.as_str(),
                "goal"
                    | "original request"
                    | "key decisions"
                    | "current work"
                    | "early progress"
                    | "summary"
                    | "outcome"
            );
        }
        if relevant {
            current.push_str(line);
            current.push('\n');
        }
    }
    if relevant && !current.trim().is_empty() {
        sections.push(current);
    }
    if sections.is_empty() {
        excerpt(summary, COMPACT_CHARS)
    } else {
        // Bound each section before combining so a verbose Goal cannot crowd
        // out the session's decisions and outcome.
        let per_section = COMPACT_CHARS / sections.len();
        let text = sections
            .iter()
            .map(|section| excerpt(section, per_section.max(40)))
            .collect::<Vec<_>>()
            .join("\n");
        excerpt(&text, COMPACT_CHARS)
    }
}

fn serialized_chars(digest: &SessionDigest) -> usize {
    // These structs contain only strings and integers; serialization cannot
    // fail. Keep explicit handling rather than panicking on that assumption.
    match serde_json::to_string(digest) {
        Ok(text) => text.chars().count(),
        Err(_) => usize::MAX,
    }
}
