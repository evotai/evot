//! The engine: packs compiled into one rule set, and the one matcher every
//! rule, field and decoded value goes through. It knows no rule, word or
//! kind of its own; all of that is in the packs.
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::sync::Arc;

use aho_corasick::AhoCorasick;
use aho_corasick::MatchKind;
use regex::Regex;
use serde::Serialize;

use super::checksum;
use super::decode;
use super::egress::Egress;
use super::pack::Category;
use super::pack::Check;
use super::pack::CheckRef;
use super::pack::ChecksumDef;
use super::pack::Confidence;
use super::pack::DecodeDef;
use super::pack::Examples;
use super::pack::KnownDef;
use super::pack::Pack;
use super::pack::Scope;
use super::pack::SourcesDef;
use super::pack::StructureDef;
use super::pack::PACK_SCHEMA_VERSION;
use crate::error::EvotError;
use crate::error::Result;
use crate::privacy::scan::Finder;
use crate::privacy::scan::Span;

/// Licenses a pack's source may carry: permissive, attribution only.
const LICENSES: &[&str] = &[
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "CC0-1.0",
    "Unlicense",
];
/// Kinds the engine itself produces: a user's term, a registered secret.
pub(in crate::privacy) const TERM: &str = "TERM";
const SECRET: &str = "SECRET";
/// Kinds the egress guard reports: a secret variable named, a secrets file
/// or the environment read, code that cannot be read before it runs.
pub(in crate::privacy) const SECRET_ENV: &str = "SECRET_ENV";
pub(in crate::privacy) const SECRET_FILE: &str = "SECRET_FILE";
pub(in crate::privacy) const HIDDEN_CODE: &str = "HIDDEN_CODE";
const EGRESS_KINDS: &[&str] = &[SECRET_ENV, SECRET_FILE, HIDDEN_CODE];
const DEFAULT_CHECK_WINDOW: usize = 64;

/// Where a text is being scanned.
pub(in crate::privacy) struct Source<'a> {
    /// The output of a sensitive source (`.env`, `env`).
    pub sensitive: bool,
    /// The name of the JSON field holding the text.
    pub field: Option<&'a str>,
    /// Whether a category is switched on.
    pub covers: &'a dyn Fn(Category) -> bool,
}

/// A pack as `/privacy` lists it.
#[derive(Debug, Clone, Serialize)]
pub struct PackInfo {
    pub id: String,
    pub rules: usize,
    pub source: Option<String>,
    pub license: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindInfo {
    pub kind: String,
    pub category: Category,
}

struct Cond {
    value: Option<Regex>,
    before: Option<Regex>,
    after: Option<Regex>,
    window: usize,
    words: Option<HashSet<String>>,
    contains: Option<AhoCorasick>,
    entropy_below: Option<f64>,
}

struct Context {
    words: AhoCorasick,
    window: usize,
    required: bool,
    confidence: Option<Confidence>,
}

struct Rule {
    id: String,
    kind: String,
    category: Category,
    confidence: Confidence,
    re: Regex,
    group: usize,
    bound: Option<Regex>,
    scope: Scope,
    when: Vec<Arc<Cond>>,
    unless: Vec<Arc<Cond>>,
    context: Option<Context>,
    checksum: Option<ChecksumDef>,
    examples: Examples,
}

struct Field {
    id: String,
    kind: String,
    category: Category,
    confidence: Confidence,
    key: Regex,
    key_unless: Option<Regex>,
    /// `name: value` in text, when the field is found in text too.
    text: Option<Regex>,
    when: Vec<Arc<Cond>>,
    unless: Vec<Arc<Cond>>,
    examples: Examples,
}

pub(in crate::privacy) struct Sources {
    tools: Vec<(String, Vec<String>, Option<String>)>,
    names: HashSet<String>,
    prefixes: Vec<String>,
    suffixes: Vec<String>,
    commands: HashSet<String>,
}

pub(in crate::privacy) struct Engine {
    kinds: BTreeMap<String, Category>,
    rules: Vec<Rule>,
    prefilter: Option<AhoCorasick>,
    /// Keyword pattern → rules it lets run.
    by_keyword: Vec<Vec<usize>>,
    /// Rules with no keywords: always run.
    always: Vec<usize>,
    fields: Vec<Field>,
    pub sources: Sources,
    pub structure: StructureDef,
    pub egress: Egress,
    decode: Option<(DecodeDef, decode::Patterns)>,
    pub known: KnownDef,
    packs: Vec<PackInfo>,
}

fn err(pack: &str, what: impl std::fmt::Display) -> EvotError {
    EvotError::Conf(format!("privacy rule pack {pack}: {what}"))
}

/// A problem inside a pack, before the pack and rule are named.
fn bad(what: impl std::fmt::Display) -> EvotError {
    EvotError::Conf(what.to_string())
}

fn message(e: EvotError) -> String {
    match e {
        EvotError::Conf(m) => m,
        other => other.to_string(),
    }
}

/// Everything packs share by name.
#[derive(Default)]
struct Names {
    vars: BTreeMap<String, String>,
    lists: BTreeMap<String, Vec<String>>,
    checks: BTreeMap<String, Check>,
}

impl Names {
    fn list(&self, items: &[String]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for item in items {
            match list_ref(item) {
                Some(name) => out.extend(
                    self.lists
                        .get(name)
                        .ok_or_else(|| bad(format!("no list {name}")))?
                        .iter()
                        .cloned(),
                ),
                None => out.push(item.clone()),
            }
        }
        Ok(out)
    }

