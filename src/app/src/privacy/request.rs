//! Masking a typed LLM request and restoring its typed reply.
//!
//! Every outgoing string is reached through [`walk`]: the system prompt,
//! tool descriptions, message text, unsigned thinking and tool-call
//! arguments (string values only). Ids, names, models and keys are left.
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

/// Mask `config` in place; the hits say what was found.
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
    walk(config, &sensitive, &mut |text, slot, field| {
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
    walk(config, &sensitive, &mut |text, slot, _| {
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
        match scan::try_apply(Mode::Llm, text, spans, policy, vault, &put, &mut hits) {
            Ok(Some(masked)) => {
                *text = masked;
                true
            }
            Ok(None) => false,
            Err(failed) => {
                error = Some(failed);
                false
            }
        }
    });
    match error {
        Some(error) => Err(error),
        None => Ok(hits),
    }
}

/// Visit every string a request sends that may carry user data. `f` gets
/// the text and where it sits, and says whether it changed the text.
fn walk(
    config: &mut StreamConfig,
    sensitive: &HashSet<String>,
    f: &mut dyn FnMut(&mut String, Slot, Option<&str>) -> bool,
) {
    let inbound = Slot::Inbound { sensitive: false };
    f(&mut config.system_prompt, inbound, None);
    for tool in &mut config.tools {
        f(&mut tool.description, inbound, None);
        // Every string: MCP servers put defaults, enums and examples here.
        walk_value(&mut tool.parameters, inbound, None, f);
    }
    for message in &mut config.messages {
        let (content, slot) = match message {
            Message::User { content, .. } => (content, inbound),
            Message::Assistant { content, .. } => (content, Slot::Model),
            Message::ToolResult {
                content,
                tool_call_id,
                ..
            } => {
                let sensitive = sensitive.contains(tool_call_id);
                (content, Slot::Inbound { sensitive })
            }
        };
        for block in content {
            match block {
                Content::Text { text } => {
                    f(text, slot, None);
                }
                Content::Thinking { thinking, metadata } => {
                    let signed = metadata
                        .as_ref()
                        .is_some_and(ThinkingMetadata::has_replay_payload);
                    if !signed {
                        f(thinking, Slot::Model, None);
                    } else if f(thinking, Slot::Signed, None) {
                        *metadata = None;
                    }
                }
                Content::ToolCall { arguments, .. } => walk_value(arguments, Slot::Model, None, f),
                Content::Image { .. } => {}
            }
        }
    }
}

fn walk_value(
    value: &mut Value,
    slot: Slot,
    field: Option<&str>,
    f: &mut dyn FnMut(&mut String, Slot, Option<&str>) -> bool,
) {
    match value {
        Value::String(text) => {
            f(text, slot, field);
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| walk_value(item, slot, field, f)),
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                walk_value(item, slot, Some(key), f);
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
