use std::collections::HashMap;

use serde::Deserialize;
use serde::Serialize;

use crate::ThinkingLevel;

/// A modality accepted by a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputModality {
    Text,
    Image,
}

/// Native model control for final-answer length and detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Verbosity {
    Low,
    #[default]
    Medium,
    High,
}

/// Wire encoding for effort-based thinking on the Anthropic protocol.
///
/// Anthropic-compatible endpoints do not all speak the same dialect: Claude
/// accepts the proprietary `{"type":"adaptive"}` extension, while
/// compatible third-party endpoints (e.g. Kimi, GLM-5.3) only accept
/// `{"type":"enabled"}` and silently ignore unknown types — which would
/// disable thinking entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnthropicThinkingWire {
    /// Claude: `{"type":"adaptive","display":"summarized"}` + `output_config.effort`.
    Adaptive,
    /// Third-party Anthropic-compatible endpoints (Kimi, GLM-5.3):
    /// `{"type":"enabled","budget_tokens":N}` + `output_config.effort`.
    /// Both fields are sent together — omitting `budget_tokens` can cause
    /// some endpoints to reject the request or silently disable thinking.
    Enabled,
}

/// Effective policy for one thinking level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThinkingLevelPolicy<'a> {
    ProtocolDefault,
    Unsupported,
    WireValue(&'a str),
}

/// Model-level reasoning support. Presence in `levels` means supported;
/// `None` means the protocol's canonical encoding, while `Some` is an explicit
/// wire value. Unsupported levels are absent rather than represented by a
/// second sentinel state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReasoningCapabilities {
    levels: HashMap<ThinkingLevel, Option<String>>,
    default_level: ThinkingLevel,
    /// Effort-based thinking wire encoding; `None` means budget-based.
    effort_wire: Option<AnthropicThinkingWire>,
}

impl ReasoningCapabilities {
    pub(super) fn new(
        levels: HashMap<ThinkingLevel, Option<String>>,
        default_level: ThinkingLevel,
        effort_wire: Option<AnthropicThinkingWire>,
    ) -> Self {
        debug_assert!(levels.is_empty() || levels.contains_key(&default_level));
        Self {
            levels,
            default_level,
            effort_wire,
        }
    }

    pub(super) fn supported(&self) -> bool {
        self.levels
            .iter()
            .any(|(level, _)| *level != ThinkingLevel::Off)
    }

    pub(super) fn default_level(&self) -> ThinkingLevel {
        self.default_level
    }

    pub(super) fn policy(&self, level: ThinkingLevel) -> ThinkingLevelPolicy<'_> {
        match self.levels.get(&level) {
            Some(Some(value)) => ThinkingLevelPolicy::WireValue(value),
            Some(None) => ThinkingLevelPolicy::ProtocolDefault,
            None => ThinkingLevelPolicy::Unsupported,
        }
    }

    pub(super) fn has_wire_value(&self, value: &str) -> bool {
        self.levels
            .values()
            .any(|mapped| mapped.as_deref() == Some(value))
    }

    pub(super) fn set_supported(&mut self, supported: bool) {
        if !supported {
            self.levels.clear();
            self.levels.insert(ThinkingLevel::Off, None);
            self.default_level = ThinkingLevel::Off;
        }
    }

    pub(super) fn effort_wire(&self) -> Option<AnthropicThinkingWire> {
        self.effort_wire
    }
}

/// Intrinsic capabilities resolved from the model catalog.
#[derive(Debug, Clone)]
pub(super) struct ModelCapabilities {
    /// Maximum request input accepted by the model — the real budget used for
    /// compaction/overflow math.
    pub(super) max_input_tokens: u32,
    /// Documented total context window (input + output) for display. May
    /// exceed `max_input_tokens` when the provider carves output headroom out
    /// of the advertised window (e.g. DeepSeek V4: 1M total, 616K input).
    pub(super) advertised_context_window: u32,
    pub(super) max_output_tokens: u32,
    pub(super) input: Vec<InputModality>,
    pub(super) reasoning: ReasoningCapabilities,
    pub(super) default_verbosity: Option<Verbosity>,
    /// Explicit profile compaction threshold. `None` means no profile limit;
    /// context management compacts at `window - reserve` (pi-style).
    pub(super) compaction_limit: Option<u32>,
}

impl ModelCapabilities {
    pub(super) fn supports_image(&self) -> bool {
        self.input.contains(&InputModality::Image)
    }
}
