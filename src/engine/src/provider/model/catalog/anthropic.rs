use super::super::capabilities::AnthropicThinkingWire;
use super::profile::ModelProfile;
use super::profile::ReasoningProfile;
use super::profile::BASE;
use crate::ThinkingLevel;

const CLAUDE_STANDARD_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, None),
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
];
const CLAUDE_MAX_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, None),
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Max, Some("max")),
];
const CLAUDE_XHIGH_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Off, None),
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Xhigh, Some("xhigh")),
    (ThinkingLevel::Max, Some("max")),
];

const STANDARD_REASONING: ReasoningProfile = ReasoningProfile {
    levels: CLAUDE_STANDARD_LEVELS,
    default: ThinkingLevel::Off,
    anthropic_wire: None,
};
const ADAPTIVE_MAX_REASONING: ReasoningProfile = ReasoningProfile {
    levels: CLAUDE_MAX_LEVELS,
    default: ThinkingLevel::High,
    anthropic_wire: Some(AnthropicThinkingWire::Adaptive),
};
const ADAPTIVE_XHIGH_REASONING: ReasoningProfile = ReasoningProfile {
    levels: CLAUDE_XHIGH_LEVELS,
    default: ThinkingLevel::High,
    anthropic_wire: Some(AnthropicThinkingWire::Adaptive),
};
// Always-on adaptive thinking (Fable 5.x, Opus/Sonnet 5.5+): there is no
// Off tier, unlike Opus/Sonnet 5 and Haiku 5.x.
const ADAPTIVE_MANDATORY_LEVELS: &[(ThinkingLevel, Option<&str>)] = &[
    (ThinkingLevel::Low, Some("low")),
    (ThinkingLevel::Medium, Some("medium")),
    (ThinkingLevel::High, Some("high")),
    (ThinkingLevel::Xhigh, Some("xhigh")),
    (ThinkingLevel::Max, Some("max")),
];
const ADAPTIVE_MANDATORY_REASONING: ReasoningProfile = ReasoningProfile {
    levels: ADAPTIVE_MANDATORY_LEVELS,
    default: ThinkingLevel::High,
    anthropic_wire: Some(AnthropicThinkingWire::Adaptive),
};

const MODERN: ModelProfile = ModelProfile {
    max_input_tokens: 200_000,
    max_output_tokens: 64_000,
    reasoning: STANDARD_REASONING,
    compaction_limit: Some(180_000),
    ..BASE
};
// 1M total context window; the input limit below is the window minus output
// headroom, which is what users recognize as the model's window size.
const OPUS_LONG_CONTEXT_XHIGH: ModelProfile = ModelProfile {
    max_input_tokens: 867_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 128_000,
    reasoning: ADAPTIVE_XHIGH_REASONING,
    ..BASE
};
const SONNET_LONG_CONTEXT_XHIGH: ModelProfile = ModelProfile {
    max_input_tokens: 872_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 128_000,
    reasoning: ADAPTIVE_XHIGH_REASONING,
    ..BASE
};
const FABLE: ModelProfile = ModelProfile {
    max_input_tokens: 867_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 128_000,
    reasoning: ADAPTIVE_MANDATORY_REASONING,
    ..BASE
};
const OPUS_LONG_CONTEXT_MANDATORY: ModelProfile = ModelProfile {
    reasoning: ADAPTIVE_MANDATORY_REASONING,
    ..OPUS_LONG_CONTEXT_XHIGH
};
const SONNET_LONG_CONTEXT_MANDATORY: ModelProfile = ModelProfile {
    reasoning: ADAPTIVE_MANDATORY_REASONING,
    ..SONNET_LONG_CONTEXT_XHIGH
};
// Haiku 5.5 accepts 1M tokens, but any request above 100k input is billed at
// the 5x long-context tier for the whole request. Default to the cheap tier
// with auto-compaction at 90%; users can raise the window via overrides.
const HAIKU_5_5: ModelProfile = ModelProfile {
    max_input_tokens: 100_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 128_000,
    reasoning: ADAPTIVE_XHIGH_REASONING,
    compaction_limit: Some(90_000),
    ..BASE
};
const OPUS_LONG_CONTEXT_MAX: ModelProfile = ModelProfile {
    max_input_tokens: 867_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 128_000,
    reasoning: ADAPTIVE_MAX_REASONING,
    ..BASE
};
const SONNET_LONG_CONTEXT_MAX: ModelProfile = ModelProfile {
    max_input_tokens: 931_000,
    advertised_context_window: Some(1_000_000),
    max_output_tokens: 64_000,
    reasoning: ADAPTIVE_MAX_REASONING,
    ..BASE
};

