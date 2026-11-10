//! The `<command>` envelope a host wraps expanded commands in, and what a
//! stored user turn says in the user's own words.

/// Wrap a host-expanded command so readers can tell the user's line from the
/// instructions the host added. The model reads the whole message; replays,
/// titles, search digests and shared pages show `input` and fold the rest.
/// Mirrors `cli/src/session/command-envelope.ts`; keep both shapes identical.
pub fn command_prompt(name: &str, input: &str, instructions: &str) -> String {
    let name = if !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        name
    } else {
        "command"
    };
    let input = input
        .trim()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\r', "&#13;")
        .replace('\n', "&#10;");
    format!(
        "<command name=\"{name}\" input=\"{input}\">\n{}\n</command>",
        instructions.trim()
    )
}

/// A parsed command envelope; `None` for ordinary user text.
pub struct CommandEnvelope<'a> {
    pub name: &'a str,
    pub input: String,
    pub instructions: &'a str,
    /// User text that followed the envelope, if any.
    pub text: Option<&'a str>,
}

pub fn parse_command_prompt(text: &str) -> Option<CommandEnvelope<'_>> {
    let rest = text.strip_prefix("<command name=\"")?;
    let name_end = rest.find('"')?;
    let name = &rest[..name_end];
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return None;
    }
    let rest = rest[name_end..].strip_prefix("\" input=\"")?;
    let input_end = rest.find('"')?;
    let raw_input = &rest[..input_end];
    if raw_input.contains('\n') {
        return None;
    }
    let body = rest[input_end..].strip_prefix("\">\n")?;
    let close = body.find("\n</command>")?;
    let instructions = &body[..close];
    let tail = &body[close + "\n</command>".len()..];
    let text = match tail {
        "" => None,
        _ => {
            let text = tail.strip_prefix("\n\n")?.trim();
            (!text.is_empty()).then_some(text)
        }
    };
    let input = raw_input
        .replace("&#10;", "\n")
        .replace("&#13;", "\r")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&");
    Some(CommandEnvelope {
        name,
        input,
        instructions,
        text,
    })
}

/// A background-task completion the host hands the model as user text. The
/// whole message must be the envelope; prose quoting the tag stays user text.
pub fn is_task_notification(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("<task-notification>\n<task-id>")
        && trimmed.ends_with("</task-notification>")
        && trimmed.matches("<task-notification>").count() == 1
}

/// What a stored user turn says in the user's own words: the typed command
/// line for an expanded command, the text itself otherwise. Host-initiated
/// turns (loop wakeups, task notifications) carry nothing the user said and
/// yield `None`.
pub fn user_facing_text(text: &str) -> Option<std::borrow::Cow<'_, str>> {
    use std::borrow::Cow;
    if is_task_notification(text) {
        return None;
    }
    match parse_command_prompt(text) {
        None => Some(Cow::Borrowed(text)),
        Some(envelope) if envelope.name == "loop-wakeup" => None,
        Some(envelope) => {
            if envelope.input.is_empty() {
                envelope.text.map(Cow::Borrowed)
            } else {
                Some(Cow::Owned(envelope.input))
            }
        }
    }
}
