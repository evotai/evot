//! The packs' `egress` compiled: what a tool call sends, writes and names.
//! Pure matching; what is done about it is `privacy::egress`.
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;

use regex::Regex;
use serde_json::Value;

use super::pack::EgressDef;
use super::pack::EgressExamples;
use crate::error::Result;

pub(in crate::privacy) struct Egress {
    local: HashSet<String>,
    /// Writer tool → the arguments naming its file.
    writers: HashMap<String, Vec<String>>,
    senders: Vec<Regex>,
    hidden: Vec<Regex>,
    reroute: Vec<Regex>,
    writes: Vec<Regex>,
    untainted: Vec<String>,
    env_refs: Vec<Regex>,
    env_dumps: Vec<Regex>,
    secret_env: Vec<Regex>,
    secret_env_unless: Vec<Regex>,
    destinations: Vec<Regex>,
    local_hosts: Vec<String>,
    examples: EgressExamples,
}

impl Egress {
    /// Merge every pack's `egress`; `regex` compiles a pattern with the
    /// packs' vars expanded, `list` expands `@{list}` items.
    pub(super) fn compile(
        defs: &[&EgressDef],
        regex: &dyn Fn(&str) -> Result<Regex>,
        list: &dyn Fn(&[String]) -> Result<Vec<String>>,
    ) -> Result<Self> {
        let patterns = |pick: fn(&EgressDef) -> &Vec<String>| -> Result<Vec<Regex>> {
            let mut out = Vec::new();
            for def in defs {
                for pattern in list(pick(def))? {
                    out.push(regex(&pattern)?);
                }
            }
            Ok(out)
        };
        let words = |pick: fn(&EgressDef) -> &Vec<String>| -> Result<Vec<String>> {
            let mut out = Vec::new();
            for def in defs {
                out.extend(list(pick(def))?.into_iter().map(|w| w.to_ascii_lowercase()));
            }
            Ok(out)
        };
        let mut writers = HashMap::new();
        let mut examples = EgressExamples::default();
        for def in defs {
            for writer in &def.writers {
                writers.insert(writer.name.to_ascii_lowercase(), writer.path_args.clone());
            }
            examples.sends.extend(def.examples.sends.iter().cloned());
            examples.quiet.extend(def.examples.quiet.iter().cloned());
            examples.hidden.extend(def.examples.hidden.iter().cloned());
        }
        Ok(Self {
            local: words(|d| &d.local)?.into_iter().collect(),
            writers,
            senders: patterns(|d| &d.senders)?,
            hidden: patterns(|d| &d.hidden)?,
            reroute: patterns(|d| &d.reroute)?,
            writes: patterns(|d| &d.writes)?,
            untainted: defs
                .iter()
                .flat_map(|d| d.untainted.iter().cloned())
                .collect(),
            env_refs: patterns(|d| &d.env_refs)?,
            env_dumps: patterns(|d| &d.env_dumps)?,
            secret_env: patterns(|d| &d.secret_env)?,
            secret_env_unless: patterns(|d| &d.secret_env_unless)?,
            destinations: patterns(|d| &d.destinations)?,
            local_hosts: words(|d| &d.local_hosts)?,
            examples,
        })
    }

    /// A tool that sends nothing off the machine (writers included).
    pub fn is_local(&self, tool: &str) -> bool {
        let tool = tool.to_ascii_lowercase();
        self.local.contains(&tool) || self.writers.contains_key(&tool)
    }

    /// The files a writer tool call writes, or `None` for any other tool.
    pub fn writer_paths(&self, tool: &str, arguments: &Value) -> Option<Vec<String>> {
        let keys = self.writers.get(&tool.to_ascii_lowercase())?;
        Some(
            keys.iter()
                .filter_map(|key| arguments.get(key).and_then(Value::as_str))
                .map(str::to_string)
                .collect(),
        )
    }

    /// The names of a writer's path arguments.
    pub fn writer_keys(&self, tool: &str) -> &[String] {
        self.writers
            .get(&tool.to_ascii_lowercase())
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// A shell command that sends: a network program, or code it runs.
    pub fn sends(&self, command: &str) -> bool {
        self.senders.iter().any(|re| re.is_match(command))
    }

    /// Code decoded into execution, which cannot be read before it runs.
    pub fn hidden(&self, command: &str) -> Option<String> {
        self.hidden
            .iter()
            .find_map(|re| re.find(command))
            .map(|m| m.as_str().to_string())
    }

    /// Sends through a host the text does not name.
    pub fn reroutes(&self, text: &str) -> bool {
        self.reroute.iter().any(|re| re.is_match(text))
    }

    /// The files a shell command writes, and where they sit in it.
    pub fn writes(&self, command: &str) -> Vec<(usize, usize, String)> {
        self.writes
            .iter()
            .flat_map(|re| re.captures_iter(command))
            .filter_map(|caps| {
                let m = caps.name("path")?;
                Some((m.start(), m.end(), m.as_str().to_string()))
            })
            .collect()
    }

    /// A path a write never taints.
    pub fn untainted(&self, path: &str) -> bool {
        self.untainted.iter().any(|prefix| path.starts_with(prefix))
    }

    /// The environment variables `text` names.
    pub fn env_refs(&self, text: &str) -> BTreeSet<String> {
        self.env_refs
            .iter()
            .flat_map(|re| re.captures_iter(text))
            .filter_map(|caps| Some(caps.name("name")?.as_str().to_string()))
            .collect()
    }

    /// The whole environment printed or read at once.
    pub fn dumps_env(&self, text: &str) -> bool {
        self.env_dumps.iter().any(|re| re.is_match(text))
    }

    /// A variable whose name says it holds a secret.
    pub fn secret_env(&self, name: &str) -> bool {
        self.secret_env.iter().any(|re| re.is_match(name))
            && !self.secret_env_unless.iter().any(|re| re.is_match(name))
    }

    /// The hosts `text` sends to, lower-case, without a trailing dot.
    pub fn destinations(&self, text: &str) -> BTreeSet<String> {
        self.destinations
            .iter()
            .flat_map(|re| re.captures_iter(text))
            .filter_map(|caps| {
                let host = caps.name("host")?.as_str();
                let host = host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .trim_end_matches('.')
                    .to_ascii_lowercase();
                (!host.is_empty()).then_some(host)
            })
            .collect()
    }

    /// A host on this machine.
    pub fn local_host(&self, host: &str) -> bool {
        self.local_hosts
            .iter()
            .any(|pattern| host_matches(pattern, host))
    }

    /// Every example that does not do what it says, as messages.
    pub fn self_test(&self) -> Vec<String> {
        let mut failures = Vec::new();
        for command in &self.examples.sends {
            if !self.sends(command) {
                failures.push(format!("egress senders miss {command:?}"));
            }
        }
        for command in &self.examples.quiet {
            if self.sends(command) {
                failures.push(format!("egress senders take {command:?}"));
            }
        }
        for command in &self.examples.hidden {
            if self.hidden(command).is_none() {
                failures.push(format!("egress hidden misses {command:?}"));
            }
        }
        failures
    }
}

/// `host` is `pattern`, or under it when the pattern is `*.suffix`.
pub(in crate::privacy) fn host_matches(pattern: &str, host: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
        None => pattern == host,
    }
}
