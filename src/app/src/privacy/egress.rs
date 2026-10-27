//! The egress guard: what a tool call would send off the machine, decided
//! before it runs, from what its arguments say. Every tool goes through
//! it ([`super::guard`]); the packs' `egress` says which tools stay on the
//! machine, which shell commands send, where they send to and what they
//! write.
//!
//! A call carries a secret when its arguments hold one (a rule finds it,
//! or it is a value masked before), name a variable holding one, read a
//! secrets file or the whole environment, or name a file an earlier call
//! wrote a secret into. Such a call is refused when it may send, unless
//! every host it names is on this machine or one the user trusts
//! (`egress_allow`). Shell code that is decoded into execution is refused
//! whatever it carries: what it runs cannot be read first.
//!
//! What this cannot see: a program that reads the environment itself
//! (`npm test`, a script already on disk) and sends what it finds. Only
//! what the call's own text shows is judged.
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::policy::Action;
use super::policy::Policy;
use super::rules::Category;
use super::rules::Confidence;
use super::rules::Source;
use super::rules::HIDDEN_CODE;
use super::rules::SECRET_ENV;
use super::rules::SECRET_FILE;
use super::scan::Finder;
use super::scan::Hit;
use super::shadow::ShadowCounters;
use super::state::TaintOrigin;
use super::vault::Vault;

/// Past this a token is not a path.
const MAX_PATH: usize = 4096;

/// A file the call reads that an earlier call wrote a secret into, with
/// why it is marked. `path` is as the user would type it to `/privacy
/// untaint`: relative to `cwd` when under it, absolute otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaintedFile {
    pub path: String,
    pub origin: TaintOrigin,
}

/// What a call carries, each thing once.
struct Carried<'a> {
    vault: &'a Vault,
    hits: Vec<Hit>,
    tags: BTreeSet<String>,
    /// The values themselves, to keep a host that holds one out of the
    /// notice. Never leaves this check.
    values: Vec<String>,
    /// Files read that an earlier call marked, for the notice.
    tainted: Vec<TaintedFile>,
    cancel: Option<&'a CancellationToken>,
}

/// What a call may not do, and what the notice needs to say why and what
/// the user can do: the one remote host it named, when that host is safe
/// to show (it carries no value); the program that makes it send; the
/// marked files it reads.
pub(super) struct Verdict {
    pub hits: Vec<Hit>,
    pub host: Option<String>,
    pub sender: Option<String>,
    pub tainted: Vec<TaintedFile>,
}

impl Verdict {
    fn clear() -> Self {
        Self {
            hits: Vec::new(),
            host: None,
            sender: None,
            tainted: Vec::new(),
        }
    }
}

impl<'a> Carried<'a> {
    fn new(vault: &'a Vault, cancel: Option<&'a CancellationToken>) -> Self {
        Self {
            vault,
            hits: Vec::new(),
            tags: BTreeSet::new(),
            values: Vec::new(),
            tainted: Vec::new(),
            cancel,
        }
    }

    /// Why the files this call writes will be marked: the first thing it
    /// carries, which is what the record names too.
    fn origin(&self, tool: &str) -> Option<TaintOrigin> {
        let first = self.hits.first()?;
        Some(TaintOrigin {
            kind: first.kind.clone(),
            rule: first.rule.clone(),
            tool: tool.to_string(),
        })
    }

    fn add(
        &mut self,
        kind: &str,
        by: Finder,
        rule: &str,
        confidence: Confidence,
        value: &str,
        note: Option<String>,
    ) {
        let tag = self.vault.tag(kind, value);
        if self.tags.insert(tag.clone()) {
            self.values.push(value.to_string());
            self.hits.push(Hit {
                kind: kind.to_string(),
                by,
                rule: Some(rule.to_string()),
                confidence,
                action: Action::Block,
                tag,
                len: value.chars().count(),
                note,
            });
        }
    }

    /// Showing `host` to the user gives nothing away.
    fn safe_host(&self, host: &str) -> bool {
        !self
            .values
            .iter()
            .any(|value| host.contains(value.to_ascii_lowercase().as_str()) || value.contains(host))
    }

    fn with(mut self, action: Action) -> Vec<Hit> {
        for hit in &mut self.hits {
            hit.action = action;
        }
        self.hits
    }
}

