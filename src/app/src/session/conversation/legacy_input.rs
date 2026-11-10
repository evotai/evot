//! Read-only adapter for pre-provenance input. The old transport embedded
//! complete runtime envelopes after user text, sometimes in a single flattened
//! text block. Interpret that reserved protocol only at a trailing line boundary;
//! do not match English payloads, inline tags, code fences or a bare XML example.
use evot_engine::InputSource;

use super::input::InputPart;

const ENVELOPES: [&str; 2] = ["system-reminder", "task-notification"];

pub(super) fn parts(text: &str) -> Vec<InputPart> {
    let mut prefix = text;
    let mut suffixes = Vec::new();
    loop {
        let trimmed = prefix.trim_end();
        let candidate = ENVELOPES.iter().find_map(|tag| {
            if !trimmed.ends_with(&format!("\n</{tag}>")) {
                return None;
            }
            let start = trimmed.rfind(&format!("\n<{tag}>"))?;
            let before = &trimmed[..start];
            if before.trim().is_empty() || in_code_fence(before) {
                return None;
            }
            let block = &trimmed[start + 1..];
            if !envelope(block, tag) {
                return None;
            }
            Some((before, block))
        });
        let Some((before, block)) = candidate else {
            break;
        };
        suffixes.push(InputPart {
            source: InputSource::Runtime {
                kind: "legacy_context".into(),
                display: None,
            },
            text: block.into(),
        });
        prefix = before;
    }
    let mut result = vec![InputPart {
        source: InputSource::User,
        text: if suffixes.is_empty() {
            text.into()
        } else {
            prefix.trim_end().into()
        },
    }];
    result.extend(suffixes.into_iter().rev());
    result
}

fn envelope(text: &str, tag: &str) -> bool {
    let normalized = text.replace("\r\n", "\n");
    normalized
        .strip_prefix(&format!("<{tag}>\n"))
        .and_then(|body| body.strip_suffix(&format!("\n</{tag}>")))
        .is_some_and(|body| {
            !body.contains(&format!("<{tag}>")) && !body.contains(&format!("</{tag}>"))
        })
}

fn in_code_fence(text: &str) -> bool {
    let mut open: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        let Some(marker @ ('`' | '~')) = trimmed.chars().next() else {
            continue;
        };
        let count = trimmed.chars().take_while(|ch| *ch == marker).count();
        if count < 3 {
            continue;
        }
        match open {
            None => open = Some((marker, count)),
            Some((expected, minimum))
                if marker == expected && count >= minimum && trimmed[count..].trim().is_empty() =>
            {
                open = None
            }
            _ => {}
        }
    }
    open.is_some()
}
