//! The rulepack format: every rule, word list, exclusion, source and
//! structural field privacy uses is data in this shape. Built-in packs are
//! the JSON files beside this module; users add packs under
//! `~/.evotai/privacy/rules/*.json`. All packs merge into one engine.
use std::collections::BTreeMap;

use serde::Deserialize;
use serde::Serialize;

pub const PACK_SCHEMA_VERSION: u32 = 1;

/// What a kind belongs to; a category is switched on or off as a whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// Keys, tokens, passwords: masked by default.
    Secret,
    /// Data about a person: masked by default.
    Personal,
    /// Addresses of machines (public IPs, MACs): off by default.
    Network,
    /// The user's own terms: always on when listed.
    Custom,
}

/// How sure a finding is. A low one is warned of, not masked, unless the
/// user set an action for its kind.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    #[default]
    Medium,
    High,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pack {
    #[serde(default)]
    pub schema_version: u32,
    pub id: String,
    /// Where the rules come from, for attribution. Absent for evot's own.
    #[serde(default)]
    pub source: Option<PackSource>,
    /// `${NAME}` in any regex. A value of `@list` is that list as an
    /// escaped alternation.
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    /// Word lists; `@name` in any list field splices one in.
    #[serde(default)]
    pub lists: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub kinds: Vec<KindDef>,
    /// Conditions rules refer to by name.
    #[serde(default)]
    pub checks: BTreeMap<String, Check>,
    #[serde(default)]
    pub rules: Vec<RuleDef>,
    /// Values found by the name of the field holding them.
    #[serde(default)]
    pub fields: Vec<FieldDef>,
    /// Tool calls whose output is a secrets file.
    #[serde(default)]
    pub sources: Option<SourcesDef>,
    /// Upload JSON that is structure, not user text.
    #[serde(default)]
    pub structure: Option<StructureDef>,
    /// Tools whose arguments leave the machine.
    #[serde(default)]
    pub egress: Option<EgressDef>,
    #[serde(default)]
    pub decode: Option<DecodeDef>,
    #[serde(default)]
    pub known: Option<KnownDef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackSource {
    pub name: String,
    pub url: String,
    /// SPDX id; only permissive licenses are accepted.
    pub license: String,
    pub copyright: String,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KindDef {
    pub name: String,
    pub category: Category,
}

/// A condition on a found value. Every part given must hold.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    /// Regex the value matches.
    #[serde(default)]
    pub value: Option<String>,
    /// Regex the text just before the value matches (anchor with `$`).
    #[serde(default)]
    pub before: Option<String>,
    /// Regex the text just after the value matches (anchor with `^`).
    #[serde(default)]
    pub after: Option<String>,
    /// Bytes of text `before` and `after` see.
    #[serde(default)]
    pub window: Option<usize>,
    /// The value is made only of these words (case-insensitive).
    #[serde(default)]
    pub words: Vec<String>,
    /// The value contains one of these (case-insensitive).
    #[serde(default)]
    pub contains: Vec<String>,
    /// The value's Shannon entropy is below this.
    #[serde(default)]
    pub entropy_below: Option<f64>,
}

/// A check by name (from any pack's `checks`) or written in place.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CheckRef {
    Named(String),
    Inline(Check),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    #[default]
    Any,
    /// Only in the output of a sensitive source (`.env`, `env`).
    Sensitive,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleDef {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub confidence: Confidence,
    pub regex: String,
    /// Lower-case text one of which must appear before the regex runs.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Capture group of the value; 0 takes the first group that matched,
    /// or the whole match.
    #[serde(default)]
    pub group: usize,
    /// A character class no character next to the value may be in.
    #[serde(default)]
    pub bound: Option<String>,
    #[serde(default)]
    pub scope: Scope,
    /// Every one must hold.
    #[serde(default)]
    pub when: Vec<CheckRef>,
    /// Any one holding drops the value.
    #[serde(default)]
    pub unless: Vec<CheckRef>,
    #[serde(default)]
    pub context: Option<ContextDef>,
    #[serde(default)]
    pub checksum: Option<ChecksumDef>,
    /// Regression examples, run by the tests for every pack.
    #[serde(default)]
    pub examples: Examples,
}

/// Words near a value that say what it is.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextDef {
    pub words: Vec<String>,
    /// Bytes searched on each side.
    #[serde(default = "default_window")]
    pub window: usize,
    /// Without one of the words the value is dropped.
    #[serde(default)]
    pub required: bool,
    /// Confidence with one of the words; default one level up.
    #[serde(default)]
    pub confidence: Option<Confidence>,
}