    /// `${NAME}` replaced (vars may use vars; a cycle is an error). Only an
    /// unescaped `${` before an upper-case name is a var: `\${` and
    /// `${(?:…)}` stay regex.
    fn expand(&self, pattern: &str) -> Result<String> {
        let mut out = pattern.to_string();
        for _ in 0..64 {
            let Some((start, end, name)) = next_var(&out) else {
                return Ok(out);
            };
            let value = self
                .vars
                .get(&name)
                .ok_or_else(|| bad(format!("no var {name}")))?;
            let value = match list_ref(value) {
                Some(list) => {
                    let words = self.list(&[format!("@{{{list}}}")])?;
                    format!(
                        "(?:{})",
                        words
                            .iter()
                            .map(|w| regex::escape(w))
                            .collect::<Vec<_>>()
                            .join("|")
                    )
                }
                None => value.clone(),
            };
            out.replace_range(start..end, &value);
        }
        Err(bad(format!("vars expand without end in {pattern}")))
    }

    fn cond(&self, check: &CheckRef, cache: &mut BTreeMap<String, Arc<Cond>>) -> Result<Arc<Cond>> {
        let (name, check) = match check {
            CheckRef::Named(name) => (
                Some(name),
                self.checks
                    .get(name)
                    .ok_or_else(|| bad(format!("no check {name}")))?,
            ),
            CheckRef::Inline(check) => (None, check),
        };
        if let Some(cond) = name.and_then(|n| cache.get(n)) {
            return Ok(cond.clone());
        }
        let regex = |p: &Option<String>| -> Result<Option<Regex>> {
            p.as_ref().map(|p| compile(&self.expand(p)?)).transpose()
        };
        let words = self.list(&check.words)?;
        let contains = self.list(&check.contains)?;
        let cond = Arc::new(Cond {
            value: regex(&check.value)?,
            before: regex(&check.before)?,
            after: regex(&check.after)?,
            window: check.window.unwrap_or(DEFAULT_CHECK_WINDOW),
            words: (!words.is_empty()).then(|| words.iter().map(|w| w.to_lowercase()).collect()),
            contains: (!contains.is_empty())
                .then(|| {
                    AhoCorasick::builder()
                        .ascii_case_insensitive(true)
                        .build(&contains)
                })
                .transpose()
                .map_err(bad)?,
            entropy_below: check.entropy_below,
        });
        let empty = cond.value.is_none()
            && cond.before.is_none()
            && cond.after.is_none()
            && cond.words.is_none()
            && cond.contains.is_none()
            && cond.entropy_below.is_none();
        if empty {
            return Err(bad("a check names no condition"));
        }
        if let Some(name) = name {
            cache.insert(name.clone(), cond.clone());
        }
        Ok(cond)
    }
}

/// The first `${NAME}` in `s`: its byte range and name.
fn next_var(s: &str) -> Option<(usize, usize, String)> {
    let bytes = s.as_bytes();
    let mut from = 0;
    while let Some(i) = s[from..].find("${").map(|i| from + i) {
        let escaped = bytes[..i].iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1;
        let name_len = bytes[i + 2..]
            .iter()
            .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || **c == b'_')
            .count();
        let close = i + 2 + name_len;
        if !escaped
            && name_len > 0
            && bytes[i + 2].is_ascii_uppercase()
            && bytes.get(close) == Some(&b'}')
        {
            return Some((i, close + 1, s[i + 2..close].to_string()));
        }
        from = i + 2;
    }
    None
}

