//! Scrubbing what is uploaded (share links, cloud sync). Unlike LLM
//! masking this is one-way: a value becomes `[REDACTED:KIND]` and nothing
//! is kept to put it back, since the copy lives on someone else's server.
//!
//! The payload is walked as JSON. Which fields are structure (ids, types,
//! timestamps, signatures, binary data), which name a tool call's result
//! and which hold its arguments all come from the packs' `structure`; a
//! value under a field a field rule names (`authorization`, `收件人`) is
//! found by that rule like any other.
use std::collections::HashSet;

use serde_json::Map;
use serde_json::Value;

use super::policy::Action;
use super::policy::Mode;
use super::policy::Policy;
use super::rules::Engine;
use super::scan;
use super::scan::Hit;
use super::vault::Vault;

/// What an upload is scrubbed against beyond itself: the session's whole
/// local history. Its values are remembered and its sensitive tool calls
/// listed, so an upload that carries only part of a session (one sync
/// batch, the entries since the last push, a fresh process) scrubs a value
/// or a `.env` result whose context went up earlier.
#[derive(Debug, Default, Clone)]
pub struct UploadContext {
    sensitive: HashSet<String>,
}

/// Scan `history` without changing it: remember what it finds and the tool
/// calls whose results are sensitive.
pub(super) fn context(policy: &Policy, vault: &Vault, history: &Value) -> UploadContext {
    let engine = policy.engine.as_ref();
    let mut sensitive = HashSet::new();
    sensitive_ids(engine, history, &mut sensitive);
    let mut history = history.clone();
    visit(
        engine,
        &mut history,
        &sensitive,
        false,
        None,
        &mut |text, sensitive, field| {
            remember(
                policy,
                vault,
                text,
                &scan::find(policy, text, sensitive, field),
            );
        },
    );
    UploadContext { sensitive }
}

fn remember(policy: &Policy, vault: &Vault, text: &str, spans: &[scan::Span]) {
    for span in spans {
        let value = &text[span.start..span.end];
        if policy.upload_action(&span.kind) != Action::Warn && !policy.allows(value) {
            vault.remember(&span.kind, value);
        }
    }
}

pub(super) fn scrub_value(
    policy: &Policy,
    vault: &Vault,
    value: &mut Value,
    context: Option<&UploadContext>,
) -> Vec<Hit> {
    let engine = policy.engine.as_ref();
    let mut sensitive = context.map(|c| c.sensitive.clone()).unwrap_or_default();
    sensitive_ids(engine, value, &mut sensitive);
    // Pass one finds and remembers every value, so pass two takes each one
    // wherever it is in the payload (and later requests mask it too).
    let mut found = Vec::new();
    visit(
        engine,
        value,
        &sensitive,
        false,
        None,
        &mut |text, sensitive, field| {
            let spans = scan::find(policy, text, sensitive, field);
            remember(policy, vault, text, &spans);
            found.push(spans);
        },
    );
    let mut hits = Vec::new();
    let mut found = found.into_iter();
    let put = |kind: &str, _: &str| format!("[REDACTED:{kind}]");
    visit(engine, value, &sensitive, false, None, &mut |text, _, _| {
        let mut spans = found.next().unwrap_or_default();
        spans.extend(vault.known_spans(text));
        if let Some(scrubbed) =
            scan::apply(Mode::Upload, text, spans, policy, vault, &put, &mut hits)
        {
            *text = scrubbed;
        }
    });
    hits
}

fn visit(
    engine: &Engine,
    value: &mut Value,
    sensitive: &HashSet<String>,
    from_sensitive: bool,
    field: Option<&str>,
    f: &mut dyn FnMut(&mut String, bool, Option<&str>),
) {
    match value {
        Value::String(text) => f(text, from_sensitive, field),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| visit(engine, item, sensitive, from_sensitive, field, f)),
        Value::Object(map) => {
            let from_sensitive =
                from_sensitive || result_of(engine, map).is_some_and(|id| sensitive.contains(id));
            let binary = is_binary(engine, map);
            let s = &engine.structure;
            for (key, item) in map.iter_mut() {
                let skip = s.skip_keys.iter().any(|k| k == key)
                    || s.skip_suffixes.iter().any(|x| key.ends_with(x.as_str()))
                    || (binary && s.binary_keys.iter().any(|k| k == key));
                if !skip {
                    visit(engine, item, sensitive, from_sensitive, Some(key), f);
                }
            }
        }
        _ => {}
    }
}

fn is_binary(engine: &Engine, map: &Map<String, Value>) -> bool {
    let s = &engine.structure;
    map.get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| s.binary_types.iter().any(|b| b == t))
        || s.binary_markers.iter().any(|key| map.contains_key(key))
}

/// The tool call id an object is the result of, if it is one.
fn result_of<'a>(engine: &Engine, map: &'a Map<String, Value>) -> Option<&'a str> {
    engine
        .structure
        .result_id_keys
        .iter()
        .find_map(|key| map.get(key)?.as_str())
}

/// Ids of tool calls anywhere in the payload whose results are a
/// sensitive source: `{"id", "name", <call_args_keys>}`.
fn sensitive_ids(engine: &Engine, value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::Array(items) => items
            .iter()
            .for_each(|item| sensitive_ids(engine, item, out)),
        Value::Object(map) => {
            let arguments = engine
                .structure
                .call_args_keys
                .iter()
                .find_map(|key| map.get(key));
            let call = (
                map.get("id").and_then(Value::as_str),
                map.get("name").and_then(Value::as_str),
                arguments,
            );
            if let (Some(id), Some(name), Some(arguments)) = call {
                if engine.sensitive_call(name, arguments) {
                    out.insert(id.to_string());
                }
            }
            map.values()
                .for_each(|item| sensitive_ids(engine, item, out));
        }
        _ => {}
    }
}
