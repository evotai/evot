//! Confirmed values, separate from placeholder allocation and restoration.
//!
//! Explicit registration is authoritative. Automatic discovery promotes only
//! opaque values: a value found by its context is masked there, but is looked
//! for everywhere else only when it cannot be a word, a name or a path. That is
//! a property of the value's shape, not a list of words.
use std::collections::HashMap;

use aho_corasick::AhoCorasick;
use aho_corasick::MatchKind;
use parking_lot::RwLock;

use super::scan::Finder;
use super::scan::Span;

const MAX_VALUES: usize = 100_000;
const MIN_REGISTERED: usize = 4;
/// Letter/digit alternations that make a run of word characters opaque.
/// Identifiers alternate at most twice (`base64Encode`, `sha256sum`); keys,
/// tokens and generated passwords do so throughout.
const OPAQUE_ALTERNATIONS: usize = 3;

#[derive(Default)]
pub(super) struct KnownValues {
    state: RwLock<State>,
}

/// Never prints a value.
impl std::fmt::Debug for KnownValues {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KnownValues")
            .field("values", &self.state.read().values.len())
            .finish()
    }
}

#[derive(Default)]
struct State {
    values: HashMap<String, String>,
    matcher: Option<(AhoCorasick, Vec<String>)>,
}

/// Whether `value` is safe to look for without the context that revealed it:
/// at least `min_len` characters, and not shaped like prose, an identifier, a
/// dotted/pathed name, a version or a number. It holds a character no such
/// name has (`@`, `!`, `+`, `=`, …), or its word runs alternate between letters
/// and digits often enough that no name reads that way.
pub(super) fn opaque(value: &str, min_len: usize) -> bool {
    if value.chars().count() < min_len {
        return false;
    }
    let mut alternations = 0;
    // 0: none yet in this run, 1: letter, 2: digit.
    let mut last = 0u8;
    for c in value.chars() {
        let class = if c.is_alphabetic() {
            1
        } else if c.is_numeric() {
            2
        } else if c.is_whitespace() || matches!(c, '_' | '-' | '.' | '/' | ':' | '\\') {
            0
        } else {
            return true;
        };
        if class != 0 && last != 0 && class != last {
            alternations += 1;
        }
        last = class;
    }
    alternations >= OPAQUE_ALTERNATIONS
}

impl KnownValues {
    pub fn remember(&self, kind: &str, value: &str) {
        if value.len() < MIN_REGISTERED || self.state.read().values.contains_key(value) {
            return;
        }
        let mut state = self.state.write();
        if state.values.len() >= MAX_VALUES {
            state.values.clear();
        }
        state
            .values
            .entry(value.to_string())
            .or_insert_with(|| kind.to_string());
        state.matcher = None;
    }

    /// Remember a value a rule found, if it is opaque.
    pub fn discover(&self, kind: &str, value: &str, min_len: usize) {
        if opaque(value, min_len) {
            self.remember(kind, value);
        }
    }

    pub fn spans(&self, text: &str) -> Vec<Span> {
        {
            let state = self.state.read();
            if state.values.is_empty() {
                return Vec::new();
            }
            if state.matcher.is_some() {
                return indexed_spans(&state, text);
            }
        }
        let mut state = self.state.write();
        if state.matcher.is_none() {
            let values: Vec<String> = state.values.keys().cloned().collect();
            match AhoCorasick::builder()
                .match_kind(MatchKind::LeftmostLongest)
                .build(&values)
            {
                Ok(ac) => state.matcher = Some((ac, values)),
                Err(error) => {
                    tracing::warn!(%error, "privacy: known-value index failed; scanning plainly");
                    return plain_spans(&state.values, text);
                }
            }
        }
        indexed_spans(&state, text)
    }
}

fn indexed_spans(state: &State, text: &str) -> Vec<Span> {
    let Some((ac, values)) = &state.matcher else {
        return plain_spans(&state.values, text);
    };
    ac.find_iter(text)
        .filter_map(|m| {
            let kind = state.values.get(values.get(m.pattern().as_usize())?)?;
            Some(Span::new(m.start(), m.end(), kind, Finder::Known))
        })
        .collect()
}

fn plain_spans(known: &HashMap<String, String>, text: &str) -> Vec<Span> {
    known
        .iter()
        .flat_map(|(value, kind)| {
            text.match_indices(value.as_str())
                .map(move |(at, v)| Span::new(at, at + v.len(), kind, Finder::Known))
        })
        .collect()
}
