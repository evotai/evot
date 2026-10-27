//! Encoded runs a value may hide in: base64 (`Basic …`, k8s secrets, data
//! fields) and percent-encoding (URLs, form bodies). A run whose decoding is
//! text is scanned again; what the rules find there masks the whole run.
use base64::Engine as _;
use regex::Regex;

use super::pack::DecodeDef;
use crate::error::EvotError;
use crate::error::Result;

pub(super) struct Patterns {
    base64: Regex,
    percent: Regex,
}

impl Patterns {
    pub fn new() -> Result<Self> {
        let compile =
            |p: &str| Regex::new(p).map_err(|e| EvotError::Conf(format!("privacy decode: {e}")));
        Ok(Self {
            base64: compile(r"[A-Za-z0-9+/_-]{8,}={0,2}")?,
            percent: compile(r"(?:[A-Za-z0-9._~+-]*%[0-9A-Fa-f]{2})+[A-Za-z0-9._~+-]*")?,
        })
    }

    /// Each run in `text` within the pack's lengths that decodes to text.
    pub fn runs(&self, text: &str, def: &DecodeDef) -> Vec<(usize, usize, String)> {
        let fits = |a: usize, b: usize| (def.min_len..=def.max_len).contains(&(b - a));
        let mut out = Vec::new();
        if def.base64 {
            for m in self
                .base64
                .find_iter(text)
                .filter(|m| fits(m.start(), m.end()))
            {
                if let Some(decoded) = base64_text(m.as_str()) {
                    out.push((m.start(), m.end(), decoded));
                }
            }
        }
        if def.percent {
            for m in self
                .percent
                .find_iter(text)
                .filter(|m| fits(m.start(), m.end()))
            {
                if let Some(decoded) = percent_text(m.as_str()) {
                    out.push((m.start(), m.end(), decoded));
                }
            }
        }
        out
    }
}

/// Decoded bytes that read as text: UTF-8, nearly all printable.
fn as_text(bytes: Vec<u8>) -> Option<String> {
    let text = String::from_utf8(bytes).ok()?;
    let total = text.chars().count();
    let printable = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .count();
    (total >= 4 && printable * 100 >= total * 95).then_some(text)
}

fn base64_text(run: &str) -> Option<String> {
    // Mixed case and a digit, or it is a word, a path piece or a hex hash.
    let letters =
        run.bytes().any(|c| c.is_ascii_lowercase()) && run.bytes().any(|c| c.is_ascii_uppercase());
    if !letters {
        return None;
    }
    let trimmed = run.trim_end_matches('=');
    let engines = [
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];
    engines
        .iter()
        .find_map(|engine| engine.decode(trimmed).ok())
        .and_then(as_text)
}

fn percent_text(run: &str) -> Option<String> {
    let bytes = run.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    as_text(out)
}
