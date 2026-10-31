//! Finding values in one text and swapping them out.
use serde::Deserialize;
use serde::Serialize;

use super::policy::Action;
use super::policy::Mode;
use super::policy::Policy;
use super::rules::Category;
use super::rules::Confidence;
use super::rules::Source;
use super::rules::TERM;
use super::vault::placeholder_re;
use super::vault::Vault;

/// What found a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Finder {
    /// A pattern rule from a pack.
    Rule,
    /// One of the user's terms.
    Term,
    /// Legacy: an assignment in a sensitive file (now a `scope: sensitive` rule).
    File,
    /// A value masked before, wherever it appears again.
    Known,
    /// The name of the field holding it.
    Field,
    /// A rule, inside a base64 or percent-encoded run.
    Decoded,
    /// A finder a newer evot wrote.
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone)]
pub(in crate::privacy) struct Span {
    pub start: usize,
    pub end: usize,
    pub kind: String,
    pub by: Finder,
    pub rule: Option<String>,
    pub confidence: Confidence,
}

impl Span {
    pub fn new(start: usize, end: usize, kind: &str, by: Finder) -> Self {
        Self {
            start,
            end,
            kind: kind.to_string(),
            by,
            rule: None,
            confidence: Confidence::Medium,
        }
    }

    pub fn rule(mut self, id: &str, confidence: Confidence) -> Self {
        self.rule = Some(id.to_string());
        self.confidence = confidence;
        self
    }
}

/// One value found. Holds nothing of the value itself: `tag` is its
/// placeholder (what the vendor sees anyway) and `len` its length in
/// characters. No prefix, suffix or other piece of it is kept.
#[derive(Debug, Clone)]
pub(super) struct Hit {
    pub kind: String,
    pub by: Finder,
    pub rule: Option<String>,
    pub confidence: Confidence,
    pub action: Action,
    pub tag: String,
    pub len: usize,
    /// A safe label for `/privacy`: a variable's name, a file's name. Never
    /// a piece of the value.
    pub note: Option<String>,
    /// Where in the request it sat; `None` for uploads.
    pub origin: Option<Origin>,
}

/// Where a found value sat in a request. `label` is taken from the masked
/// request after the pass, so it can never hold a value: a bash command's
/// description or head, a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    /// `system prompt`, `tool description`, `user`, `assistant`,
    /// `thinking`, `Bash call`, `Bash result`.
    pub at: String,
    /// The tool call this belongs to (a call's arguments or its result), so
    /// the label can be filled in once the request is masked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// What the packs and the user's terms find in `text`. `field` is the JSON
/// field holding it. Known values are added by the caller.
pub(super) fn find(policy: &Policy, text: &str, sensitive: bool, field: Option<&str>) -> Vec<Span> {
    let covers = |category: Category| policy.covers(category);
    let source = Source {
        sensitive,
        field,
        covers: &covers,
    };
    let mut found = policy.engine.find(text, &source);
    if let Some(terms) = policy.terms() {
        for m in terms.find_iter(text) {
            found.push(
                Span::new(m.start(), m.end(), TERM, Finder::Term).rule("term", Confidence::High),
            );
        }
    }
    found
}

/// Swap `found` in `text` for what `put` makes of each value: the first to
/// start and the longest wins where they overlap, nothing inside a
/// placeholder already there. Allowed values and warned kinds stay as
/// written. Returns `None` when nothing changed.
pub(super) fn apply(
    mode: Mode,
    text: &str,
    found: Vec<Span>,
    policy: &Policy,
    vault: &Vault,
    put: &dyn Fn(&str, &str) -> String,
    hits: &mut Vec<Hit>,
) -> Option<String> {
    let put = |kind: &str, value: &str| Ok::<_, std::convert::Infallible>(put(kind, value));
    match try_apply(mode, text, found, policy, vault, &put, hits) {
        Ok(value) => value,
        Err(never) => match never {},
    }
}

/// As `apply`, allowing reversible placeholder allocation to fail without
/// leaking either value in a colliding binding. One-way scrubbing is infallible.
pub(super) fn try_apply<E>(
    mode: Mode,
    text: &str,
    mut found: Vec<Span>,
    policy: &Policy,
    vault: &Vault,
    put: &dyn Fn(&str, &str) -> std::result::Result<String, E>,
    hits: &mut Vec<Hit>,
) -> std::result::Result<Option<String>, E> {
    if found.is_empty() {
        return Ok(None);
    }
    if text.contains("{{") {
        if let Some(re) = placeholder_re() {
            let existing: Vec<(usize, usize)> =
                re.find_iter(text).map(|m| (m.start(), m.end())).collect();
            found.retain(|f| !existing.iter().any(|&(a, b)| f.start < b && f.end > a));
        }
    }
    // Stable: of two equal spans the earlier finder (rule before known)
    // names the kind, so a value's placeholder is the same every time.
    found.sort_by(|x, y| x.start.cmp(&y.start).then(y.end.cmp(&x.end)));
    let mut out = String::with_capacity(text.len());
    let (mut last, mut next) = (0, 0);
    for span in found {
        if span.start < next {
            continue;
        }
        next = span.end;
        let value = &text[span.start..span.end];
        if policy.allows(value) {
            continue;
        }
        let action = policy.action_for(mode, &span.kind, span.confidence);
        hits.push(Hit {
            tag: vault.tag(&span.kind, value),
            kind: span.kind.clone(),
            by: span.by,
            rule: span.rule.clone(),
            confidence: span.confidence,
            action,
            len: value.chars().count(),
            note: None,
            origin: None,
        });
        if action == Action::Warn {
            continue;
        }
        out.push_str(&text[last..span.start]);
        out.push_str(&put(&span.kind, value)?);
        last = span.end;
    }
    if last == 0 {
        return Ok(None);
    }
    out.push_str(&text[last..]);
    Ok(Some(out))
}