fn list_ref(item: &str) -> Option<&str> {
    item.strip_prefix("@{")?.strip_suffix('}')
}

fn compile(pattern: &str) -> Result<Regex> {
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 24)
        .build()
        .map_err(|e| bad(format!("regex {pattern}: {e}")))
}

fn keywords_matcher(words: &[String], kind: MatchKind) -> Result<AhoCorasick> {
    AhoCorasick::builder()
        .match_kind(kind)
        .build(words)
        .map_err(bad)
}

impl Engine {
    /// Merge `packs` into one engine. Any error fails it whole: a rule
    /// missing would send what it exists to stop.
    pub fn compile(packs: &[Pack]) -> Result<Self> {
        let mut names = Names::default();
        let mut kinds: BTreeMap<String, Category> = BTreeMap::new();
        let mut sources = SourcesDef::default();
        let mut structure = StructureDef::default();
        let mut decode_def = None;
        let mut known = None;
        let mut egress_defs = Vec::new();
        let mut infos = Vec::new();
        for pack in packs {
            if pack.schema_version > PACK_SCHEMA_VERSION {
                return Err(err(
                    &pack.id,
                    format!(
                        "schema {} is newer than this evot supports ({PACK_SCHEMA_VERSION})",
                        pack.schema_version
                    ),
                ));
            }
            if let Some(source) = &pack.source {
                if !LICENSES.contains(&source.license.as_str())
                    || source.copyright.trim().is_empty()
                {
                    return Err(err(
                        &pack.id,
                        format!(
                            "source license {} is not one evot may ship with attribution",
                            source.license
                        ),
                    ));
                }
            }
            let unique = |taken: bool, what: &str, name: &str| {
                if taken {
                    Err(err(&pack.id, format!("{what} {name} is defined twice")))
                } else {
                    Ok(())
                }
            };
            for (k, v) in &pack.vars {
                unique(names.vars.insert(k.clone(), v.clone()).is_some(), "var", k)?;
            }
            for (k, v) in &pack.lists {
                unique(
                    names.lists.insert(k.clone(), v.clone()).is_some(),
                    "list",
                    k,
                )?;
            }
            for (k, v) in &pack.checks {
                unique(
                    names.checks.insert(k.clone(), v.clone()).is_some(),
                    "check",
                    k,
                )?;
            }
            for kind in &pack.kinds {
                unique(
                    kinds.insert(kind.name.clone(), kind.category).is_some(),
                    "kind",
                    &kind.name,
                )?;
            }
            if let Some(s) = &pack.sources {
                sources.tools.extend(s.tools.iter().cloned());
                for (to, from) in [
                    (&mut sources.names, &s.names),
                    (&mut sources.prefixes, &s.prefixes),
                    (&mut sources.suffixes, &s.suffixes),
                    (&mut sources.commands, &s.commands),
                ] {
                    to.extend(from.iter().cloned());
                }
            }
            if let Some(s) = &pack.structure {
                for (to, from) in [
                    (&mut structure.skip_keys, &s.skip_keys),
                    (&mut structure.skip_suffixes, &s.skip_suffixes),
                    (&mut structure.binary_keys, &s.binary_keys),
                    (&mut structure.binary_markers, &s.binary_markers),
                    (&mut structure.binary_types, &s.binary_types),
                    (&mut structure.result_id_keys, &s.result_id_keys),
                    (&mut structure.call_args_keys, &s.call_args_keys),
                ] {
                    to.extend(from.iter().cloned());
                }
            }
            if let Some(e) = &pack.egress {
                egress_defs.push(e);
            }
            if pack.decode.is_some() {
                unique(decode_def.is_some(), "decode", "settings")?;
                decode_def = pack.decode.clone();
            }
            if pack.known.is_some() {
                unique(known.is_some(), "known", "settings")?;
                known = pack.known.clone();
            }
            infos.push(PackInfo {
                id: pack.id.clone(),
                rules: pack.rules.len() + pack.fields.len(),
                source: pack.source.as_ref().map(|s| s.url.clone()),
                license: pack.source.as_ref().map(|s| s.license.clone()),
            });
        }
        for builtin in [TERM, SECRET] {
            if !kinds.contains_key(builtin) {
                return Err(err("*", format!("no pack defines kind {builtin}")));
            }
        }
        let category = |pack: &str, kind: &str| {
            kinds
                .get(kind)
                .copied()
                .ok_or_else(|| err(pack, format!("kind {kind} is not defined")))
        };

        let mut cache = BTreeMap::new();
        let mut rules = Vec::new();
        let mut keyword_index: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        let mut always = Vec::new();
        let mut ids = BTreeSet::new();
        let mut fields = Vec::new();
        for pack in packs {
            let conds = |list: &[CheckRef], cache: &mut BTreeMap<String, Arc<Cond>>| {
                list.iter()
                    .map(|c| names.cond(c, cache))
                    .collect::<Result<Vec<_>>>()
            };
            for def in &pack.rules {
                if !ids.insert(def.id.clone()) {
                    return Err(err(&pack.id, format!("rule {} is defined twice", def.id)));
                }
                let at = |e: EvotError| err(&pack.id, format!("rule {}: {}", def.id, message(e)));
                let checksum = def.checksum.clone();
                if let Some(c) = &checksum {
                    if !checksum::known(&c.algorithm) {
                        return Err(at(EvotError::Conf(format!("no checksum {}", c.algorithm))));
                    }
                }
                let context = match &def.context {
                    Some(ctx) => Some(Context {
                        words: keywords_matcher(
                            &names
                                .list(&ctx.words)
                                .map_err(at)?
                                .iter()
                                .map(|w| w.to_lowercase())
                                .collect::<Vec<_>>(),
                            MatchKind::Standard,
                        )
                        .map_err(at)?,
                        window: ctx.window,
                        required: ctx.required,
                        confidence: ctx.confidence,
                    }),
                    None => None,
                };
                let index = rules.len();
                let keywords = names.list(&def.keywords).map_err(at)?;
                if keywords.is_empty() {
                    always.push(index);
                }
                for word in keywords {
                    keyword_index
                        .entry(word.to_lowercase())
                        .or_default()
                        .push(index);
                }
                rules.push(Rule {
                    id: def.id.clone(),
                    kind: def.kind.clone(),
                    category: category(&pack.id, &def.kind)?,
                    confidence: def.confidence,
                    re: compile(&names.expand(&def.regex).map_err(at)?).map_err(at)?,
                    group: def.group,
                    bound: def
                        .bound
                        .as_ref()
                        .map(|class| names.expand(class).and_then(|c| compile(&format!("^{c}$"))))
                        .transpose()
                        .map_err(at)?,
                    scope: def.scope,
                    when: conds(&def.when, &mut cache).map_err(at)?,
                    unless: conds(&def.unless, &mut cache).map_err(at)?,
                    context,
                    checksum,
                    examples: def.examples.clone(),
                });
            }
            for def in &pack.fields {
                if !ids.insert(def.id.clone()) {
                    return Err(err(&pack.id, format!("field {} is defined twice", def.id)));
                }
                let at = |e: EvotError| err(&pack.id, format!("field {}: {}", def.id, message(e)));
                let key = names.expand(&def.key).map_err(at)?;
                // How a key is written in prose is the packs' `FIELD_TEXT`.
                let text = def
                    .text
                    .then(|| {
                        let template = names
                            .vars
                            .get("FIELD_TEXT")
                            .ok_or_else(|| bad("no pack sets var FIELD_TEXT"))?;
                        compile(&names.expand(&template.replace("${KEY}", &key))?)
                    })
                    .transpose()
                    .map_err(at)?;
                fields.push(Field {
                    id: def.id.clone(),
                    kind: def.kind.clone(),
                    category: category(&pack.id, &def.kind)?,
                    confidence: def.confidence,
                    key: compile(&format!("^(?:{key})$")).map_err(at)?,
                    key_unless: def
                        .key_unless
                        .as_ref()
                        .map(|p| names.expand(p).and_then(|p| compile(&p)))
                        .transpose()
                        .map_err(at)?,
                    text,
                    when: conds(&def.when, &mut cache).map_err(at)?,
                    unless: conds(&def.unless, &mut cache).map_err(at)?,
                    examples: def.examples.clone(),
                });
            }
        }
        let words: Vec<String> = keyword_index.keys().cloned().collect();
        let by_keyword: Vec<Vec<usize>> = keyword_index.into_values().collect();
        let prefilter = (!words.is_empty())
            .then(|| keywords_matcher(&words, MatchKind::Standard))
            .transpose()?;
        let egress = Egress::compile(&egress_defs, &|p| compile(&names.expand(p)?), &|items| {
            names.list(items)
        })
        .map_err(|e| err("*", format!("egress: {}", message(e))))?;
        for kind in EGRESS_KINDS {
            if !kinds.contains_key(*kind) {
                return Err(err("*", format!("no pack defines kind {kind}")));
            }
        }
        let decode = match decode_def {
            Some(def) => Some((def, decode::Patterns::new()?)),
            None => None,
        };
        Ok(Self {
            kinds,
            rules,
            prefilter,
            by_keyword,
            always,
            fields,
            sources: Sources {
                tools: sources
                    .tools
                    .into_iter()
                    .map(|t| (t.name.to_ascii_lowercase(), t.path_args, t.command_arg))
                    .collect(),
                names: sources
                    .names
                    .into_iter()
                    .map(|n| n.to_ascii_lowercase())
                    .collect(),
                prefixes: sources.prefixes,
                suffixes: sources.suffixes,
                commands: sources.commands.into_iter().collect(),
            },
            structure,
            egress,
            decode,
            known: known.ok_or_else(|| err("*", "no pack sets known"))?,
            packs: infos,
        })
    }

