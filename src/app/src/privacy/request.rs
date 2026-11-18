//! Masking a typed LLM request and restoring its typed reply.
//!
//! Every outgoing string is reached through [`walk`]: the system prompt,
//! tool descriptions and schema data, message text, unsigned thinking and
//! tool-call arguments (string values only). Schema structure, ids, names,
//! models and keys are left.
//! Signed thinking (an Anthropic signature, a Responses item) is sent back
//! byte for byte so its signature holds; if it holds a value the user's
//! side sent, it is masked and sent as plain text without its signature.
use std::collections::HashMap;
use std::collections::HashSet;

use evot_engine::provider::StreamConfig;
use evot_engine::tools::FILE_UNCHANGED_STUB;
use evot_engine::types::Content;
use evot_engine::types::Message;
use evot_engine::types::ThinkingMetadata;
use serde_json::Value;

use super::policy::Action;
use super::policy::Mode;
use super::policy::Policy;
use super::rules::Engine;
use super::scan;
use super::scan::FileLines;
use super::scan::Hit;
use super::scan::Origin;
use super::vault::Vault;
use crate::base::error::Result;

/// Where a string sits in a request.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// What the user's side wrote or produced: prompts, messages, tool
    /// results (`sensitive` for a secrets file or `env` output).
    Inbound { sensitive: bool },
    /// What the model wrote: assistant text, tool-call arguments.
    Model,
    /// Thinking the provider signed. It goes back byte for byte unless it
    /// holds a secret, or one of the user's own terms the user's side sent
    /// too: a word the model made up is not worth the signature.
    Signed,
}

/// A visitor over one request string: the text, where it sits, the JSON
/// field holding it and its origin. Returns whether it changed the text.
type Visit<'a> = dyn FnMut(&mut String, Slot, Option<&str>, &Origin) -> bool + 'a;

/// Mask `config` in place; the hits say what was found and where.
pub(super) fn mask_config(
    policy: &Policy,
    vault: &Vault,
    config: &mut StreamConfig,
) -> Result<Vec<Hit>> {
    let sources = ToolSources::index(policy.engine.as_ref(), &config.messages);
    // What this session found before: its history may have been compacted
    // away since. Other sessions' findings are not looked for.
    let session = vault.session(config.prompt_cache_key.as_deref());
    let known = |text: &str| {
        let mut spans = vault.registered_spans(text);
        spans.extend(session.spans(text));
        spans
    };
    // Pass one finds and remembers every value, so pass two masks each one
    // wherever it is, even in a text that names it without context.
    let mut found = Vec::new();
    let mut inbound: HashSet<String> = HashSet::new();
    walk(config, &sources, &mut |text, slot, field, _| {
        let spans = scan::find(
            policy,
            text,
            slot == Slot::Inbound { sensitive: true },
            field,
        );
        for span in &spans {
            let value = &text[span.start..span.end];
            if policy.action(&span.kind, span.confidence) != Action::Warn && !policy.allows(value) {
                vault.discover(
                    &session,
                    &span.kind,
                    value,
                    policy.engine.known.min_secret_len,
                );
            }
        }
        if matches!(slot, Slot::Inbound { .. }) {
            let known = known(text);
            inbound.extend(
                spans
                    .iter()
                    .chain(&known)
                    .map(|s| text[s.start..s.end].to_string()),
            );
        }
        found.push(spans);
        false
    });
    let mut hits = Vec::new();
    let mut hidden_labels = HashSet::new();
    let mut preview_hidden = HashSet::new();
    let mut found = found.into_iter();
    let mut error = None;
    walk(config, &sources, &mut |text, slot, _, origin| {
        if error.is_some() {
            return false;
        }
        let mut spans = found.next().unwrap_or_default();
        spans.extend(known(text));
        if slot == Slot::Signed {
            // A secret never goes back for a signature's sake, wherever it
            // came from; a user's term only when the user's side sent it.
            spans.retain(|s| policy.is_secret(&s.kind) || inbound.contains(&text[s.start..s.end]));
        }
        let put = |kind: &str, value: &str| vault.put(kind, value);
        let before = hits.len();
        match scan::try_apply(Mode::Llm, text, spans, policy, vault, &put, &mut hits) {
            Ok(masked) => {
                annotate_hits(&mut hits[before..], text, origin);
                for hit in &hits[before..] {
                    let value = &text[hit.start..hit.end];
                    if hit.action != Action::Mask && !hidden_labels.contains(value) {
                        hidden_labels.insert(value.to_string());
                    }
                    // No preview is this long: only hold values that could
                    // occur in a displayed identifier or syntax fragment.
                    if value.len() <= 160 && !preview_hidden.contains(value) {
                        preview_hidden.insert(value.to_string());
                    }
                }
                if let Some(masked) = masked {
                    *text = masked;
                    true
                } else {
                    false
                }
            }
            Err(failed) => {
                error = Some(failed);
                false
            }
        }
    });
    if let Some(error) = error {
        return Err(error);
    }
    // Labels come from the masked request. Drop labels containing a warned
    // value or a blocked value that still appears bare in the label.
    let labels = call_labels(&config.messages, &hidden_labels, &preview_hidden);
    for hit in &mut hits {
        if hit.preview.as_ref().is_some_and(|preview| {
            preview_hidden.iter().any(|value| preview.contains(value))
                || !known(preview).is_empty()
                || policy.terms().is_some_and(|terms| terms.is_match(preview))
        }) {
            hit.preview = None;
        }
        if let Some(origin) = &mut hit.origin {
            if let Some(label) = origin.call.as_ref().and_then(|id| labels.get(id)) {
                origin.label = Some(label.short.clone());
                origin.path = label.path.clone();
            }
        }
    }
    Ok(hits)
}