fn default_window() -> usize {
    32
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChecksumDef {
    /// `luhn`, `cn_id`, `iban`, `crc32_base62`, `bech32`, `hkid`, `twid`.
    pub algorithm: String,
    /// A value failing the checksum is kept (at its confidence) rather
    /// than dropped.
    #[serde(default)]
    pub keep_on_fail: bool,
    /// Confidence of a value that passes; default unchanged.
    #[serde(default)]
    pub confirmed: Option<Confidence>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Examples {
    /// Each has a value this rule finds.
    #[serde(default)]
    pub matches: Vec<String>,
    /// None has one.
    #[serde(default)]
    pub ignores: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDef {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub confidence: Confidence,
    /// Regex the field name (lower-cased) matches.
    pub key: String,
    #[serde(default)]
    pub key_unless: Option<String>,
    /// Also in `name: value` text, not only in JSON fields.
    #[serde(default)]
    pub text: bool,
    #[serde(default)]
    pub when: Vec<CheckRef>,
    #[serde(default)]
    pub unless: Vec<CheckRef>,
    #[serde(default)]
    pub examples: Examples,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcesDef {
    #[serde(default)]
    pub tools: Vec<ToolSource>,
    /// File names (lower-case) that hold secrets.
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub prefixes: Vec<String>,
    #[serde(default)]
    pub suffixes: Vec<String>,
    /// Commands whose output is the environment.
    #[serde(default)]
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSource {
    pub name: String,
    /// Arguments naming a file it reads.
    #[serde(default)]
    pub path_args: Vec<String>,
    /// The argument holding a shell command.
    #[serde(default)]
    pub command_arg: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructureDef {
    /// Fields never scanned.
    #[serde(default)]
    pub skip_keys: Vec<String>,
    #[serde(default)]
    pub skip_suffixes: Vec<String>,
    /// Fields holding binary data, skipped when the object is binary.
    #[serde(default)]
    pub binary_keys: Vec<String>,
    /// An object with one of these fields is binary.
    #[serde(default)]
    pub binary_markers: Vec<String>,
    /// An object whose `type` is one of these is binary.
    #[serde(default)]
    pub binary_types: Vec<String>,
    /// Fields naming the tool call an object is the result of.
    #[serde(default)]
    pub result_id_keys: Vec<String>,
    /// Fields holding a tool call's arguments.
    #[serde(default)]
    pub call_args_keys: Vec<String>,
}

/// What a tool call can send off the machine, read before it runs. Every
/// tool is checked; one not named `local` may send its arguments anywhere.
/// A shell command (a `sources` tool with a `command_arg`) sends when a
/// `senders` pattern matches it. Every pattern is a regex; `${VAR}` and
/// `@{list}` expand as in rules.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EgressDef {
    /// Tools that never send their arguments off the machine.
    #[serde(default)]
    pub local: Vec<String>,
    /// Tools that write a file: what they write taints it.
    #[serde(default)]
    pub writers: Vec<WriterDef>,
    /// A shell command that sends: a network program, or code it runs.
    #[serde(default)]
    pub senders: Vec<String>,
    /// Decoding into execution: what it runs cannot be read, so it is
    /// refused whatever it carries.
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Flags or settings that send through a host the text does not name.
    #[serde(default)]
    pub reroute: Vec<String>,
    /// Files a shell command writes; group `path`.
    #[serde(default)]
    pub writes: Vec<String>,
    /// Paths a write never taints (prefixes, after `~` and `cwd`).
    #[serde(default)]
    pub untainted: Vec<String>,
    /// References to an environment variable; group `name`.
    #[serde(default)]
    pub env_refs: Vec<String>,
    /// The whole environment printed or read at once (`env`, `os.environ`).
    #[serde(default)]
    pub env_dumps: Vec<String>,
    /// A variable name holding a secret, and names that do not.
    #[serde(default)]
    pub secret_env: Vec<String>,
    #[serde(default)]
    pub secret_env_unless: Vec<String>,
    /// Where a call sends to; group `host`.
    #[serde(default)]
    pub destinations: Vec<String>,
    /// Hosts on this machine (`*.suffix` allowed): always fine.
    #[serde(default)]
    pub local_hosts: Vec<String>,
    /// Regression examples, run by the tests for every pack.
    #[serde(default)]
    pub examples: EgressExamples,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriterDef {
    pub name: String,
    /// Arguments naming the file; every other string is its content.
    pub path_args: Vec<String>,
}

/// Shell commands and what the egress patterns must make of them.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EgressExamples {
    #[serde(default)]
    pub sends: Vec<String>,
    #[serde(default)]
    pub quiet: Vec<String>,
    #[serde(default)]
    pub hidden: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecodeDef {
    #[serde(default)]
    pub base64: bool,
    #[serde(default)]
    pub percent: bool,
    pub min_len: usize,
    pub max_len: usize,
    /// Levels of encoding looked through.
    pub depth: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnownDef {
    /// Shortest variable or key registered as a secret.
    pub min_secret_len: usize,
}