    pub fn packs(&self) -> &[PackInfo] {
        &self.packs
    }

    pub fn kinds(&self) -> Vec<KindInfo> {
        self.kinds
            .iter()
            .map(|(kind, category)| KindInfo {
                kind: kind.clone(),
                category: *category,
            })
            .collect()
    }

    pub fn category(&self, kind: &str) -> Category {
        self.kinds.get(kind).copied().unwrap_or(Category::Secret)
    }

    /// Every value the rules find in `text` (plus the field rules for the
    /// field holding it, and what encoded runs hide).
    pub fn find(&self, text: &str, source: &Source<'_>) -> Vec<Span> {
        self.find_at(text, source, 0)
    }

    fn find_at(&self, text: &str, source: &Source<'_>, depth: usize) -> Vec<Span> {
        let mut found = Vec::new();
        if text.len() < 3 {
            return found;
        }
        let lower = text.to_ascii_lowercase();
        for index in self.candidates(&lower) {
            let rule = &self.rules[index];
            if !(source.covers)(rule.category)
                || (rule.scope == Scope::Sensitive && !source.sensitive)
            {
                continue;
            }
            for caps in rule.re.captures_iter(text) {
                let m = if rule.group > 0 {
                    caps.get(rule.group)
                } else {
                    (1..caps.len())
                        .find_map(|i| caps.get(i))
                        .or_else(|| caps.get(0))
                };
                let Some(m) = m else { continue };
                if let Some(confidence) = rule.accept(text, &lower, m.start(), m.end()) {
                    found.push(
                        Span::new(m.start(), m.end(), &rule.kind, Finder::Rule)
                            .rule(&rule.id, confidence),
                    );
                }
            }
        }
        for field in &self.fields {
            if !(source.covers)(field.category) {
                continue;
            }
            if let Some(key) = source.field {
                let key = key.to_lowercase();
                let named = field.key.is_match(&key)
                    && !field
                        .key_unless
                        .as_ref()
                        .is_some_and(|re| re.is_match(&key));
                let (a, b) = trimmed(text);
                if named && field.accept(text, a, b) {
                    found.push(
                        Span::new(a, b, &field.kind, Finder::Field)
                            .rule(&field.id, field.confidence),
                    );
                }
            }
            if let Some(re) = &field.text {
                for caps in re.captures_iter(text) {
                    let Some(m) = caps.get(1) else { continue };
                    let (a, b) = trimmed(m.as_str());
                    let (a, b) = (m.start() + a, m.start() + b);
                    if field.accept(text, a, b) {
                        found.push(
                            Span::new(a, b, &field.kind, Finder::Field)
                                .rule(&field.id, field.confidence),
                        );
                    }
                }
            }
        }
        if let Some((def, patterns)) = &self.decode {
            if depth < def.depth {
                for (a, b, decoded) in patterns.runs(text, def) {
                    let inner = Source {
                        sensitive: source.sensitive,
                        field: None,
                        covers: source.covers,
                    };
                    if let Some(hit) = self.find_at(&decoded, &inner, depth + 1).into_iter().next()
                    {
                        let id = hit.rule.clone().unwrap_or_default();
                        found.push(
                            Span::new(a, b, &hit.kind, Finder::Decoded).rule(&id, hit.confidence),
                        );
                    }
                }
            }
        }
        found
    }

