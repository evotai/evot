use super::super::capabilities::AnthropicThinkingWire;
use super::profile::ModelProfile;
use super::profile::ReasoningProfile;
use super::profile::BASE;
use super::profile::NO_REASONING;
use crate::ThinkingLevel;

const REASONER_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, None),
    (ThinkingLevel::High, Some("high")),
];
const REASONER: ReasoningProfile = ReasoningProfile {
    levels: REASONER_LEVELS,
    default: ThinkingLevel::High,
    anthropic_wire: None,
};

// DeepSeek V4 accepts these requested effort values. models.dev advertises
// `low`/`high`/`max` for the family; there is no `xhigh` tier, and the flash
// variants are the only V4 models that accept `low` (the pro variant rejects it).
const V4_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, None),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Max, Some("max")),
];
const V4_REASONING: ReasoningProfile = ReasoningProfile {
    levels: V4_LEVELS,
    default: ThinkingLevel::High,
    anthropic_wire: Some(AnthropicThinkingWire::DeepSeek),
};

const V4_FLASH_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, None),
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Max, Some("max")),
];
const V4_FLASH_REASONING: ReasoningProfile = ReasoningProfile {
    levels: V4_FLASH_LEVELS,
    default: ThinkingLevel::High,
    anthropic_wire: Some(AnthropicThinkingWire::DeepSeek),
};

// The documented 1M total context leaves 616K input at the maximum 384K output.
// The advertised 1M window is what users recognize; 616K is the real input
// budget used for compaction/overflow math.
const V4: ModelProfile = ModelProfile {
    max_input_tokens: 616_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 384_000,
    vision: false,
    reasoning: V4_REASONING,
    ..BASE
};

// The V4.1 Flash line is multimodal; V4 Pro is text-only.
const V4_FLASH: ModelProfile = ModelProfile {
    vision: true,
    reasoning: V4_FLASH_REASONING,
    ..V4
};

#[rustfmt::skip]
const PROFILES: &[(&str, ModelProfile)] = &[
    ("deepseek-chat",               ModelProfile { max_input_tokens: 128_000, max_output_tokens: 8_192, vision: false, reasoning: NO_REASONING, ..BASE }),
    ("deepseek-reasoner",           ModelProfile { max_input_tokens: 128_000, max_output_tokens: 64_000, vision: false, reasoning: REASONER, ..BASE }),
    // `deepseek-flash` is the current name for V4.1 Flash; below it are its
    // canonical id and deprecated aliases. They all resolve to the same profile
    // so stored sessions and existing user config keep working.
    ("deepseek-flash",              V4_FLASH),
    ("deepseek-v4.1-flash",         V4_FLASH),
    ("deepseek-v4-flash",           V4_FLASH),
    ("deepseek-v4-flash-vision-exp", V4_FLASH),
    ("deepseek-v4-pro",             V4),
];

pub(super) fn resolve(id: &str) -> Option<ModelProfile> {
    PROFILES
        .iter()
        .find_map(|(candidate, profile)| (*candidate == id).then_some(*profile))
}

/// Uncatalogued DeepSeek V4+ ids inherit the current 1M / 616K window. The
/// flash line is multimodal, so successors that name it keep vision.
pub(super) fn fallback(id: &str) -> Option<ModelProfile> {
    let is_v4 = super::profile::version_at_least(id, "deepseek-v", (4, 0));
    if id.starts_with("deepseek-flash") || (is_v4 && id.contains("flash")) {
        return Some(V4_FLASH);
    }
    is_v4.then_some(V4)
}
