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
    #[serde(default)]
    pub blocked: bool,
    #[serde(default)]
    pub values: Vec<ValueRecord>,
    /// Where the request had them, most places first. Empty for uploads and
    /// records from before this field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub origins: Vec<OriginRecord>,
}

/// One place in a request that held values: `Bash result` with the
/// command's label, `user`, `system prompt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginRecord {
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Places (occurrences), not distinct values.
    pub n: usize,
}

/// Distinct values one rule found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleCount {
    pub rule: String,
    pub values: usize,
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
    /// One record for a request's hits, each value once with its count,
    /// and each place once with how many values it held.
    pub(super) fn new(target: Target, hits: &[Hit]) -> Self {
        let mut values: Vec<ValueRecord> = Vec::new();
        let mut origins: Vec<OriginRecord> = Vec::new();
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
            if let Some(origin) = &hit.origin {
                match origins
                    .iter_mut()
                    .find(|o| o.at == origin.at && o.label == origin.label)
                {
                    Some(place) => place.n += 1,
                    None => origins.push(OriginRecord {
                        at: origin.at.clone(),
                        label: origin.label.clone(),
                        n: 1,
                    }),
                }
            }
        }
        origins.sort_by(|a, b| b.n.cmp(&a.n).then(a.at.cmp(&b.at)));
        Self {
            v: RECORD_SCHEMA_VERSION,
            time: chrono::Local::now().to_rfc3339(),
            target,
            session: None,
            provider: None,
            model: None,
            blocked: values.iter().any(|v| v.action == Action::Block),
            values,
            origins,
        }
    }

    /// Distinct values per rule, most first. Values a known-value finder
    /// re-masked count under `known`; a rule-less finder under its name.
    pub fn rules(&self) -> Vec<RuleCount> {
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
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for v in values {
            let rule = match (&v.rule, v.by) {
                (Some(rule), _) => rule.clone(),
                (None, Finder::Known) => "known".to_string(),
                (None, by) => format!("{by:?}").to_lowercase(),
            };
            *counts.entry(rule).or_default() += 1;
        }
        let mut counts: Vec<RuleCount> = counts
            .into_iter()
            .map(|(rule, values)| RuleCount { rule, values })
            .collect();
        counts.sort_by(|a, b| b.values.cmp(&a.values).then(a.rule.cmp(&b.rule)));
        counts
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

    /// What was found, in one clause the user reads: `masked API_KEY ×2 ·
    /// EMAIL ×1`, or `contains …` when it was stopped.
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
        format!(
            "{} {}",
            if self.blocked { "contains" } else { "masked" },
            kinds.join(" · ")
        )
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
    /// The last few requests and uploads that had anything
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
    pub blocked: bool,
    /// The kinds that blocked it; every kind found, when nothing did.
    pub kinds: Vec<String>,
    /// One clause: what it did ([`Record::reason`]).
    pub reason: String,
    /// Where it was going (a model request).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Which rules found the values, most first ([`Record::rules`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RuleCount>,
    /// Where the request had them, most places first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub origins: Vec<OriginRecord>,
}

impl Event {
    pub fn of(record: &Record) -> Self {
        let kinds = if record.blocked {
            record.blocked_kinds()
        } else {
            let found: BTreeSet<&str> = record.values.iter().map(|v| v.kind.as_str()).collect();
            found.into_iter().map(str::to_string).collect()
        };
        Self {
            time: record.time.clone(),
            target: record.target,
            session: record.session.clone(),
            blocked: record.blocked,
            kinds,
            reason: record.reason(),
            provider: record.provider.clone(),
            model: record.model.clone(),
            rules: record.rules(),
            origins: record.origins.clone(),
        }
    }
}

/// One record as the running process saw it, for a client that shows what
/// just happened without reading the day files back. `tags` are the
/// placeholders (never values): the same value keeps the same tag, so a
/// client can tell a value first seen now from one masked every request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveNotice {
    pub seq: u64,
    #[serde(flatten)]
    pub event: Event,
    pub tags: Vec<String>,
}

impl LiveNotice {
    pub(super) fn of(seq: u64, record: &Record) -> Self {
        let tags: BTreeSet<&str> = record.values.iter().map(|v| v.tag.as_str()).collect();
        Self {
            seq,
            event: Event::of(record),
            tags: tags.into_iter().map(str::to_string).collect(),
        }
    }
}

/// Every placeholder tag the records of the last `days` days hold for
/// `session`: what that session has already had masked. Tags only, so a
/// resumed session's first request does not report its history as new.
pub fn session_tags(dir: &Path, session: &str, days: u32) -> Result<Vec<String>> {
    let today = chrono::Local::now().date_naive();
    let mut tags = BTreeSet::new();
    for (day, path) in day_files(dir)? {
        if (today - day).num_days() >= i64::from(days) {
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        for record in text
            .lines()
            .filter_map(|line| serde_json::from_str::<Record>(line).ok())
            .filter(|record| record.session.as_deref() == Some(session))
        {
            tags.extend(record.values.into_iter().map(|v| v.tag));
        }
    }
    Ok(tags.into_iter().collect())
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
    summary.recent.push(Event::of(&record));
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