    fn candidates(&self, lower: &str) -> Vec<usize> {
        let mut set: BTreeSet<usize> = self.always.iter().copied().collect();
        if let Some(ac) = &self.prefilter {
            let mut seen = vec![false; self.by_keyword.len()];
            for m in ac.find_overlapping_iter(lower) {
                let p = m.pattern().as_usize();
                if !std::mem::replace(&mut seen[p], true) {
                    set.extend(self.by_keyword[p].iter().copied());
                }
            }
        }
        set.into_iter().collect()
    }

    /// The shell command a tool call runs (a `sources` tool's `command_arg`).
    pub fn shell_command<'a>(
        &self,
        name: &str,
        arguments: &'a serde_json::Value,
    ) -> Option<&'a str> {
        let name = name.to_ascii_lowercase();
        self.sources
            .tools
            .iter()
            .filter(|t| t.0 == name)
            .find_map(|(_, _, command)| arguments.get(command.as_deref()?)?.as_str())
    }

    /// A tool call whose output is a secrets file or the environment.
    pub fn sensitive_call(&self, name: &str, arguments: &serde_json::Value) -> bool {
        let name = name.to_ascii_lowercase();
        let arg = |key: &str| arguments.get(key).and_then(|v| v.as_str());
        self.sources
            .tools
            .iter()
            .filter(|t| t.0 == name)
            .any(|(_, paths, command)| {
                paths
                    .iter()
                    .filter_map(|key| arg(key))
                    .any(|p| self.sensitive_path(p))
                    || command.as_deref().and_then(arg).is_some_and(|command| {
                        command
                            .split(|c: char| c.is_whitespace() || ";|&<>()'\"`".contains(c))
                            .any(|word| {
                                self.sources.commands.contains(word) || self.sensitive_path(word)
                            })
                    })
            })
    }

    pub fn sensitive_path(&self, path: &str) -> bool {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let name = if name.bytes().any(|byte| byte.is_ascii_uppercase()) {
            std::borrow::Cow::Owned(name.to_ascii_lowercase())
        } else {
            std::borrow::Cow::Borrowed(name)
        };
        !name.is_empty()
            && (self.sources.names.contains(name.as_ref())
                || self
                    .sources
                    .prefixes
                    .iter()
                    .any(|p| name.starts_with(p.as_str()))
                || self
                    .sources
                    .suffixes
                    .iter()
                    .any(|s| name.ends_with(s.as_str())))
    }

    /// Every pack example that does not do what it says, as messages.
    pub fn self_test(&self) -> Vec<String> {
        let all = |_: Category| true;
        let mut failures = Vec::new();
        let finds_by = |id: &str, text: &str, field: Option<&str>| {
            let source = Source {
                sensitive: true,
                field,
                covers: &all,
            };
            self.find(text, &source)
                .iter()
                .any(|s| s.rule.as_deref() == Some(id))
        };
        for rule in &self.rules {
            let finds = |text: &str| finds_by(&rule.id, text, None);
            failures.extend(
                rule.examples
                    .matches
                    .iter()
                    .filter(|t| !finds(t))
                    .map(|t| format!("{} misses {t:?}", rule.id)),
            );
            failures.extend(
                rule.examples
                    .ignores
                    .iter()
                    .filter(|t| finds(t))
                    .map(|t| format!("{} takes {t:?}", rule.id)),
            );
        }
        for field in &self.fields {
            let finds = |example: &str| {
                let (key, value) = example.split_once(": ").unwrap_or(("", example));
                finds_by(&field.id, value, Some(key))
            };
            failures.extend(
                field
                    .examples
                    .matches
                    .iter()
                    .filter(|t| !finds(t))
                    .map(|t| format!("{} misses {t:?}", field.id)),
            );
            failures.extend(
                field
                    .examples
                    .ignores
                    .iter()
                    .filter(|t| finds(t))
                    .map(|t| format!("{} takes {t:?}", field.id)),
            );
        }
        failures.extend(self.egress.self_test());
        failures
    }
}