#[rustfmt::skip]
const PROFILES: &[(&str, ModelProfile)] = &[
    ("claude-fable-5-1",  FABLE),
    ("claude-fable-5",    FABLE),
    ("claude-opus-5-5",   OPUS_LONG_CONTEXT_MANDATORY),
    ("claude-opus-5",     OPUS_LONG_CONTEXT_XHIGH),
    ("claude-opus-4-8",   OPUS_LONG_CONTEXT_XHIGH),
    ("claude-opus-4-7",   OPUS_LONG_CONTEXT_XHIGH),
    ("claude-opus-4-6",   OPUS_LONG_CONTEXT_MAX),
    ("claude-opus-4-5",   MODERN),
    ("claude-sonnet-5-5", SONNET_LONG_CONTEXT_MANDATORY),
    ("claude-sonnet-5",   SONNET_LONG_CONTEXT_XHIGH),
    ("claude-sonnet-4-6", SONNET_LONG_CONTEXT_MAX),
    ("claude-sonnet-4-5", MODERN),
    ("claude-sonnet-4",   MODERN),
    ("claude-haiku-5-5",  HAIKU_5_5),
    ("claude-haiku-5",    SONNET_LONG_CONTEXT_XHIGH),
    ("claude-haiku-4-5",  MODERN),
];

pub(super) fn resolve(id: &str) -> Option<ModelProfile> {
    PROFILES
        .iter()
        .find_map(|(candidate, profile)| (*candidate == id).then_some(*profile))
}

pub(super) fn fallback(id: &str) -> Option<ModelProfile> {
    let Some((family, major, minor)) = model_version(id) else {
        return (id.contains("claude") || id.contains("fable")).then_some(BASE);
    };

    if family == "fable" {
        Some(FABLE)
    } else if family == "opus" && (major, minor) >= (5, 5) {
        Some(OPUS_LONG_CONTEXT_MANDATORY)
    } else if family == "opus" && (major, minor) >= (4, 7) {
        Some(OPUS_LONG_CONTEXT_XHIGH)
    } else if family == "sonnet" && (major, minor) >= (5, 5) {
        Some(SONNET_LONG_CONTEXT_MANDATORY)
    } else if family == "sonnet" && major >= 5 {
        Some(SONNET_LONG_CONTEXT_XHIGH)
    } else if family == "haiku" && (major, minor) >= (5, 5) {
        Some(HAIKU_5_5)
    } else if family == "haiku" && major >= 5 {
        Some(SONNET_LONG_CONTEXT_XHIGH)
    } else if family == "opus" && (major, minor) >= (4, 6) {
        Some(OPUS_LONG_CONTEXT_MAX)
    } else if family == "sonnet" && (major, minor) >= (4, 6) {
        Some(SONNET_LONG_CONTEXT_MAX)
    } else if major >= 4 {
        Some(MODERN)
    } else {
        Some(BASE)
    }
}

fn model_version(id: &str) -> Option<(&'static str, u32, u32)> {
    let family = ["opus", "sonnet", "haiku", "fable"]
        .into_iter()
        .find(|family| id.contains(*family))?;
    let after = id.split(family).nth(1)?;
    let mut parts = after
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| (1..=2).contains(&part.len()));
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some((family, major, minor))
}