/// Report where a match begins in the original file content. Hits arrive in
/// byte order, so each part of the text is counted at most once.
fn annotate_hits(hits: &mut [Hit], text: &str, origin: &Origin) {
    if hits.is_empty() {
        return;
    }
    let mut file = match origin.lines {
        Some(FileLines::Read { offset }) => read_body_len(text).map(|end| (offset, end)),
        Some(FileLines::Write) => Some((1, text.len())),
        None => None,
    };
    let mut previous = 0;
    for hit in hits {
        if let Some((line, end)) = file {
            if hit.start < end {
                let newlines = text.as_bytes()[previous..hit.start]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count();
                hit.line = line.checked_add(newlines);
                file = hit.line.map(|number| (number, end));
                previous = hit.start;
            }
        }
        hit.origin = Some(origin.clone());
    }
}

/// `read` starts at the requested offset, but its footer is not file text.
/// Runner previews and head/tail truncation are not contiguous file text.
fn read_body_len(text: &str) -> Option<usize> {
    if text == FILE_UNCHANGED_STUB
        || text.starts_with("Tool output was too large (")
        || text.contains(" bytes truncated] ...\n\n")
    {
        return None;
    }
    let footer = text.rsplit_once("\n\n").filter(|(_, footer)| {
        footer.starts_with('[')
            && (footer.starts_with("[Showing lines ") || footer.contains(" more lines in file."))
            && footer.ends_with(" to continue.]")
    });
    Some(footer.map_or(text.len(), |(body, _)| body.len()))
}

/// How many characters of a command or path the record keeps as a label.
const LABEL_CHARS: usize = 60;

// Canonical field first, followed by the aliases accepted by file tools.
const FILE_PATH_FIELDS: [&str; 4] = ["path", "file_path", "filePath", "file"];

struct CallLabel {
    short: String,
    path: Option<String>,
}