impl Rule {
    /// The value at text[a..b] passes this rule's checks: at what confidence.
    fn accept(&self, text: &str, lower: &str, a: usize, b: usize) -> Option<Confidence> {
        if b <= a {
            return None;
        }
        if let Some(bound) = &self.bound {
            let before = text[..a].chars().next_back();
            let after = text[b..].chars().next();
            let touches =
                |c: Option<char>| c.is_some_and(|c| bound.is_match(c.encode_utf8(&mut [0; 4])));
            if touches(before) || touches(after) {
                return None;
            }
        }
        if !self.when.iter().all(|c| c.holds(text, a, b))
            || self.unless.iter().any(|c| c.holds(text, a, b))
        {
            return None;
        }
        let mut confidence = self.confidence;
        if let Some(ctx) = &self.context {
            let near = &lower[floor(lower, a.saturating_sub(ctx.window))..a];
            let after = &lower[b..ceil(lower, b + ctx.window)];
            let found = ctx.words.is_match(near) || ctx.words.is_match(after);
            if ctx.required && !found {
                return None;
            }
            if found {
                confidence = ctx.confidence.unwrap_or(match confidence {
                    Confidence::Low => Confidence::Medium,
                    _ => Confidence::High,
                });
            }
        }
        if let Some(sum) = &self.checksum {
            if checksum::verify(&sum.algorithm, &text[a..b]) {
                confidence = sum.confirmed.unwrap_or(confidence);
            } else if !sum.keep_on_fail {
                return None;
            }
        }
        Some(confidence)
    }
}

