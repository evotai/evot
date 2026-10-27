//! The record of what was masked, warned of or blocked, for `/privacy`.
//!
//! No part of a value is ever written: each entry keeps its placeholder (a
//! keyed hash the vendor already sees), kind, rule, confidence and length.
//! Lines from builds that kept a `head` still read; the field is ignored.
//! One day is one JSONL file under `~/.evotai/privacy/records`, appended a line per
//! request or upload, kept [`KEEP_DAYS`] days.
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;

use super::policy::Action;
use super::rules::Confidence;
use super::scan::Finder;
use super::scan::Hit;
use crate::error::Result;

pub const RECORD_SCHEMA_VERSION: u32 = 1;
const KEEP_DAYS: i64 = 30;
const RECENT: usize = 10;

/// Where the data was going.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Llm,
    Share,
    Sync,
    /// A cloud task's definition (its instruction).
    Task,
    /// A cloud task run's result and error, reported to the server.
    TaskReport,
    /// A reply sent to a chat channel (Feishu).
    Delivery,
    /// A tool call that would send a secret off the machine: refused
    /// before it ran, or let through to a host the user trusts (warned).
    Egress,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub v: u32,
    pub time: String,
    pub target: Target,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The tool whose call this was (an egress record).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default)]
    pub blocked: bool,
    #[serde(default)]
    pub values: Vec<ValueRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValueRecord {
    pub kind: String,
    pub by: Finder,
    /// The pack rule that found it (`secrets.jwt`, `betterleaks.github-pat`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(default)]
    pub confidence: Confidence,
    pub action: Action,
    pub tag: String,
    /// Length in characters; nothing of the value itself is recorded.
    pub len: usize,
    /// Places the request had it.
    pub n: usize,
    /// A safe label: a variable's name (`$NAME`), a file's name. Never a
    /// piece of the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Record {
    /// One record for a request's hits, each value once with its count.
    pub(super) fn new(target: Target, hits: &[Hit]) -> Self {
        let mut values: Vec<ValueRecord> = Vec::new();
        for hit in hits {
            match values.iter_mut().find(|v| v.tag == hit.tag) {
                Some(value) => value.n += 1,
                None => values.push(ValueRecord {
                    kind: hit.kind.clone(),
                    by: hit.by,
                    rule: hit.rule.clone(),
                    confidence: hit.confidence,
                    action: hit.action,
                    tag: hit.tag.clone(),
                    len: hit.len,
                    n: 1,
                    note: hit.note.clone(),
                }),
            }
        }
        Self {
            v: RECORD_SCHEMA_VERSION,
            time: chrono::Local::now().to_rfc3339(),
            target,
            session: None,
            provider: None,
            model: None,
            tool: None,
            blocked: values.iter().any(|v| v.action == Action::Block),
            values,
        }
    }

    /// Every value not merely warned of blocks it (a task definition).
    pub(super) fn block_all_but_warned(&mut self) {
        for value in &mut self.values {
            if value.action == Action::Mask {
                value.action = Action::Block;
            }
        }
        self.blocked = self.values.iter().any(|v| v.action == Action::Block);
    }

    /// The kinds that blocked it, for the error the user sees.
    pub fn blocked_kinds(&self) -> Vec<String> {
        let kinds: BTreeSet<&str> = self
            .values
            .iter()
            .filter(|v| v.action == Action::Block)
            .map(|v| v.kind.as_str())
            .collect();
        kinds.into_iter().map(str::to_string).collect()
    }

    /// Why it was stopped (or, warned, let through), in one clause the
    /// user reads: `names $OPENAI_API_KEY and sends it off the machine`.
    pub fn reason(&self) -> String {
        let values: Vec<&ValueRecord> = self
            .values
            .iter()
            .filter(|v| v.action == Action::Block)
            .collect();
        let values = if values.is_empty() {
            self.values.iter().collect()
        } else {
            values
        };
        if self.target != Target::Egress {
            // `API_KEY ×2 · EMAIL ×1`, most places first.
            let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
            for v in &values {
                *counts.entry(v.kind.as_str()).or_default() += v.n;
            }
            let mut counts: Vec<(&str, usize)> = counts.into_iter().collect();
            counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            let kinds: Vec<String> = counts
                .iter()
                .map(|(kind, n)| format!("{kind} ×{n}"))
                .collect();
            return format!(
                "{} {}",
                if self.blocked { "contains" } else { "masked" },
                kinds.join(" · ")
            );
        }
        let Some(first) = values.first() else {
            return "sends a secret off the machine".to_string();
        };
        let note = first.note.as_deref();
        let more = if values.len() > 1 {
            format!(" (+{} more)", values.len() - 1)
        } else {
            String::new()
        };
        let what = match (first.rule.as_deref(), note) {
            (Some("egress.hidden"), _) => {
                return "runs decoded code, which cannot be checked before it sends".to_string()
            }
            (Some("egress.env"), Some(name)) => format!("names {name}"),
            (Some("egress.environment"), _) => "reads the whole environment".to_string(),
            (Some("egress.file"), Some(file)) => format!("reads {file}"),
            _ => format!("holds a {}", first.kind),
        };
        format!("{what}{more} and sends it off the machine")
    }
}