/// Read labels from already masked arguments. Keep the full path only for
/// live file locations, without changing what the durable record stores.
fn call_labels(
    messages: &[Message],
    hidden: &HashSet<String>,
    short_values: &HashSet<String>,
) -> HashMap<String, CallLabel> {
    let mut labels = std::collections::HashMap::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            let Content::ToolCall {
                id,
                name,
                arguments,
                ..
            } = block
            else {
                continue;
            };
            let text = [
                "description",
                "command",
                "path",
                "file_path",
                "filePath",
                "file",
                "pattern",
                "url",
            ]
            .iter()
            .find_map(|key| arguments.get(key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty());
            if let Some(text) = text {
                let first = text.lines().next().unwrap_or_default();
                if hidden.iter().any(|value| first.contains(value.as_str())) {
                    continue;
                }
                let first = if is_path(first) {
                    path_tail(first)
                } else {
                    command_head(first)
                };
                let mut label: String = first.chars().take(LABEL_CHARS).collect();
                if first.chars().count() > LABEL_CHARS || text.contains('\n') {
                    label.push('…');
                }
                let path = if ["read", "edit", "write"]
                    .iter()
                    .any(|tool| name.eq_ignore_ascii_case(tool))
                {
                    FILE_PATH_FIELDS
                        .iter()
                        .find_map(|field| arguments.get(*field))
                        .and_then(Value::as_str)
                        .filter(|path| {
                            !path.is_empty()
                                && !path.contains(char::is_control)
                                && !hidden
                                    .iter()
                                    .chain(short_values)
                                    .any(|value| path.contains(value.as_str()))
                        })
                        .map(str::to_owned)
                } else {
                    None
                };
                labels.insert(id.clone(), CallLabel { short: label, path });
            }
        }
    }
    labels
}

/// An absolute or home-relative path with no spaces: a file tool's target.
fn is_path(text: &str) -> bool {
    (text.starts_with('/') || text.starts_with("~/")) && !text.contains(char::is_whitespace)
}

/// The last two components (`cache/manager.rs`), enough to recognise a file.
fn path_tail(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    let mut cut = trimmed.len();
    for _ in 0..2 {
        match trimmed[..cut].rfind('/') {
            Some(pos) if pos > 0 => cut = pos,
            _ => return trimmed,
        }
    }
    &trimmed[cut + 1..]
}

/// The part of a shell line worth reading: past leading `NAME=value;` or
/// `NAME=value` env setup (`S="-o BatchMode=yes"; ssh $S host 'cmd'` →
/// `ssh $S host 'cmd'`), and past `cd dir &&`. Quotes are respected so a
/// `;` inside a value does not split it.
fn command_head(line: &str) -> &str {
    let mut rest = line.trim_start();
    loop {
        let Some(end) = assignment_end(rest) else {
            break;
        };
        let after = rest[end..].trim_start();
        let after = after.strip_prefix(';').unwrap_or(after).trim_start();
        rest = after;
    }
    // `cd somewhere && real command`
    if rest.starts_with("cd ") {
        if let Some(pos) = rest.find("&&") {
            let after = rest[pos + 2..].trim_start();
            if !after.is_empty() {
                rest = after;
            }
        }
    }
    if rest.is_empty() {
        line
    } else {
        rest
    }
}

/// Byte offset past a leading `NAME=value` with quotes honoured, else `None`.
fn assignment_end(text: &str) -> Option<usize> {
    let name_end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|&i| i > 0)?;
    if !text[name_end..].starts_with('=') || text.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in text[name_end + 1..].char_indices() {
        let at = name_end + 1 + i;
        if escaped {
            escaped = false;
            continue;
        }
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('"'), '\\') => escaped = true,
            (Some(_), _) => {}
            (None, '\'' | '"') => quote = Some(c),
            (None, '\\') => escaped = true,
            (None, c) if c.is_whitespace() || c == ';' => return Some(at),
            (None, _) => {}
        }
    }
    quote.is_none().then_some(text.len())
}

