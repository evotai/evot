//! Masking a typed LLM request and restoring its typed reply.
//!
//! Every outgoing string is reached through [`walk`]: the system prompt,
//! tool descriptions and schema data, message text, unsigned thinking and
//! tool-call arguments (string values only). Schema structure, ids, names,
//! models and keys are left.
//! Signed thinking (an Anthropic signature, a Responses item) is sent back
//! byte for byte so its signature holds; if it holds a value the user's
//! side sent, it is masked and sent as plain text without its signature.
use std::collections::HashSet;

use evot_engine::provider::StreamConfig;
use evot_engine::types::Content;
use evot_engine::types::Message;
use evot_engine::types::ThinkingMetadata;
use serde_json::Value;

use super::policy::Action;
use super::policy::Mode;
use super::policy::Policy;
use super::rules::Engine;
use super::scan;
use super::scan::Hit;
use super::scan::Origin;
use super::vault::Vault;
use crate::error::Result;

/// Where a string sits in a request.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// What the user's side wrote or produced: prompts, messages, tool
    /// results (`sensitive` for a secrets file or `env` output).
    Inbound { sensitive: bool },
    /// What the model wrote: assistant text, tool-call arguments.
    Model,
    /// Thinking the provider signed. It goes back byte for byte unless it
    /// holds a secret, or personal data the user's side sent too: an email
    /// the model made up for a test fixture is not worth the signature.
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
    let sensitive = sensitive_results(policy.engine.as_ref(), &config.messages);
    // Pass one finds and remembers every value, so pass two masks each one
    // wherever it is, even in a text that names it without context.
    let mut found = Vec::new();
    let mut inbound: HashSet<String> = HashSet::new();
    walk(config, &sensitive, &mut |text, slot, field, _| {
        let spans = scan::find(
            policy,
            text,
            slot == Slot::Inbound { sensitive: true },
            field,
        );
        for span in &spans {
            let value = &text[span.start..span.end];
            if policy.action(&span.kind, span.confidence) != Action::Warn && !policy.allows(value) {
                vault.remember(&span.kind, value);
            }
        }
        if matches!(slot, Slot::Inbound { .. }) {
            let known = vault.known_spans(text);
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
    let mut found = found.into_iter();
    let mut error = None;
    walk(config, &sensitive, &mut |text, slot, _, origin| {
        if error.is_some() {
            return false;
        }
        let mut spans = found.next().unwrap_or_default();
        spans.extend(vault.known_spans(text));
        if slot == Slot::Signed {
            // A secret never goes back for a signature's sake, wherever it
            // came from; personal data only when the user's side sent it.
            spans.retain(|s| policy.is_secret(&s.kind) || inbound.contains(&text[s.start..s.end]));
        }
        let put = |kind: &str, value: &str| vault.put(kind, value);
        let before = hits.len();
        match scan::try_apply(Mode::Llm, text, spans, policy, vault, &put, &mut hits) {
            Ok(Some(masked)) => {
                *text = masked;
                for hit in &mut hits[before..] {
                    hit.origin = Some(origin.clone());
                }
                true
            }
            Ok(None) => {
                for hit in &mut hits[before..] {
                    hit.origin = Some(origin.clone());
                }
                false
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
    // Labels come from the request as it now is, placeholders included, so
    // a command that carried the value names it by placeholder, not value.
    let labels = call_labels(&config.messages);
    for hit in &mut hits {
        if let Some(origin) = &mut hit.origin {
            if let Some(call) = &origin.call {
                origin.label = labels.get(call).cloned();
            }
        }
    }
    Ok(hits)
}

/// How many characters of a command or path the record keeps as a label.
const LABEL_CHARS: usize = 60;

/// A safe label per tool call, from its (already masked) arguments: a
/// bash command's description, else its head; a path for file tools.
fn call_labels(messages: &[Message]) -> std::collections::HashMap<String, String> {
    let mut labels = std::collections::HashMap::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            let Content::ToolCall { id, arguments, .. } = block else {
                continue;
            };
            let text = [
                "description",
                "command",
                "path",
                "file_path",
                "pattern",
                "url",
            ]
            .iter()
            .find_map(|key| arguments.get(key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty());
            if let Some(text) = text {
                let first = text.lines().next().unwrap_or_default();
                let first = if is_path(first) {
                    path_tail(first)
                } else {
                    command_head(first)
                };
                let mut label: String = first.chars().take(LABEL_CHARS).collect();
                if first.chars().count() > LABEL_CHARS || text.contains('\n') {
                    label.push('…');
                }
                labels.insert(id.clone(), label);
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
fn walk(config: &mut StreamConfig, sensitive: &HashSet<String>, f: &mut Visit<'_>) {
    let inbound = Slot::Inbound { sensitive: false };
    let at = |at: &str| Origin {
        at: at.to_string(),
        call: None,
        label: None,
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
                ..
            } => {
                let sensitive = sensitive.contains(tool_call_id);
                let origin = Origin {
                    at: format!("{tool_name} result"),
                    call: Some(tool_call_id.clone()),
                    label: None,
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
                    };
                    walk_value(arguments, Slot::Model, None, &origin, f)
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

/// Tool calls whose results are a sensitive source (by the packs' `sources`).
fn sensitive_results(engine: &Engine, messages: &[Message]) -> HashSet<String> {
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
            } if engine.sensitive_call(name, arguments) => Some(id.clone()),
            _ => None,
        })
        .collect()
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
