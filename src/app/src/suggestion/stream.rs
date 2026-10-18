//! Progressive delivery shares the final validator. Only complete JSON strings
//! or newline-terminated legacy candidates are visible, never token fragments.
use std::fmt;
use std::sync::Arc;

use serde::de::SeqAccess;
use serde::de::Visitor;
use serde::Deserializer;

use super::SuggestionHints;
use super::SuggestionMessage;

pub type SuggestionListener = Arc<dyn Fn(Vec<String>) + Send + Sync>;

pub(super) struct CandidateStream<'a> {
    text: String,
    messages: &'a [SuggestionMessage],
    hints: &'a SuggestionHints,
    listener: Option<SuggestionListener>,
    published: Vec<String>,
    disabled: bool,
    finished: bool,
}

impl<'a> CandidateStream<'a> {
    pub(super) fn new(
        messages: &'a [SuggestionMessage],
        hints: &'a SuggestionHints,
        listener: Option<SuggestionListener>,
    ) -> Self {
        Self {
            text: String::new(),
            messages,
            hints,
            listener,
            published: Vec::new(),
            disabled: false,
            finished: false,
        }
    }

    /// Returns true exactly when the first usable candidate becomes available.
    pub(super) fn push(&mut self, delta: &str) -> bool {
        if self.disabled || self.listener.is_none() {
            return false;
        }
        if self.text.len().saturating_add(delta.len()) > 16_384 {
            self.invalidate();
            self.disabled = true;
            return false;
        }
        self.text.push_str(delta);
        let encoded = if self.hints.suffix.is_some() {
            let mut strings = Vec::new();
            let mut deserializer = serde_json::Deserializer::from_str(&self.text);
            let parsed = deserializer.deserialize_seq(CompleteStrings(&mut strings));
            // EOF after one closed string is normal while the next is arriving.
            // Other errors do not justify publishing any new candidate.
            if parsed.as_ref().is_err_and(|error| !error.is_eof()) {
                return false;
            }
            if parsed.is_ok() && deserializer.end().is_err() {
                return false;
            }
            match serde_json::to_string(&strings) {
                Ok(text) => text,
                Err(_) => return false,
            }
        } else {
            let Some(end) = self.text.rfind('\n') else {
                return false;
            };
            self.text[..=end].to_string()
        };
        let candidates = super::candidates::validated(&encoded, self.messages, self.hints);
        // Cumulative candidates can only be appended. Parsing later data must
        // never silently change an option the user has already highlighted.
        if candidates.len() <= self.published.len() || !candidates.starts_with(&self.published) {
            return false;
        }
        let first = self.published.is_empty();
        self.published = candidates.clone();
        if let Some(listener) = &self.listener {
            listener(candidates);
        }
        first
    }

    pub(super) fn finish(&mut self, candidates: &[String]) {
        self.finished = true;
        if self.published != candidates {
            self.published = candidates.to_vec();
            if let Some(listener) = &self.listener {
                listener(self.published.clone());
            }
        }
    }

    pub(super) fn invalidate(&mut self) {
        self.disabled = true;
        self.finish(&[]);
    }
}

impl Drop for CandidateStream<'_> {
    fn drop(&mut self) {
        // Cancellation, provider errors and non-text outcomes withdraw previews.
        if !self.finished {
            self.invalidate();
        }
    }
}

struct CompleteStrings<'a>(&'a mut Vec<String>);

impl<'de> Visitor<'de> for CompleteStrings<'_> {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an array of completion strings")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
        while let Some(value) = sequence.next_element::<String>()? {
            self.0.push(value);
        }
        Ok(())
    }
}
