//! Model-level thinking / reasoning-effort helpers.
//!
//! Model metadata determines whether reasoning exists and which levels are
//! selectable. Transport metadata independently determines the wire format and
//! whether that endpoint can carry an effort value.

use super::ModelConfig;
use super::ThinkingLevelPolicy;
use crate::provider::route::ApiProtocol;
use crate::provider::route::CompatCaps;
use crate::provider::route::ThinkingFormat;
use crate::ThinkingLevel;

/// Default token budgets for Anthropic budget-based thinking.
pub const DEFAULT_BUDGET_MINIMAL: u32 = 1024;
pub const DEFAULT_BUDGET_LOW: u32 = 2048;
pub const DEFAULT_BUDGET_MEDIUM: u32 = 8192;
pub const DEFAULT_BUDGET_HIGH: u32 = 16_384;
/// Anthropic's minimum budget-based thinking allocation.
pub const MIN_THINKING_BUDGET: u32 = 1024;
/// Leave at least this many tokens for the visible answer.
pub const MIN_OUTPUT_AFTER_THINKING: u32 = 1024;

/// Ordered ladder used for selection UI and nearest-level clamping. Mirrors
/// pi's `EXTENDED_THINKING_LEVELS`.
const LEVEL_LADDER: [ThinkingLevel; 7] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];

impl ModelConfig {
    /// Explicit profile compaction threshold. `None` means the profile sets no
    /// limit and the context layer compacts at `window - reserve` (pi-style).
    pub fn profile_compaction_limit(&self, _requested: ThinkingLevel) -> Option<u32> {
        self.capabilities
            .compaction_limit
            .map(|limit| limit.min(self.context_window()))
    }

    /// Whether the configured protocol and transport can carry a selectable
    /// reasoning effort for this model.
    pub fn honors_reasoning_effort(&self) -> bool {
        match self.protocol() {
            ApiProtocol::AnthropicMessages | ApiProtocol::OpenAiResponses => true,
            ApiProtocol::OpenAiCompletions => self.compat().is_some_and(|compat| {
                let format_carries_effort = match compat.thinking_format {
                    ThinkingFormat::OpenRouter => true,
                    ThinkingFormat::DeepSeek => {
                        self.reasoning_has_wire_value("low")
                            || self.reasoning_has_wire_value("high")
                            || self.reasoning_has_wire_value("max")
                    }
                    _ => false,
                };
                format_carries_effort || compat.caps.contains(CompatCaps::REASONING_EFFORT)
            }),
        }
    }

    pub fn supported_thinking_levels(&self) -> Vec<ThinkingLevel> {
        if !self.reasoning() {
            return vec![ThinkingLevel::Off];
        }
        if self.protocol() == ApiProtocol::OpenAiCompletions && !self.honors_reasoning_effort() {
            return Vec::new();
        }
        LEVEL_LADDER
            .into_iter()
            .filter(|level| {
                !matches!(
                    self.thinking_level_policy(*level),
                    ThinkingLevelPolicy::Unsupported
                )
            })
            .collect()
    }

    pub fn can_disable_thinking(&self) -> bool {
        self.reasoning()
            && !matches!(
                self.thinking_level_policy(ThinkingLevel::Off),
                ThinkingLevelPolicy::Unsupported
            )
    }

    /// Clamp a requested level to the nearest supported tier for this model.
    /// Searches upward from the request first, then downward, matching pi's
    /// `clampThinkingLevel`.
    pub fn clamp_thinking_level(&self, level: ThinkingLevel) -> ThinkingLevel {
        let available = self.supported_thinking_levels();
        if available.is_empty() {
            return ThinkingLevel::Off;
        }
        if available.contains(&level) {
            return level;
        }
        let Some(idx) = LEVEL_LADDER
            .iter()
            .position(|candidate| *candidate == level)
        else {
            return available[0];
        };
        for candidate in LEVEL_LADDER.iter().skip(idx) {
            if available.contains(candidate) {
                return *candidate;
            }
        }
        for candidate in LEVEL_LADDER.iter().take(idx).rev() {
            if available.contains(candidate) {
                return *candidate;
            }
        }
        available[0]
    }

    /// Resolve the level used for a request.
    pub fn effective_thinking_level(&self, requested: ThinkingLevel) -> ThinkingLevel {
        if !self.reasoning() || self.supported_thinking_levels().is_empty() {
            return ThinkingLevel::Off;
        }
        self.clamp_thinking_level(requested)
    }
}

/// Resolve a request level when model metadata may be absent.
pub fn effective_thinking_level(
    requested: ThinkingLevel,
    model: Option<&ModelConfig>,
) -> ThinkingLevel {
    model
        .map(|model| model.effective_thinking_level(requested))
        .unwrap_or(requested)
}

/// Map a thinking level to an Anthropic effort value. The model map wins;
/// absent model metadata falls back to Anthropic's canonical effort names.
pub fn anthropic_effort(level: ThinkingLevel, model: Option<&ModelConfig>) -> Option<String> {
    if let Some(model) = model {
        match model.thinking_level_policy(level) {
            ThinkingLevelPolicy::WireValue(value) => return Some(value.to_string()),
            ThinkingLevelPolicy::Unsupported => return None,
            ThinkingLevelPolicy::ProtocolDefault => {}
        }
    }
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Minimal | ThinkingLevel::Low => Some("low".into()),
        ThinkingLevel::Medium => Some("medium".into()),
        ThinkingLevel::High => Some("high".into()),
        ThinkingLevel::Xhigh => Some("xhigh".into()),
        ThinkingLevel::Max => Some("max".into()),
    }
}

/// Token budget for Anthropic budget-based thinking.
pub fn anthropic_thinking_budget(level: ThinkingLevel) -> u32 {
    match level {
        ThinkingLevel::Off => 0,
        ThinkingLevel::Minimal => DEFAULT_BUDGET_MINIMAL,
        ThinkingLevel::Low => DEFAULT_BUDGET_LOW,
        ThinkingLevel::Medium => DEFAULT_BUDGET_MEDIUM,
        ThinkingLevel::High | ThinkingLevel::Xhigh | ThinkingLevel::Max => DEFAULT_BUDGET_HIGH,
    }
}

/// Adjust max_tokens so budget-based thinking fits inside the model output cap.
pub fn adjust_max_tokens_for_thinking(
    explicit_max_tokens: Option<u32>,
    model_max_tokens: u32,
    level: ThinkingLevel,
) -> (u32, u32) {
    let mut thinking_budget = anthropic_thinking_budget(level);
    let max_tokens = match explicit_max_tokens {
        Some(base) => base.saturating_add(thinking_budget).min(model_max_tokens),
        None => model_max_tokens,
    }
    .max(1);
    let room_for_answer = max_tokens.saturating_sub(MIN_OUTPUT_AFTER_THINKING);
    thinking_budget = thinking_budget.min(room_for_answer);
    (max_tokens, thinking_budget)
}

/// Whether `Off` should emit `{"type":"disabled"}` rather than omit the field.
pub fn thinking_off_disables(model: Option<&ModelConfig>) -> bool {
    model.map(ModelConfig::can_disable_thinking).unwrap_or(true)
}

/// Wire encoding for effort-based thinking on Anthropic transports.
/// `None` (including absent model metadata) means budget-based thinking.
pub(crate) fn anthropic_thinking_wire(
    model: Option<&ModelConfig>,
) -> Option<super::AnthropicThinkingWire> {
    model.and_then(ModelConfig::anthropic_thinking_wire)
}