/// Append `record` to today's file and let files past [`KEEP_DAYS`] go.
pub(super) fn append(dir: &Path, record: &Record) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let today = chrono::Local::now().date_naive();
    let path = dir.join(format!("{}.jsonl", today.format("%Y-%m-%d")));
    let mut line = serde_json::to_vec(record)?;
    line.push(b'\n');
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // One write of one line: concurrent processes append whole lines.
    options.open(&path)?.write_all(&line)?;
    for (day, path) in day_files(dir)? {
        if (today - day).num_days() > KEEP_DAYS {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

fn day_files(dir: &Path) -> Result<Vec<(chrono::NaiveDate, PathBuf)>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let stem = path.file_stem()?.to_str()?;
            let day = chrono::NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()?;
            (path.extension()? == "jsonl").then_some((day, path))
        })
        .collect())
}

/// What the records of the last `days` days add up to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub days: u32,
    /// Requests and uploads that had anything found.
    pub requests: u64,
    pub blocked: u64,
    pub by_target: BTreeMap<Target, TargetStats>,
    pub kinds: Vec<KindStats>,
    /// The last few requests, uploads and tool calls that had anything
    /// found, newest first.
    pub recent: Vec<Event>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TargetStats {
    pub requests: u64,
    pub blocked: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KindStats {
    pub kind: String,
    /// Distinct values confirmed high-confidence (a checksum held).
    #[serde(default)]
    pub verified: u64,
    /// Distinct values (by placeholder).
    pub values: u64,
    pub masked: u64,
    pub warned: u64,
    pub blocked: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub time: String,
    pub target: Target,
    #[serde(default)]
    pub session: Option<String>,
    /// The tool whose call it was (egress).
    #[serde(default)]
    pub tool: Option<String>,
    pub blocked: bool,
    /// The kinds that blocked it; every kind found, when nothing did.
    pub kinds: Vec<String>,
    /// One clause: what it did ([`Record::reason`]).
    pub reason: String,
}

pub fn summarize(dir: &Path, days: u32) -> Result<Summary> {
    let today = chrono::Local::now().date_naive();
    let mut files: Vec<_> = day_files(dir)?
        .into_iter()
        .filter(|(day, _)| (today - *day).num_days() < i64::from(days))
        .collect();
    files.sort();
    let mut summary = Summary {
        days,
        ..Summary::default()
    };
    let mut kinds: BTreeMap<String, (KindStats, BTreeSet<String>)> = BTreeMap::new();
    for (_, path) in files {
        let text = std::fs::read_to_string(&path)?;
        // A torn or newer line is skipped, never fatal.
        let records = text
            .lines()
            .filter_map(|line| serde_json::from_str::<Record>(line).ok())
            .filter(|record| record.v <= RECORD_SCHEMA_VERSION);
        for record in records {
            add(&mut summary, &mut kinds, record);
        }
    }
    summary.kinds = kinds
        .into_values()
        .map(|(mut stats, tags)| {
            stats.values = tags.len() as u64;
            stats
        })
        .collect();
    summary
        .kinds
        .sort_by(|a, b| b.values.cmp(&a.values).then(a.kind.cmp(&b.kind)));
    summary.recent.reverse();
    summary.recent.truncate(RECENT);
    Ok(summary)
}

fn add(
    summary: &mut Summary,
    kinds: &mut BTreeMap<String, (KindStats, BTreeSet<String>)>,
    record: Record,
) {
    summary.requests += 1;
    let target = summary.by_target.entry(record.target).or_default();
    target.requests += 1;
    if record.blocked {
        summary.blocked += 1;
        target.blocked += 1;
    }
    // Files come oldest first; keep only the tail, not every line.
    if summary.recent.len() >= RECENT {
        summary.recent.remove(0);
    }
    let found = if record.blocked {
        record.blocked_kinds()
    } else {
        let found: BTreeSet<&str> = record.values.iter().map(|v| v.kind.as_str()).collect();
        found.into_iter().map(str::to_string).collect()
    };
    summary.recent.push(Event {
        time: record.time.clone(),
        target: record.target,
        session: record.session.clone(),
        tool: record.tool.clone(),
        blocked: record.blocked,
        kinds: found,
        reason: record.reason(),
    });
    for value in record.values {
        let (stats, tags) = kinds.entry(value.kind.clone()).or_insert_with(|| {
            (
                KindStats {
                    kind: value.kind.clone(),
                    ..KindStats::default()
                },
                BTreeSet::new(),
            )
        });
        match value.action {
            Action::Mask => stats.masked += 1,
            Action::Warn => stats.warned += 1,
            Action::Block => stats.blocked += 1,
        }
        if value.confidence == Confidence::High && !tags.contains(&value.tag) {
            stats.verified += 1;
        }
        tags.insert(value.tag);
    }
}
