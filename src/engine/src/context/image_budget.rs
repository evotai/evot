//! Outgoing-request image budget.
//!
//! Token estimates price an image at a fixed 1,200 tokens, but every inline
//! image travels as base64 in the request body. A long visual session can stay
//! far below the context window while its body exceeds a gateway's size limit
//! (HTTP 413), and that limit is hit again on every following request. This
//! keeps the newest images within a byte budget and replaces older ones with a
//! text note in the outgoing view only; the persisted transcript is untouched.

use crate::types::Content;
use crate::types::ImageSource;
use crate::types::Message;

/// Base64 bytes of inline images allowed in one request. Below the request
/// sizes observed to pass through the evot gateway (~3.8 MB) with headroom
/// for text, tool definitions and JSON framing.
pub const DEFAULT_INLINE_IMAGE_MAX_BYTES: usize = 3_584 * 1024;

/// Base64-encoded size of an image block as it will be sent. Path images use
/// the file size: the provider sends files within its dimension and size
/// limits unchanged and only shrinks larger ones, so this never undercounts.
/// Unreadable paths count as zero because the provider drops them as well.
pub fn inline_image_bytes(content: &Content) -> usize {
    let raw = match content {
        Content::Image {
            source: ImageSource::Base64 { data },
            ..
        } => return data.len(),
        Content::Image {
            source: ImageSource::Path { path },
            ..
        } => std::fs::metadata(path)
            .map(|meta| usize::try_from(meta.len()).unwrap_or(usize::MAX))
            .unwrap_or(0),
        _ => return 0,
    };
    raw.div_ceil(3).saturating_mul(4)
}

/// Keep the newest images whose combined size fits `max_bytes`; replace every
/// older image with a note. The newest image is always kept so a file the
/// model has just read stays visible even when it alone exceeds the budget.
///
/// `size_of` reports the outgoing byte size of an image block; production
/// callers pass [`inline_image_bytes`].
pub fn limit_inline_images(
    messages: Vec<Message>,
    max_bytes: usize,
    size_of: impl Fn(&Content) -> usize,
) -> Vec<Message> {
    // Walk newest first and find how many images, counted from the end, fit.
    let mut used = 0usize;
    let mut kept = 0usize;
    let mut total = 0usize;
    let mut full = false;
    for message in messages.iter().rev() {
        for block in image_carrying_content(message).iter().rev() {
            if !matches!(block, Content::Image { .. }) {
                continue;
            }
            total += 1;
            if full {
                continue;
            }
            let size = size_of(block);
            if kept > 0 && used.saturating_add(size) > max_bytes {
                full = true;
                continue;
            }
            used = used.saturating_add(size);
            kept += 1;
        }
    }
    let omit = total - kept;
    if omit == 0 {
        return messages;
    }

    // Replace the oldest `omit` images in order.
    let mut remaining = omit;
    messages
        .into_iter()
        .map(|message| {
            if remaining == 0 {
                return message;
            }
            map_content(message, |content| {
                content
                    .into_iter()
                    .map(|block| match block {
                        Content::Image { source, .. } if remaining > 0 => {
                            remaining -= 1;
                            Content::Text {
                                text: omitted_note(&source),
                            }
                        }
                        other => other,
                    })
                    .collect()
            })
        })
        .collect()
}

fn omitted_note(source: &ImageSource) -> String {
    match source {
        ImageSource::Path { path } => format!(
            "[Image omitted from this request to stay within the request size limit: {path}. Read it again if you need to see it.]"
        ),
        ImageSource::Base64 { .. } => {
            "[Image omitted from this request to stay within the request size limit.]".to_string()
        }
    }
}

fn image_carrying_content(message: &Message) -> &[Content] {
    match message {
        Message::User { content, .. } | Message::ToolResult { content, .. } => content,
        Message::Assistant { .. } => &[],
    }
}

fn map_content(message: Message, f: impl FnOnce(Vec<Content>) -> Vec<Content>) -> Message {
    match message {
        Message::User {
            content,
            timestamp,
            provenance,
        } => Message::User {
            content: f(content),
            timestamp,
            provenance,
        },
        Message::ToolResult {
            tool_call_id,
            tool_name,
            content,
            is_error,
            timestamp,
            retention,
        } => Message::ToolResult {
            tool_call_id,
            tool_name,
            content: f(content),
            is_error,
            timestamp,
            retention,
        },
        other => other,
    }
}
