//! Placeholders and the values behind them.
//!
//! A placeholder is `{{KIND_xxxxxxxx}}`: eight base32 letters of a keyed
//! hash of the value, so the same value reads the same in every request
//! (prompt caches and thinking signatures stay valid) and a placeholder
//! says nothing about its value without the key. Values live in memory
//! only; every request brings its history again, so a restart loses
//! nothing. A value once masked is "known" and masked wherever it shows up
//! later, whatever words surround it: a model writes about a placeholder
//! in words no rule recognises, and the agent replays that text with the
//! value restored.
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::OnceLock;

use aho_corasick::AhoCorasick;
use aho_corasick::MatchKind;
use parking_lot::RwLock;
use regex::Regex;
use sha2::Digest;
use sha2::Sha256;

use super::scan::Finder;
use super::scan::Span;
use crate::error::EvotError;
use crate::error::Result;

/// Past this many values the oldest half is let go; a request that still
/// carries them brings them back.
const MAX_VALUES: usize = 100_000;
/// Shorter known values would mask ordinary words.
const MIN_KNOWN: usize = 4;
const MAX_KIND: usize = 32;
const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

pub(super) struct Vault {
    key: [u8; 32],
    state: RwLock<State>,
}

#[derive(Default)]
struct State {
    /// Placeholder → value.
    values: HashMap<String, String>,
    kinds: BTreeSet<String>,
    /// Value → kind, matched anywhere.
    known: HashMap<String, String>,
    matcher: Option<(AhoCorasick, Vec<String>)>,
}

impl Vault {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            key,
            state: RwLock::new(State::default()),
        }
    }

    /// The placeholder `value` of `kind` goes as, not remembered.
    pub fn tag(&self, kind: &str, value: &str) -> String {
        let mut msg = Vec::with_capacity(kind.len() + 1 + value.len());
        msg.extend_from_slice(kind.as_bytes());
        msg.push(0);
        msg.extend_from_slice(value.as_bytes());
        let mac = hmac_sha256(&self.key, &msg);
        // 40 bits as eight base32 letters.
        let bits = mac[..5]
            .iter()
            .fold(0u64, |acc, &byte| (acc << 8) | u64::from(byte));
        let hash: String = (0..8)
            .map(|i| B32[((bits >> (35 - 5 * i)) & 31) as usize] as char)
            .collect();
        format!("{{{{{kind}_{hash}}}}}")
    }

    /// The placeholder for `value`, remembered for restore and as known.
    pub fn put(&self, kind: &str, value: &str) -> Result<String> {
        let placeholder = self.tag(kind, value);
        let mut state = self.state.write();
        if let Some(existing) = state.values.get(&placeholder) {
            if existing != value {
                // Keep the historical wire format and the original binding.
                // Never put either value in the error or silently restore the wrong one.
                return Err(EvotError::Conf(
                    "privacy placeholder collision; request was not sent".into(),
                ));
            }
        } else {
            if state.values.len() >= MAX_VALUES {
                let drop: Vec<String> = state.values.keys().take(MAX_VALUES / 2).cloned().collect();
                for key in drop {
                    state.values.remove(&key);
                }
            }
            state.values.insert(placeholder.clone(), value.to_string());
            state.kinds.insert(kind.to_string());
        }
        remember_locked(&mut state, kind, value);
        Ok(placeholder)
    }

    /// Mask `value` wherever it appears from now on.
    pub fn remember(&self, kind: &str, value: &str) {
        if value.len() < MIN_KNOWN || self.state.read().known.contains_key(value) {
            return;
        }
        remember_locked(&mut self.state.write(), kind, value);
    }

    /// Where the known values are in `text`.
    pub fn known_spans(&self, text: &str) -> Vec<Span> {
        {
            let state = self.state.read();
            if state.known.is_empty() {
                return Vec::new();
            }
            if state.matcher.is_some() {
                return indexed_spans(&state, text);
            }
        }
        let mut state = self.state.write();
        if state.matcher.is_none() {
            let values: Vec<String> = state.known.keys().cloned().collect();
            match AhoCorasick::builder()
                .match_kind(MatchKind::LeftmostLongest)
                .build(&values)
            {
                Ok(ac) => state.matcher = Some((ac, values)),
                Err(error) => {
                    tracing::warn!(%error, "privacy: known-value index failed; scanning plainly");
                    return plain_spans(&state.known, text);
                }
            }
        }
        indexed_spans(&state, text)
    }

    /// `s` with each placeholder this vault made put back, or `None` when
    /// it has none. `escaped` is for raw JSON text, where a value goes in
    /// JSON-escaped. Placeholders the model rewrote are taken too:
    /// `{{ PHONE_x }}`, a brace dropped, none at all, another case.
    pub fn restore(&self, s: &str, escaped: bool) -> Option<String> {
        if !s.contains('_') {
            return None;
        }
        let state = self.state.read();
        if state.values.is_empty() {
            return None;
        }
        let bytes = s.as_bytes();
        let mut out = String::new();
        let mut last = 0;
        for m in body_re()?.find_iter(s) {
            let (a, z) = (m.start(), m.end());
            if a < last || (a > 0 && is_word(bytes[a - 1])) || (z < s.len() && is_word(bytes[z])) {
                continue;
            }
            let Some(value) = state.values.get(&canonical(m.as_str())) else {
                continue;
            };
            let (a, z) = braces(bytes, a, z);
            if a < last {
                continue;
            }
            out.push_str(&s[last..a]);
            if escaped {
                out.push_str(&json_escape(value));
            } else {
                out.push_str(value);
            }
            last = z;
        }
        if last == 0 {
            return None;
        }
        out.push_str(&s[last..]);
        Some(out)
    }

    /// How many bytes at the end of `s` may be the start of a placeholder
    /// that the next piece of a stream finishes.
    pub fn partial_tail(&self, s: &str) -> usize {
        match brace_tail(s) {
            0 => self.word_tail(s),
            n => n,
        }
    }

    /// A last word that may become a brace-less placeholder: the start of
    /// a kind this vault made, up to its eight hash letters.
    fn word_tail(&self, s: &str) -> usize {
        let start = s.len() - s.bytes().rev().take_while(|&c| is_word(c)).count();
        let word = &s[start..];
        if word.is_empty() || word.len() > MAX_KIND + 9 || !word.as_bytes()[0].is_ascii_uppercase()
        {
            return 0;
        }
        let upper = word.to_ascii_uppercase();
        let state = self.state.read();
        let holds = state.kinds.iter().any(|kind| {
            let kind = format!("{kind}_");
            kind.starts_with(&upper)
                || (upper.starts_with(&kind)
                    && upper.len() - kind.len() <= 8
                    && word[kind.len()..]
                        .to_ascii_lowercase()
                        .bytes()
                        .all(|c| B32.contains(&c)))
        });
        if holds {
            word.len()
        } else {
            0
        }
    }
}

