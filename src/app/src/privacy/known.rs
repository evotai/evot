//! Confirmed values, separate from placeholder allocation and restoration.
//!
//! Explicit registration is authoritative. Automatic discovery only promotes
//! sufficiently long, non-word values; a short password is still masked by its
//! credential context without poisoning identifiers throughout the session.
use std::collections::HashMap;

use aho_corasick::AhoCorasick;
use aho_corasick::MatchKind;
use parking_lot::RwLock;

use super::scan::Finder;
use super::scan::Span;

const MAX_VALUES: usize = 100_000;
const MIN_REGISTERED: usize = 4;

#[derive(Default)]
pub(super) struct KnownValues {
    state: RwLock<State>,
}

#[derive(Default)]
struct State {
    values: HashMap<String, String>,
    matcher: Option<(AhoCorasick, Vec<String>)>,
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

    pub fn discover(&self, kind: &str, value: &str, min_len: usize) {
        if value.chars().count() >= min_len && !value.chars().all(char::is_alphabetic) {
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