/// What a call to `tool` with `arguments`, run in `cwd`, may not do. Each
/// hit blocks the call, or is a warning when the user trusts every host
/// it sends to; none means it goes ahead unrecorded. A call allowed to
/// write what it carries taints the files it writes.
pub(super) fn check(
    policy: &Policy,
    vault: &Vault,
    shadow: &ShadowCounters,
    tool: &str,
    arguments: &Value,
    cwd: &Path,
    cancel: Option<&CancellationToken>,
) -> Verdict {
    if cancel.is_some_and(CancellationToken::is_cancelled) || policy.egress_allows_all() {
        return Verdict::clear();
    }
    let engine = policy.engine.as_ref();
    let egress = &engine.egress;
    let command = engine.shell_command(tool, arguments);
    if let Some(code) = command.and_then(|c| egress.hidden(c)) {
        let mut hidden = Carried::new(vault, cancel);
        hidden.add(
            HIDDEN_CODE,
            Finder::Egress,
            "egress.hidden",
            Confidence::High,
            &code,
            None,
        );
        return Verdict {
            hits: hidden.with(Action::Block),
            host: None,
            sender: None,
            tainted: Vec::new(),
        };
    }
    let writer = egress.writer_paths(tool, arguments);
    let path_keys = egress.writer_keys(tool);
    let mut texts = Vec::new();
    strings(arguments, None, &mut texts);
    let mut carried = Carried::new(vault, cancel);
    let tainted = vault.tainted_names();
    for (field, text) in &texts {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Verdict::clear();
        }
        if field.is_some_and(|f| path_keys.iter().any(|k| k == f)) {
            continue;
        }
        carries(policy, vault, &tainted, text, *field, cwd, &mut carried);
    }
    drop(tainted);
    if cancel.is_some_and(CancellationToken::is_cancelled) || carried.hits.is_empty() {
        return Verdict::clear();
    }
    let writes: Vec<String> = match (writer, command) {
        (Some(paths), _) => paths,
        (None, Some(command)) => egress
            .writes(command)
            .into_iter()
            .map(|(_, _, path)| path)
            .collect(),
        (None, None) => Vec::new(),
    };
    let sends = !egress.is_local(tool) && command.is_none_or(|c| egress.sends(c));
    let origin = carried.origin(tool);
    if !sends {
        if command.is_some() {
            shadow.shell_unclassified();
        }
        taint(policy, vault, &writes, origin, cwd, cancel);
        return Verdict::clear();
    }
    let sender = command.and_then(|c| egress.sender(c));
    let mut named = None;
    let offsite = if policy.egress_allows_tool(tool) {
        Some(true)
    } else {
        // Where it sends, from its own text: a file it writes is no host.
        let text = match command {
            Some(command) => without_writes(command, egress.writes(command)),
            None => texts
                .iter()
                .map(|(_, text)| text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        };
        let hosts = egress.destinations(&text);
        let trusted = !egress.reroutes(&text)
            && !hosts.is_empty()
            && hosts
                .iter()
                .all(|h| egress.local_host(h) || policy.egress_allows_host(h));
        if trusted {
            // Evidence for a future policy, not authorization for a new one.
            shadow.text_destination();
        }
        // The one remote host it would send to, for the notice to name.
        let mut remote = hosts.iter().filter(|h| !egress.local_host(h));
        if let (Some(host), None) = (remote.next(), remote.next()) {
            if !egress.reroutes(&text) && carried.safe_host(host) {
                named = Some(host.clone());
            }
        }
        trusted.then(|| hosts.iter().any(|h| !egress.local_host(h)))
    };
    match offsite {
        None => {
            let tainted = std::mem::take(&mut carried.tainted);
            Verdict {
                hits: carried.with(Action::Block),
                host: named,
                sender,
                tainted,
            }
        }
        Some(offsite) => {
            taint(policy, vault, &writes, origin, cwd, cancel);
            if offsite {
                let tainted = std::mem::take(&mut carried.tainted);
                Verdict {
                    hits: carried.with(Action::Warn),
                    host: named,
                    sender,
                    tainted,
                }
            } else {
                Verdict::clear()
            }
        }
    }
}