/// Visit every string a request sends that may carry user data. `f` gets
/// the text, where it sits and its origin, and says whether it changed
/// the text.
fn walk(config: &mut StreamConfig, sources: &ToolSources, f: &mut Visit<'_>) {
    let inbound = Slot::Inbound { sensitive: false };
    let at = |at: &str| Origin {
        at: at.to_string(),
        call: None,
        label: None,
        path: None,
        lines: None,
    };
    f(
        &mut config.system_prompt,
        inbound,
        None,
        &at("system prompt"),
    );
    for tool in &mut config.tools {
        let origin = at("tool description");
        f(&mut tool.description, inbound, None, &origin);
        walk_schema(&mut tool.parameters, inbound, &origin, f);
    }
    for message in &mut config.messages {
        let (content, slot, origin) = match message {
            Message::User { content, .. } => (content, inbound, at("user")),
            Message::Assistant { content, .. } => (content, Slot::Model, at("assistant")),
            Message::ToolResult {
                content,
                tool_call_id,
                tool_name,
                is_error,
                ..
            } => {
                let sensitive = sources.sensitive.contains(tool_call_id);
                let read_offset = if !*is_error
                    && tool_name.eq_ignore_ascii_case("read")
                    && matches!(content.as_slice(), [Content::Text { .. }])
                {
                    sources.read_offsets.get(tool_call_id).copied()
                } else {
                    None
                };
                let origin = Origin {
                    at: format!("{tool_name} result"),
                    call: Some(tool_call_id.clone()),
                    label: None,
                    path: None,
                    lines: read_offset.map(|offset| FileLines::Read { offset }),
                };
                (content, Slot::Inbound { sensitive }, origin)
            }
        };
        for block in content {
            match block {
                Content::Text { text } => {
                    f(text, slot, None, &origin);
                }
                Content::Thinking { thinking, metadata } => {
                    let signed = metadata
                        .as_ref()
                        .is_some_and(ThinkingMetadata::has_replay_payload);
                    let thinking_origin = at("thinking");
                    if !signed {
                        f(thinking, Slot::Model, None, &thinking_origin);
                    } else if f(thinking, Slot::Signed, None, &thinking_origin) {
                        *metadata = None;
                    }
                }
                Content::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                } => {
                    let origin = Origin {
                        at: format!("{name} call"),
                        call: Some(id.clone()),
                        label: None,
                        path: None,
                        lines: None,
                    };
                    walk_tool_arguments(name, arguments, &origin, f);
                }
                Content::Image { .. } => {}
            }
        }
    }
}

/// A schema mixes protocol syntax with user data. A known secret can be
/// "boolean" or a property name: replacing it in `type`, `required` or a
/// reference breaks the tool contract. Only recurse as a schema where the
/// vocabulary says there is one; defaults/enums/examples are ordinary JSON
/// even when their object keys look like schema keywords.
fn walk_schema(schema: &mut Value, slot: Slot, origin: &Origin, f: &mut Visit<'_>) {
    match schema {
        Value::Object(map) => {
            for (keyword, value) in map.iter_mut() {
                match keyword.as_str() {
                    // Structural strings, references and validation syntax.
                    "type" | "required" | "dependentRequired" | "$ref" | "$dynamicRef"
                    | "$recursiveRef" | "$schema" | "$id" | "id" | "$anchor" | "$dynamicAnchor"
                    | "pattern" | "format" | "contentEncoding" | "contentMediaType" => {}
                    // Maps from property/definition names to schemas. Do not
                    // interpret those names as keywords (e.g. a property `type`).
                    "properties" | "patternProperties" | "$defs" | "definitions"
                    | "dependentSchemas" => {
                        if let Value::Object(schemas) = value {
                            for schema in schemas.values_mut() {
                                walk_schema(schema, slot, origin, f);
                            }
                        }
                    }
                    // Older drafts mix schemas with arrays of property names.
                    "dependencies" => {
                        if let Value::Object(dependencies) = value {
                            for dependency in dependencies.values_mut() {
                                if dependency.is_object() {
                                    walk_schema(dependency, slot, origin, f);
                                }
                            }
                        }
                    }
                    // Single schemas and arrays of schemas (including tuple
                    // `items` from older drafts). Boolean schemas stay intact.
                    "items"
                    | "prefixItems"
                    | "additionalItems"
                    | "contains"
                    | "unevaluatedItems"
                    | "additionalProperties"
                    | "unevaluatedProperties"
                    | "propertyNames"
                    | "allOf"
                    | "anyOf"
                    | "oneOf"
                    | "not"
                    | "if"
                    | "then"
                    | "else"
                    | "contentSchema" => walk_schema(value, slot, origin, f),
                    // Annotations, literal constraints and extension data may
                    // carry secrets. Keep scanning all their string values.
                    _ => walk_value(value, slot, Some(keyword), origin, f),
                }
            }
        }
        Value::Array(schemas) => {
            for schema in schemas {
                walk_schema(schema, slot, origin, f);
            }
        }
        _ => {}
    }
}