impl Field {
    fn accept(&self, text: &str, a: usize, b: usize) -> bool {
        b > a
            && self.when.iter().all(|c| c.holds(text, a, b))
            && !self.unless.iter().any(|c| c.holds(text, a, b))
    }
}

impl Cond {
    fn holds(&self, text: &str, a: usize, b: usize) -> bool {
        let value = &text[a..b];
        let before = &text[floor(text, a.saturating_sub(self.window))..a];
        let after = &text[b..ceil(text, b + self.window)];
        self.value.as_ref().is_none_or(|re| re.is_match(value))
            && self.before.as_ref().is_none_or(|re| re.is_match(before))
            && self.after.as_ref().is_none_or(|re| re.is_match(after))
            && self
                .words
                .as_ref()
                .is_none_or(|words| only_words(value, words))
            && self.contains.as_ref().is_none_or(|ac| ac.is_match(value))
            && self
                .entropy_below
                .is_none_or(|limit| entropy(value) < limit)
    }
}

/// The value's letter runs (split at case changes) are all listed words.
fn only_words(value: &str, words: &HashSet<String>) -> bool {
    let mut runs = Vec::new();
    let mut run = String::new();
    let mut prev_lower = false;
    for c in value.chars() {
        if !c.is_alphabetic() || (c.is_uppercase() && prev_lower) {
            if run.chars().count() >= 2 {
                runs.push(std::mem::take(&mut run));
            }
            run.clear();
        }
        prev_lower = c.is_lowercase();
        if c.is_alphabetic() {
            run.extend(c.to_lowercase());
        }
    }
    if run.chars().count() >= 2 {
        runs.push(run);
    }
    !runs.is_empty() && runs.iter().all(|r| words.contains(r))
}

fn entropy(value: &str) -> f64 {
    let mut counts: BTreeMap<char, usize> = BTreeMap::new();
    let mut n = 0usize;
    for c in value.chars() {
        *counts.entry(c).or_default() += 1;
        n += 1;
    }
    if n == 0 {
        return 0.0;
    }
    counts
        .values()
        .map(|&k| {
            let p = k as f64 / n as f64;
            -p * p.log2()
        })
        .sum()
}

fn trimmed(text: &str) -> (usize, usize) {
    let start = text.len() - text.trim_start().len();
    (start, text.trim_end().len().max(start))
}

fn floor(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}
