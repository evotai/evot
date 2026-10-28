//! [`Masker`]: one policy over one vault, the unit every path uses.
use std::path::PathBuf;
use std::sync::Arc;

use evot_engine::provider::StreamConfig;
use evot_engine::types::Message;
use serde_json::Value;

use super::policy::Action;
use super::policy::Mode;
use super::policy::Policy;
use super::policy::PrivacySettings;
use super::record::Record;
use super::record::Target;
use super::request;
use super::rules::builtin_packs;
use super::rules::Engine;
use super::rules::KindInfo;
use super::rules::Pack;
use super::rules::PackInfo;
use super::scan;
use super::scan::Hit;
use super::scrub;
use super::scrub::UploadContext;
use super::stream::StreamRestorer;
use super::vault::Vault;
use crate::error::Result;

/// The engine for the built-in packs plus `extra`; the built-in one alone
/// is compiled once per process.
pub(super) fn engine(extra: &[Pack]) -> Result<Arc<Engine>> {
    static BUILTIN: std::sync::OnceLock<std::result::Result<Arc<Engine>, String>> =
        std::sync::OnceLock::new();
    if extra.is_empty() {
        let built = BUILTIN.get_or_init(|| {
            builtin_packs()
                .and_then(Engine::compile)
                .map(Arc::new)
                .map_err(|e| e.to_string())
        });
        return built.clone().map_err(crate::error::EvotError::Conf);
    }
    let mut packs = builtin_packs()?.to_vec();
    packs.extend(extra.iter().cloned());
    Ok(Arc::new(Engine::compile(&packs)?))
}

pub struct Masker {
    policy: Policy,
    vault: Arc<Vault>,
    /// Where records go; `None` keeps none.
    records: Option<PathBuf>,
}

/// What one request or upload had found in it. Holds no values.
#[derive(Debug, Default)]
pub struct Report {
    hits: Vec<Hit>,
}

impl Report {
    fn of(hits: Vec<Hit>) -> Self {
        Self { hits }
    }

    pub fn is_empty(&self) -> bool {
        self.hits.is_empty()
    }

    pub fn blocked(&self) -> bool {
        self.hits.iter().any(|hit| hit.action == Action::Block)
    }

    /// Distinct kinds found, in order.
    pub fn kinds(&self) -> Vec<String> {
        let mut kinds: Vec<String> = self.hits.iter().map(|hit| hit.kind.clone()).collect();
        kinds.sort();
        kinds.dedup();
        kinds
    }

    pub fn record(&self, target: Target) -> Record {
        Record::new(target, &self.hits)
    }
}

impl Masker {
    /// A masker over the built-in packs with a vault of its own, keeping
    /// no records.
    pub fn new(settings: &PrivacySettings, key: [u8; 32]) -> Result<Self> {
        Self::with_packs(settings, key, &[])
    }

    /// As [`Masker::new`], with `extra` packs merged after the built-in ones.
    pub fn with_packs(settings: &PrivacySettings, key: [u8; 32], extra: &[Pack]) -> Result<Self> {
        Self::with_vault(settings, engine(extra)?, Arc::new(Vault::new(key)), None)
    }

    pub(super) fn with_vault(
        settings: &PrivacySettings,
        engine: Arc<Engine>,
        vault: Arc<Vault>,
        records: Option<PathBuf>,
    ) -> Result<Self> {
        Ok(Self {
            policy: Policy::compile(settings, engine)?,
            vault,
            records,
        })
    }

    /// The kinds the packs define, for `/privacy`.
    pub fn kinds(&self) -> Vec<KindInfo> {
        self.policy.engine.kinds()
    }

    pub fn packs(&self) -> Vec<PackInfo> {
        self.policy.engine.packs().to_vec()
    }

    /// Every pack example that does not do what it says.
    pub fn self_test(&self) -> Vec<String> {
        self.policy.engine.self_test()
    }

    /// Keep records of what is found under `dir`.
    pub fn with_records(mut self, dir: PathBuf) -> Self {
        self.records = Some(dir);
        self
    }

    pub fn enabled(&self) -> bool {
        self.policy.enabled
    }

    pub(super) fn records(&self) -> Option<&PathBuf> {
        self.records.as_ref()
    }

    /// Swap secrets and personal data in an LLM request for placeholders.
    pub fn mask_request(&self, config: &mut StreamConfig) -> Result<Report> {
        if !self.policy.enabled {
            return Ok(Report::default());
        }
        let hits = request::mask_config(&self.policy, &self.vault, config)?;
        Ok(Report::of(hits))
    }

    /// What the packs find in one text (held in JSON field `field`), as
    /// masking a request would, without changing anything.
    pub fn inspect(&self, text: &str, field: Option<&str>) -> Report {
        let spans = scan::find(&self.policy, text, false, field);
        let put = |kind: &str, value: &str| self.vault.tag(kind, value);
        let mut hits = Vec::new();
        scan::apply(
            Mode::Llm,
            text,
            spans,
            &self.policy,
            &self.vault,
            &put,
            &mut hits,
        );
        Report::of(hits)
    }

    /// Put the values back in a reply, tool-call arguments included.
    pub fn restore_message(&self, message: &mut Message) {
        request::restore_message(&self.vault, message);
    }

    /// Put the values back in text; `escaped` for raw JSON.
    pub fn restore_text(&self, text: &str, escaped: bool) -> String {
        self.vault
            .restore(text, escaped)
            .unwrap_or_else(|| text.to_string())
    }

    pub fn restorer(&self) -> StreamRestorer<'_> {
        StreamRestorer::new(&self.vault)
    }

    /// Scrub an upload for good: `[REDACTED:KIND]`, nothing kept to undo
    /// it. Always on: `/privacy off` turns off LLM masking, never this.
    pub fn scrub(&self, value: &mut Value) -> Result<Report> {
        self.scrub_with(value, None)
    }

    /// As [`Masker::scrub`], against the context of the whole session.
    pub fn scrub_with(&self, value: &mut Value, context: Option<&UploadContext>) -> Result<Report> {
        let hits = scrub::scrub_value(&self.policy, &self.vault, value, context);
        Ok(Report::of(hits))
    }

    /// Read a session's local history as context for uploading part of it.
    pub fn upload_context(&self, history: &Value) -> UploadContext {
        scrub::context(&self.policy, &self.vault, history)
    }

    /// Mask `value` as a secret wherever it appears from now on.
    pub fn remember_secret(&self, value: &str) {
        self.vault.remember("SECRET", value);
    }
}
