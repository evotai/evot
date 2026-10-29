use std::collections::HashMap;

use super::super::capabilities::AnthropicThinkingWire;
use super::super::capabilities::InputModality;
use super::super::capabilities::ModelCapabilities;
use super::super::capabilities::ReasoningCapabilities;
use super::super::capabilities::Verbosity;
use crate::ThinkingLevel;

pub(super) type ReasoningLevels = &'static [(ThinkingLevel, Option<&'static str>)];

/// Intrinsic reasoning contract for a model. The list is exhaustive: a level
/// not present here is unsupported. This mirrors Droid's
/// `supportedReasoningEfforts` + `defaultReasoningEffort` model.
#[derive(Debug, Clone, Copy)]
pub(super) struct ReasoningProfile {
    pub levels: ReasoningLevels,
    pub default: ThinkingLevel,
    /// Anthropic effort-based wire dialect. `None` selects budget thinking.
    pub anthropic_wire: Option<AnthropicThinkingWire>,
}

pub(super) const STANDARD_REASONING: ReasoningProfile = ReasoningProfile {
    levels: &[
        (ThinkingLevel::Off, None),
        (ThinkingLevel::Minimal, None),
        (ThinkingLevel::Low, None),
        (ThinkingLevel::Medium, None),
        (ThinkingLevel::High, None),
    ],
    default: ThinkingLevel::Medium,
    anthropic_wire: None,
};

/// Optimistic baseline for opaque cloud aliases and uncatalogued models.
/// Keep the wire generic: capacity and selectable reasoning do not imply
/// support for adaptive thinking, remote compaction, or verbosity extensions.
const FALLBACK_REASONING: ReasoningProfile = ReasoningProfile {
    levels: &[
        (ThinkingLevel::Off, None),
        (ThinkingLevel::Minimal, None),
        (ThinkingLevel::Low, None),
        (ThinkingLevel::Medium, None),
        (ThinkingLevel::High, None),
        (ThinkingLevel::Xhigh, None),
        (ThinkingLevel::Max, None),
    ],
    default: ThinkingLevel::High,
    anthropic_wire: None,
};

pub(in crate::provider::model) fn protocol_fallback(vision: bool) -> ModelCapabilities {
    ModelProfile {
        max_input_tokens: 1_000_000,
        max_output_tokens: 128_000,
        vision,
        reasoning: FALLBACK_REASONING,
        ..BASE
    }
    .capabilities()
}

pub(super) const NO_REASONING: ReasoningProfile = ReasoningProfile {
    levels: &[(ThinkingLevel::Off, None)],
    default: ThinkingLevel::Off,
    anthropic_wire: None,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct ModelProfile {
    /// Maximum request input accepted by the model, excluding generated output.
    pub max_input_tokens: u32,
    /// Documented total context window (input + output) for display. `None`
    /// falls back to `max_input_tokens`. Only set when the provider documents
    /// a total window larger than the request input limit (e.g. DeepSeek V4:
    /// 1M total, 616K input at the maximum 384K output).
    pub advertised_context_window: Option<u32>,
    /// Maximum generated output accepted by the model.
    pub max_output_tokens: u32,
    pub vision: bool,
    pub reasoning: ReasoningProfile,
    pub remote_compaction: bool,
    /// Optional explicit compaction threshold for models whose usable input
    /// is smaller than the advertised window (e.g. Anthropic 200k models with
    /// output headroom carved out). `None` follows pi: compaction triggers at
    /// `context_window - reserve_tokens`, however large the window is.
    pub compaction_limit: Option<u32>,
    pub default_verbosity: Option<Verbosity>,
}

pub(super) const BASE: ModelProfile = ModelProfile {
    max_input_tokens: 200_000,
    advertised_context_window: None,
    max_output_tokens: 8_192,
    vision: true,
    reasoning: STANDARD_REASONING,
    remote_compaction: false,
    compaction_limit: None,
    default_verbosity: None,
};

impl ModelProfile {
    /// Copy the documented window from a newer-or-equal family profile.
    /// Uncatalogued successors inherit this until they get their own entry.
    pub(super) const fn with_window(self, from: Self) -> Self {
        Self {
            max_input_tokens: from.max_input_tokens,
            advertised_context_window: from.advertised_context_window,
            ..self
        }
    }

    pub(super) fn capabilities(self) -> ModelCapabilities {
        ModelCapabilities {
            max_input_tokens: self.max_input_tokens,
            advertised_context_window: self
                .advertised_context_window
                .unwrap_or(self.max_input_tokens),
            max_output_tokens: self.max_output_tokens,
            input: if self.vision {
                vec![InputModality::Text, InputModality::Image]
            } else {
                vec![InputModality::Text]
            },
            reasoning: ReasoningCapabilities::new(
                levels_map(self.reasoning.levels),
                self.reasoning.default,
                self.reasoning.anthropic_wire,
            ),
            default_verbosity: self.default_verbosity,
            compaction_limit: self.compaction_limit,
            remote_compaction: self.remote_compaction,
        }
    }
}

pub(super) fn levels_map(levels: ReasoningLevels) -> HashMap<ThinkingLevel, Option<String>> {
    levels
        .iter()
        .map(|(level, effort)| (*level, effort.map(str::to_string)))
        .collect()
}

/// First `major.minor` pair in `id`, ignoring non-digit separators.
/// `"5.7-nova"` and `"5p2"` both parse as `(5, 7)` / `(5, 2)`.
pub(super) fn parse_version(id: &str) -> Option<(u32, u32)> {
    let mut parts = id
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| (1..=2).contains(&part.len()));
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// True when `id` starts with `prefix` and the following version is `>= min`.
pub(super) fn version_at_least(id: &str, prefix: &str, min: (u32, u32)) -> bool {
    id.strip_prefix(prefix)
        .and_then(parse_version)
        .is_some_and(|version| version >= min)
}