fn walk_tool_arguments(name: &str, arguments: &mut Value, origin: &Origin, f: &mut Visit<'_>) {
    if name.eq_ignore_ascii_case("write") {
        if let Some(fields) = arguments.as_object_mut() {
            let has_path = FILE_PATH_FIELDS
                .iter()
                .find_map(|field| fields.get(*field))
                .and_then(Value::as_str)
                .is_some_and(|path| !path.is_empty());
            for (key, value) in fields {
                // Only the top-level string is written verbatim from line 1.
                // Keep scanning all other arguments without a file line.
                if has_path && key == "content" {
                    if let Value::String(text) = value {
                        let mut file = origin.clone();
                        file.lines = Some(FileLines::Write);
                        f(text, Slot::Model, Some(key), &file);
                        continue;
                    }
                }
                walk_value(value, Slot::Model, Some(key), origin, f);
            }
            return;
        }
    }
    walk_value(arguments, Slot::Model, None, origin, f);
}

fn walk_value(
    value: &mut Value,
    slot: Slot,
    field: Option<&str>,
    origin: &Origin,
    f: &mut Visit<'_>,
) {
    match value {
        Value::String(text) => {
            f(text, slot, field, origin);
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| walk_value(item, slot, field, origin, f)),
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                walk_value(item, slot, Some(key), origin, f);
            }
        }
        _ => {}
    }
}

/// What the tool call tells us about its result, before masking changes it.
#[derive(Default)]
struct ToolSources {
    sensitive: HashSet<String>,
    read_offsets: HashMap<String, usize>,
}

impl ToolSources {
    fn index(engine: &Engine, messages: &[Message]) -> Self {
        let mut sources = Self::default();
        for (id, name, args) in tool_calls(messages) {
            if engine.sensitive_call(name, args) {
                sources.sensitive.insert(id.to_string());
            }
            if name.eq_ignore_ascii_case("read") {
                let offset = match args.get("offset") {
                    None => Some(1),
                    Some(value) => value.as_u64().and_then(|value| usize::try_from(value).ok()),
                };
                if let Some(offset) = offset.filter(|&offset| offset > 0) {
                    sources.read_offsets.insert(id.to_string(), offset);
                }
            }
        }
        sources
    }
}

fn tool_calls(messages: &[Message]) -> impl Iterator<Item = (&str, &str, &Value)> {
    messages
        .iter()
        .filter_map(|message| match message {
            Message::Assistant { content, .. } => Some(content),
            _ => None,
        })
        .flatten()
        .filter_map(|block| match block {
            Content::ToolCall {
                id,
                name,
                arguments,
                ..
            } => Some((id.as_str(), name.as_str(), arguments)),
            _ => None,
        })
}

/// Put the values back in a reply. Signed thinking stays as the provider
/// wrote it, placeholders included: its signature covers that text.
/// Tool-call arguments get their values back; the guard judges each call
/// before it runs.
pub(super) fn restore_message(vault: &Vault, message: &mut Message) {
    let (content, error) = match message {
        Message::Assistant {
            content,
            error_message,
            ..
        } => (content, error_message.as_mut()),
        Message::User { content, .. } | Message::ToolResult { content, .. } => (content, None),
    };
    for block in content {
        match block {
            Content::Text { text } => restore_string(vault, text),
            Content::Thinking { thinking, metadata } => {
                if !metadata
                    .as_ref()
                    .is_some_and(ThinkingMetadata::has_replay_payload)
                {
                    restore_string(vault, thinking);
                }
            }
            Content::ToolCall { arguments, .. } => restore_value(vault, arguments),
            Content::Image { .. } => {}
        }
    }
    if let Some(error) = error {
        restore_string(vault, error);
    }
}

pub(super) fn restore_value(vault: &Vault, value: &mut Value) {
    match value {
        Value::String(text) => restore_string(vault, text),
        Value::Array(items) => items.iter_mut().for_each(|item| restore_value(vault, item)),
        Value::Object(map) => map.values_mut().for_each(|item| restore_value(vault, item)),
        _ => {}
    }
}

fn restore_string(vault: &Vault, text: &mut String) {
    if let Some(restored) = vault.restore(text, false) {
        *text = restored;
    }
}
