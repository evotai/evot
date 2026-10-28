//! The user's privacy settings (persisted) and the policy compiled from them.
use std::collections::BTreeMap;
use std::sync::Arc;

use regex::Regex;
use serde::Deserialize;
use serde::Serialize;

use super::rules::Category;
use super::rules::Confidence;
use super::rules::Engine;
use crate::error::EvotError;
use crate::error::Result;

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// What is done with a value of a kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Swapped for a placeholder (LLM) or `[REDACTED:KIND]` (uploads).
    #[default]
    Mask,
    /// Sent as written, and recorded.
    Warn,
    /// Nothing is sent; the request or upload fails.
    Block,
}

/// `~/.evotai/privacy/settings.json`. A missing file is the defaults: on,
/// secrets and personal data masked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrivacySettings {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// API keys, private keys, tokens, passwords.
    #[serde(default = "yes")]
    pub secrets: bool,
    /// Emails, phones, ID and card numbers, names and addresses by field.
    #[serde(default = "yes")]
    pub personal: bool,
    /// Public IPs and MAC addresses. Off by default: logs are full of them.
    #[serde(default)]
    pub network: bool,
    /// Per kind (`API_KEY`, `EMAIL`, `TERM`, …). A kind not listed is
    /// masked, or warned of when its finding is low-confidence.
    #[serde(default)]
    pub actions: BTreeMap<String, Action>,
    /// The user's own words: names, codenames, internal hosts.
    #[serde(default)]
    pub terms: Vec<String>,
    #[serde(default = "yes")]
    pub terms_any_case: bool,
    /// Whole values always sent as written, in any case.
    #[serde(default)]
    pub allow: Vec<String>,
}

fn yes() -> bool {
    true
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            enabled: true,
            secrets: true,
            personal: true,
            network: false,
            actions: BTreeMap::new(),
            terms: Vec::new(),
            terms_any_case: true,
            allow: Vec::new(),
        }
    }
}

impl PrivacySettings {
    /// Parse a settings document. A missing version is legacy v0 (same
    /// shape); a newer one is refused rather than half-understood.
    pub fn parse(text: &str) -> Result<Self> {
        let mut settings: Self = serde_json::from_str(text)
            .map_err(|e| EvotError::Conf(format!("privacy settings are invalid: {e}")))?;
        if settings.schema_version > SETTINGS_SCHEMA_VERSION {
            return Err(EvotError::Conf(format!(
                "privacy settings schema {} is newer than this evot supports ({}); update evot",
                settings.schema_version, SETTINGS_SCHEMA_VERSION
            )));
        }
        settings.schema_version = SETTINGS_SCHEMA_VERSION;
        Ok(settings)
    }
}

/// Where found values are going: masked for an LLM, scrubbed for good on
/// an upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Llm,
    Upload,
}

/// Settings compiled for scanning, over the merged rule packs.
pub(super) struct Policy {
    pub enabled: bool,
    pub engine: Arc<Engine>,
    secrets: bool,
    personal: bool,
    network: bool,
    actions: BTreeMap<String, Action>,
    allow: Vec<String>,
    terms: Option<Regex>,
}

impl Policy {
    pub fn compile(settings: &PrivacySettings, engine: Arc<Engine>) -> Result<Self> {
        let words: Vec<String> = settings
            .terms
            .iter()
            .map(|t| t.trim())
            .filter(|t| t.chars().count() >= 2)
            .map(regex::escape)
            .collect();
        let terms = if words.is_empty() {
            None
        } else {
            let case = if settings.terms_any_case { "(?i)" } else { "" };
            let pattern = format!("{case}(?:{})", words.join("|"));
            Some(
                Regex::new(&pattern)
                    .map_err(|e| EvotError::Conf(format!("privacy terms are invalid: {e}")))?,
            )
        };
        Ok(Self {
            enabled: settings.enabled,
            engine,
            secrets: settings.secrets,
            personal: settings.personal,
            network: settings.network,
            actions: settings
                .actions
                .iter()
                .map(|(kind, action)| (kind.to_ascii_uppercase(), *action))
                .collect(),
            allow: settings
                .allow
                .iter()
                .map(|v| v.trim().to_lowercase())
                .filter(|v| !v.is_empty())
                .collect(),
            terms,
        })
    }

    pub fn covers(&self, category: Category) -> bool {
        match category {
            Category::Secret => self.secrets,
            Category::Personal => self.personal,
            Category::Network => self.network,
            Category::Custom => true,
        }
    }

    pub fn terms(&self) -> Option<&Regex> {
        self.terms.as_ref()
    }

    /// The user's action for `kind`; without one, a low-confidence finding
    /// is warned of and any other masked.
    pub fn action(&self, kind: &str, confidence: Confidence) -> Action {
        match self.actions.get(kind) {
            Some(action) => *action,
            None if confidence == Confidence::Low => Action::Warn,
            None => Action::Mask,
        }
    }

    /// For what goes onto a server: only the user's own `warn` sends a value
    /// as written; a low-confidence finding is scrubbed all the same.
    pub fn upload_action(&self, kind: &str) -> Action {
        self.actions.get(kind).copied().unwrap_or_default()
    }

    /// The action for `kind` on `to`.
    pub fn action_for(&self, to: Mode, kind: &str, confidence: Confidence) -> Action {
        match to {
            Mode::Llm => self.action(kind, confidence),
            Mode::Upload => self.upload_action(kind),
        }
    }

    pub fn is_secret(&self, kind: &str) -> bool {
        self.engine.category(kind) == Category::Secret
    }

    pub fn allows(&self, value: &str) -> bool {
        !self.allow.is_empty() && self.allow.contains(&value.trim().to_lowercase())
    }
}
