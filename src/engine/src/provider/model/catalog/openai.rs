use super::super::capabilities::AnthropicThinkingWire;
use super::super::capabilities::Verbosity;
use super::profile::ModelProfile;
use super::profile::ReasoningProfile;
use super::profile::BASE;
use crate::ThinkingLevel;

const GPT_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Xhigh, Some("xhigh")),
];
// GPT-5.6 and newer accept low..max (Codex also offers `ultra` on
// sol/terra/astra; evot caps the ladder at `max`). The public API still takes
// `none` on 5.6-* and 6-sol/6-luna; GPT-6 Astra and GPT-6.1 Sol reject it.
const GPT_5_6_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, Some("none")),
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Xhigh, Some("xhigh")),
    (ThinkingLevel::Max, Some("max")),
];
const GPT_5_5_PRO_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Xhigh, Some("xhigh")),
];
const LEGACY_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, Some("none")),
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
];

const GPT_REASONING: ReasoningProfile = ReasoningProfile {
    levels: GPT_LEVELS,
    default: ThinkingLevel::Medium,
    anthropic_wire: Some(AnthropicThinkingWire::Enabled),
};
const GPT_5_6_REASONING: ReasoningProfile = ReasoningProfile {
    levels: GPT_5_6_LEVELS,
    default: ThinkingLevel::Medium,
    anthropic_wire: Some(AnthropicThinkingWire::Enabled),
};
const GPT_6_MANDATORY_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Xhigh, Some("xhigh")),
    (ThinkingLevel::Max, Some("max")),
];
const GPT_6_MANDATORY_REASONING: ReasoningProfile = ReasoningProfile {
    levels: GPT_6_MANDATORY_LEVELS,
    default: ThinkingLevel::Medium,
    anthropic_wire: Some(AnthropicThinkingWire::Enabled),
};
const GPT_5_5_PRO_REASONING: ReasoningProfile = ReasoningProfile {
    levels: GPT_5_5_PRO_LEVELS,
    default: ThinkingLevel::Medium,
    anthropic_wire: Some(AnthropicThinkingWire::Enabled),
};
const LEGACY_REASONING: ReasoningProfile = ReasoningProfile {
    levels: LEGACY_LEVELS,
    default: ThinkingLevel::Medium,
    anthropic_wire: Some(AnthropicThinkingWire::Enabled),
};

// 1M total context window; the input limit below is the window minus output
// headroom, which is what users recognize as the model's window size.
const GPT_5_5: ModelProfile = ModelProfile {
    max_input_tokens: 922_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 128_000,
    reasoning: GPT_REASONING,
    remote_compaction: true,
    default_verbosity: Some(Verbosity::Low),
    ..BASE
};
// Mirrors Codex `models.json` and pi for GPT-5.6 and newer. The API accepts
// ~1.05M tokens, but input above 272k is billed at the long-context tier
// (2x input, 1.5x output), so the default window stays at 272k with
// auto-compaction at 90% (`auto_compact_token_limit`).
const GPT_5_6: ModelProfile = ModelProfile {
    max_input_tokens: 272_000,
    advertised_context_window: None,
    max_output_tokens: 128_000,
    reasoning: GPT_5_6_REASONING,
    remote_compaction: true,
    compaction_limit: Some(244_800),
    default_verbosity: Some(Verbosity::Low),
    ..BASE
};
// Reasoning cannot be disabled on these models (`effort: none` is rejected).
const GPT_6_MANDATORY: ModelProfile = ModelProfile {
    reasoning: GPT_6_MANDATORY_REASONING,
    ..GPT_5_6
};

#[rustfmt::skip]
const PROFILES: &[(&str, ModelProfile)] = &[
    ("gpt-5.4",       ModelProfile { max_input_tokens: 922_000, advertised_context_window: Some(1_000_000), max_output_tokens: 128_000, reasoning: GPT_REASONING, remote_compaction: true, ..BASE }),
    ("gpt-5.4-pro",   ModelProfile { max_input_tokens: 922_000, advertised_context_window: Some(1_000_000), max_output_tokens: 128_000, reasoning: GPT_REASONING, remote_compaction: true, ..BASE }),
    ("gpt-5.5",       GPT_5_5),
    ("gpt-5.5-pro",   ModelProfile { max_input_tokens: 922_000, advertised_context_window: Some(1_000_000), max_output_tokens: 128_000, reasoning: GPT_5_5_PRO_REASONING, remote_compaction: true, ..BASE }),
    ("gpt-5.6-luna",  GPT_5_6),
    ("gpt-5.6-sol",   GPT_5_6),
    ("gpt-5.6-terra", GPT_5_6),
    ("gpt-6-astra",   GPT_6_MANDATORY),
    ("gpt-6-luna",    GPT_5_6),
    ("gpt-6-sol",     GPT_5_6),
    ("gpt-6.1-sol",   GPT_6_MANDATORY),
];

pub(super) fn resolve(id: &str) -> Option<ModelProfile> {
    PROFILES
        .iter()
        .find_map(|(candidate, profile)| (*candidate == id).then_some(*profile))
}

/// Conservative metadata for uncatalogued OpenAI reasoning families.
/// GPT 5.6+ inherits the 272k profile (minus the remote compaction and
/// verbosity allowlists, and without `none` since newer models reject it);
/// 5.4/5.5 inherit the 1M window; older ids stay on 128k.
pub(super) fn fallback(id: &str) -> Option<ModelProfile> {
    if id.starts_with("gpt-") || id.starts_with("codex-") {
        if super::profile::version_at_least(id, "gpt-", (5, 6)) {
            return Some(ModelProfile {
                remote_compaction: false,
                default_verbosity: None,
                ..GPT_6_MANDATORY
            });
        }
        let reasoning = if ["gpt-5.4", "gpt-5.5"]
            .iter()
            .any(|family| id.contains(family))
        {
            GPT_REASONING
        } else {
            LEGACY_REASONING
        };
        let profile = ModelProfile {
            max_input_tokens: 128_000,
            max_output_tokens: 32_768,
            reasoning,
            ..BASE
        };
        return Some(if super::profile::version_at_least(id, "gpt-", (5, 4)) {
            profile.with_window(GPT_5_5)
        } else {
            profile
        });
    }
    if id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4") {
        return Some(ModelProfile {
            max_input_tokens: 128_000,
            max_output_tokens: 32_768,
            vision: false,
            reasoning: LEGACY_REASONING,
            ..BASE
        });
    }
    None
}
