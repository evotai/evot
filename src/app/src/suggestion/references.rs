use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

// The CLI's atomic composer references, not attachment content or file paths.
static REFERENCES: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\[(?:Image|Pasted text) #[0-9]+(?:\s\+[0-9]+ lines)?\]").ok());

pub(super) fn prose(text: &str) -> Cow<'_, str> {
    match REFERENCES.as_ref() {
        Some(pattern) => pattern.replace_all(text, " "),
        None => Cow::Borrowed(text),
    }
}

pub(super) fn preserved(original: &str, replacement: &str) -> bool {
    match REFERENCES.as_ref() {
        Some(pattern) => pattern
            .find_iter(original)
            .map(|m| m.as_str())
            .eq(pattern.find_iter(replacement).map(|m| m.as_str())),
        None => original == replacement,
    }
}

pub(super) fn instruction(prefix: &str, suffix: &str, images_attached: bool) -> &'static str {
    if images_attached {
        return "\nCOMPOSER REFERENCES: The current draft's images are attached below with matching [Image #N] labels. Use the visible images, typed text and conversation together to infer what the user wants to ask or do, rather than answering the image yourself. Do not invent unreadable details. Keep every existing image or pasted-text reference exactly once in order and never invent new references. Markers are not English prose and do not determine the user's language.";
    }
    if prose(prefix) == prefix && prose(suffix) == suffix {
        return "";
    }
    "\nCOMPOSER REFERENCES: [Image #N] and [Pasted text #N] are opaque attachment markers, not English prose. Their contents are not provided to this suggestion request. Help phrase the user's intent using the surrounding text and conversation; never claim to see or infer image details. Keep every existing reference exactly once in the same order, and do not invent references. Markers alone do not determine the user's language."
}