fn remember_locked(state: &mut State, kind: &str, value: &str) {
    if value.len() < MIN_KNOWN || state.known.contains_key(value) {
        return;
    }
    if state.known.len() >= MAX_VALUES {
        state.known.clear();
    }
    state.known.insert(value.to_string(), kind.to_string());
    state.matcher = None;
}

fn indexed_spans(state: &State, text: &str) -> Vec<Span> {
    let Some((ac, values)) = &state.matcher else {
        return plain_spans(&state.known, text);
    };
    ac.find_iter(text)
        .filter_map(|m| {
            let kind = state.known.get(values.get(m.pattern().as_usize())?)?;
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

fn hmac_sha256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for (i, byte) in key.iter().enumerate() {
        ipad[i] ^= byte;
        opad[i] ^= byte;
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(msg)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

/// A placeholder without its braces, in any case.
fn body_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8}").ok())
        .as_ref()
}

/// A placeholder as written by [`Vault::put`].
pub(super) fn placeholder_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}").ok())
        .as_ref()
}

fn canonical(body: &str) -> String {
    let cut = body.len() - 8;
    format!(
        "{{{{{}{}}}}}",
        body[..cut].to_ascii_uppercase(),
        body[cut..].to_ascii_lowercase()
    )
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Widen a placeholder body at s[a..z] over the braces (and spaces inside
/// them) the model wrote: both pairs, or one brace of a pair dropped.
fn braces(s: &[u8], a: usize, z: usize) -> (usize, usize) {
    let mut la = a;
    while la > 0 && matches!(s[la - 1], b' ' | b'\t') {
        la -= 1;
    }
    let mut left = 0;
    while left < 2 && la > 0 && s[la - 1] == b'{' {
        la -= 1;
        left += 1;
    }
    let mut rz = z;
    while rz < s.len() && matches!(s[rz], b' ' | b'\t') {
        rz += 1;
    }
    let mut right = 0;
    while right < 2 && rz < s.len() && s[rz] == b'}' {
        rz += 1;
        right += 1;
    }
    let a = if left == 2 || (left == 1 && right >= 1) {
        la
    } else {
        a
    };
    let z = if right == 2 || (right == 1 && left >= 1) {
        rz
    } else {
        z
    };
    (a, z)
}

/// A tail from `{` or `{{` on that may still become a placeholder.
fn brace_tail(s: &str) -> usize {
    const MAX_PLACEHOLDER: usize = 2 + MAX_KIND + 1 + 8 + 2;
    let Some(mut i) = s.rfind('{') else {
        return 0;
    };
    if i > 0 && s.as_bytes()[i - 1] == b'{' {
        i -= 1;
    }
    let tail = &s[i..];
    if tail.len() >= MAX_PLACEHOLDER + 4 || tail.contains("}}") {
        return 0;
    }
    let body = tail.trim_start_matches('{').trim_start_matches([' ', '\t']);
    let Some(first) = body.bytes().next() else {
        return tail.len();
    };
    if !first.is_ascii_alphabetic() {
        return 0;
    }
    let word = body.bytes().take_while(|&c| is_word(c)).count();
    let rest = body[word..].trim_start_matches([' ', '\t']);
    if !rest.is_empty() && rest != "}" {
        return 0;
    }
    let complete = body_re().is_some_and(|re| {
        re.find(&body[..word])
            .is_some_and(|m| m.start() == 0 && m.end() == word)
    });
    if word < body.len() && !complete {
        return 0;
    }
    tail.len()
}

fn json_escape(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .map(str::to_string)
        .unwrap_or_default()
}