/// What one argument string carries.
fn carries(
    policy: &Policy,
    vault: &Vault,
    tainted: &HashSet<String>,
    text: &str,
    field: Option<&str>,
    cwd: &Path,
    carried: &mut Carried<'_>,
) {
    let engine = policy.engine.as_ref();
    let egress = &engine.egress;
    let secret = |category: Category| category == Category::Secret;
    let source = Source {
        sensitive: false,
        field,
        covers: &secret,
    };
    let mut spans = engine.find(text, &source);
    spans.extend(
        vault
            .known_spans(text)
            .into_iter()
            .filter(|span| policy.is_secret(&span.kind)),
    );
    for span in spans {
        let value = &text[span.start..span.end];
        if policy.allows(value) || policy.action(&span.kind, span.confidence) == Action::Warn {
            continue;
        }
        let rule = span.rule.as_deref().unwrap_or("known");
        carried.add(&span.kind, span.by, rule, span.confidence, value, None);
    }
    for name in egress.env_refs(text) {
        if vault.is_secret_env(&name) || egress.secret_env(&name) {
            carried.add(
                SECRET_ENV,
                Finder::Egress,
                "egress.env",
                Confidence::High,
                &name,
                Some(format!("${name}")),
            );
        }
    }
    if egress.dumps_env(text) {
        carried.add(
            SECRET_FILE,
            Finder::Egress,
            "egress.environment",
            Confidence::High,
            "environment",
            None,
        );
    }
    for token in tokens(text) {
        let sensitive = engine.sensitive_path(token);
        let name = token.rsplit('/').next().unwrap_or(token);
        if !sensitive && !tainted.contains(name) {
            continue;
        }
        // Only candidate paths may touch the filesystem. Checking the
        // token's cancellation mutex for every ordinary code word is costly.
        if carried.cancel.is_some_and(CancellationToken::is_cancelled) {
            return;
        }
        let path = resolve(cwd, token);
        let shown = path.to_string_lossy();
        let origin = vault.taint_origin(&shown);
        if origin.is_some() || (sensitive && path.exists()) {
            if let Some(origin) = origin {
                let typed = path
                    .strip_prefix(cwd)
                    .map(|rel| rel.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| shown.to_string());
                if !carried.tainted.iter().any(|t| t.path == typed) {
                    carried.tainted.push(TaintedFile {
                        path: typed,
                        origin,
                    });
                }
            }
            carried.add(
                SECRET_FILE,
                Finder::Egress,
                "egress.file",
                Confidence::High,
                &shown,
                Some(
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| shown.to_string()),
                ),
            );
        }
    }
}

/// Remember that each of `paths` now holds a secret. A cancelled call never
/// ran, so it wrote nothing: recording its files would only block them later.
fn taint(
    policy: &Policy,
    vault: &Vault,
    paths: &[String],
    origin: Option<TaintOrigin>,
    cwd: &Path,
    cancel: Option<&CancellationToken>,
) {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return;
    }
    let Some(origin) = origin else {
        return;
    };
    for path in paths {
        let path = resolve(cwd, path);
        let path = path.to_string_lossy();
        if !policy.engine.egress.untainted(&path) {
            vault.taint(&path, origin.clone());
        }
    }
}

/// `command` with the files it writes blanked out.
fn without_writes(command: &str, writes: Vec<(usize, usize, String)>) -> String {
    let mut out = command.to_string();
    let mut spans: Vec<(usize, usize)> = writes.into_iter().map(|(a, b, _)| (a, b)).collect();
    spans.sort_unstable_by(|x, y| y.cmp(x));
    for (a, b) in spans {
        if b <= out.len() && out.is_char_boundary(a) && out.is_char_boundary(b) {
            out.replace_range(a..b, &" ".repeat(b - a));
        }
    }
    out
}

/// Every string in `value`, with the name of the field holding it.
fn strings<'a>(
    value: &'a Value,
    field: Option<&'a str>,
    out: &mut Vec<(Option<&'a str>, &'a String)>,
) {
    match value {
        Value::String(text) => out.push((field, text)),
        Value::Array(items) => items.iter().for_each(|item| strings(item, field, out)),
        Value::Object(map) => map
            .iter()
            .for_each(|(key, item)| strings(item, Some(key), out)),
        _ => {}
    }
}

/// The words of `text` that may name a file.
fn tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || ";|&<>()'\"`=,".contains(c))
        .map(|word| {
            let word = word.strip_prefix("file://").unwrap_or(word);
            word.trim_start_matches('@')
        })
        .filter(|word| !word.is_empty() && word.len() <= MAX_PATH && !word.starts_with('-'))
}

/// `path` made absolute against `cwd` (and `~`), `.` and `..` folded.
pub(super) fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let joined = match path.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME") {
            Some(home) => PathBuf::from(home).join(rest),
            None => cwd.join(path),
        },
        None => cwd.join(path),
    };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
