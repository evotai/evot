//! Tests for `ContextTracker` — context size measured from the provider's own
//! usage embedded in the transcript, not a local tokenizer.

use evotengine::context::ContextTracker;
use evotengine::types::*;

fn user_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        timestamp: 0,
    })
}

fn assistant_with_input(text: &str, input: u64, cache_read: u64) -> AgentMessage {
    assistant_at(text, input, cache_read, 0)
}

/// An assistant response whose visible content is large enough that its
/// provider usage is plausible for the prefix it answered. Usage that dwarfs
/// the local estimate is rejected as a context anchor (see
/// `implausible_usage_is_not_a_context_anchor`), so tests that expect the
/// provider count to win must carry matching content.
fn anchored_assistant_at(input: u64, cache_read: u64, timestamp: u64) -> AgentMessage {
    let body = "x".repeat(((input + cache_read) * 4) as usize);
    assistant_at(&body, input, cache_read, timestamp)
}

fn assistant_at(text: &str, input: u64, cache_read: u64, timestamp: u64) -> AgentMessage {
    AgentMessage::Llm(Message::Assistant {
        content: vec![Content::Text {
            text: text.to_string(),
        }],
        stop_reason: StopReason::Stop,
        model: "test".into(),
        provider: "test".into(),
        usage: Usage {
            input,
            output: 50,
            cache_read,
            cache_write: 0,
            total_tokens: input + cache_read + 50,
            reasoning_output: 0,
        },
        timestamp,
        error_message: None,
        response_id: None,
    })
}

/// The anchor is the provider's real total usage, plus a pi-compatible estimate
/// of only the messages appended after it.
#[test]
fn anchors_on_latest_assistant_usage_plus_trailing() {
    let tracker = ContextTracker::new();
    let trailing = "x".repeat(400); // 100 tokens at UTF-16 chars / 4
    let messages = vec![
        user_msg("hello"),
        anchored_assistant_at(90_000, 10_000, 0),
        user_msg(&trailing),
    ];

    let estimate = tracker.estimate_context_tokens(&messages);
    // 100_050 provider total (input + cache_read + output), plus 100 tokens
    // for the trailing user message. pi adds no synthetic role envelope.
    assert_eq!(estimate, 100_050 + 100);
}

/// The fix for the resume bug: a fresh tracker (as built on every resumed run)
/// still reports the provider-anchored size because the anchor lives in the
/// message list, not in lost in-memory state.
#[test]
fn fresh_tracker_recovers_anchor_on_resume() {
    let messages = vec![
        user_msg("earlier turn"),
        anchored_assistant_at(98_000, 0, 0),
    ];

    // A brand-new tracker is what a resumed session starts with.
    let resumed = ContextTracker::new();
    let estimate = resumed.estimate_context_tokens(&messages);

    // Anchored on the real provider total, including 50 output tokens.
    assert_eq!(estimate, 98_050);
}

/// Before any assistant response (first turn of a fresh session) there is no
/// anchor, so the pi-compatible local estimate over the whole list is the floor.
#[test]
fn falls_back_to_local_estimate_without_anchor() {
    let tracker = ContextTracker::new();
    let messages = vec![user_msg(&"x".repeat(400))];

    // No provider usage yet: 400 UTF-16 units / 4 = 100 tokens.
    assert_eq!(tracker.estimate_context_tokens(&messages), 100);
}

/// Assistant usage recorded at or before the compaction boundary describes the
/// pre-compaction (larger) context and must not anchor the estimate.
#[test]
fn suppresses_stale_anchor_from_before_compaction() {
    let mut tracker = ContextTracker::new();
    // Pre-compaction response measured a huge context.
    let messages = vec![
        user_msg("q"),
        assistant_at("big-context answer", 150_000, 0, 100),
    ];

    tracker.record_compaction_done(100);
    let after_compaction = tracker.estimate_context_tokens(&messages);
    assert!(
        after_compaction < 1_000,
        "stale anchor should be suppressed, got {after_compaction}"
    );
}

/// A response that landed after the boundary is a valid measurement of the
/// compacted context, so it anchors immediately — no extra round trip needed.
#[test]
fn anchors_on_response_after_compaction_boundary() {
    let mut tracker = ContextTracker::new();
    tracker.record_compaction_done(100);

    let messages = vec![user_msg("q"), anchored_assistant_at(40_000, 0, 101)];
    assert_eq!(tracker.estimate_context_tokens(&messages), 40_050);
}

/// The newest response wins, but only past the boundary: a stale pre-compaction
/// message later in the list must not resurface as the anchor.
#[test]
fn boundary_applies_per_message_not_to_the_whole_list() {
    let mut tracker = ContextTracker::new();
    tracker.record_compaction_done(100);

    let messages = vec![
        user_msg("q"),
        anchored_assistant_at(40_000, 0, 101),
        user_msg("next"),
        assistant_at("stale replay", 150_000, 0, 50),
    ];
    // The trailing message predates the boundary, so the 40k anchor is used.
    let estimate = tracker.estimate_context_tokens(&messages);
    assert!(
        (40_050..41_000).contains(&estimate),
        "expected the post-boundary anchor, got {estimate}"
    );
}

#[test]
fn output_only_usage_is_a_context_anchor() {
    let tracker = ContextTracker::new();
    let large_history = "x".repeat(40_000);
    let mut output_only = assistant_with_input("synthetic", 0, 0);
    if let AgentMessage::Llm(Message::Assistant { usage, .. }) = &mut output_only {
        usage.output = 10;
        usage.total_tokens = 10;
    }
    let messages = vec![user_msg(&large_history), output_only, user_msg("trailing")];

    assert_eq!(tracker.estimate_context_tokens(&messages), 12);
}

#[test]
fn nonzero_error_usage_is_not_a_context_anchor() {
    let tracker = ContextTracker::new();
    let large_history = "x".repeat(40_000);
    let mut error = assistant_with_input("failed", 10, 0);
    if let AgentMessage::Llm(Message::Assistant {
        stop_reason,
        error_message,
        ..
    }) = &mut error
    {
        *stop_reason = StopReason::Error;
        *error_message = Some("overloaded".into());
    }

    let estimate = tracker.estimate_context_tokens(&[user_msg(&large_history), error]);
    assert!(estimate > 9_000, "error usage must not anchor: {estimate}");
}

#[test]
fn nonzero_aborted_usage_is_not_a_context_anchor() {
    let tracker = ContextTracker::new();
    let large_history = "x".repeat(40_000);
    let mut aborted = assistant_with_input("cancelled", 10, 0);
    if let AgentMessage::Llm(Message::Assistant { stop_reason, .. }) = &mut aborted {
        *stop_reason = StopReason::Aborted;
    }

    let estimate = tracker.estimate_context_tokens(&[user_msg(&large_history), aborted]);
    assert!(
        estimate > 9_000,
        "aborted usage must not anchor: {estimate}"
    );
}

#[test]
fn usage_older_than_its_prefix_is_not_a_context_anchor() {
    let tracker = ContextTracker::new();
    let large_history = AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![Content::Text {
            text: "x".repeat(40_000),
        }],
        timestamp: 100,
    });
    let stale = assistant_at("stale", 10, 0, 99);

    let estimate = tracker.estimate_context_tokens(&[large_history, stale]);
    assert!(estimate > 9_000, "stale usage must not anchor: {estimate}");
}

#[test]
fn model_switch_does_not_reuse_foreign_usage_anchor() {
    let tracker = ContextTracker::new();
    let large_history = "x".repeat(40_000);
    let mut old_model = assistant_with_input("old answer", 100, 0);
    if let AgentMessage::Llm(Message::Assistant { model, .. }) = &mut old_model {
        *model = "old-model".into();
    }
    let messages = vec![user_msg(&large_history), old_model, user_msg("next prompt")];

    let old_estimate =
        tracker.estimate_context_tokens_for_model(&messages, Some("test"), Some("old-model"));
    let new_estimate =
        tracker.estimate_context_tokens_for_model(&messages, Some("test"), Some("new-model"));

    assert!(old_estimate < 1_000, "matching model should use its anchor");
    assert!(
        new_estimate > 9_000,
        "new model must estimate the complete history instead of reusing foreign usage: {new_estimate}"
    );
}

#[test]
fn provider_switch_does_not_reuse_same_named_model_anchor() {
    let tracker = ContextTracker::new();
    let large_history = "x".repeat(40_000);
    let mut foreign_provider = assistant_with_input("old answer", 100, 0);
    if let AgentMessage::Llm(Message::Assistant {
        provider, model, ..
    }) = &mut foreign_provider
    {
        *provider = "old-provider".into();
        *model = "shared-model".into();
    }
    let messages = vec![user_msg(&large_history), foreign_provider];

    let estimate = tracker.estimate_context_tokens_for_model(
        &messages,
        Some("new-provider"),
        Some("shared-model"),
    );

    assert!(
        estimate > 9_000,
        "same model id from another provider must not anchor context: {estimate}"
    );
}

#[test]
fn native_total_tokens_take_precedence_over_component_fallback() {
    let tracker = ContextTracker::new();
    let mut assistant = anchored_assistant_at(90_000, 10_000, 0);
    if let AgentMessage::Llm(Message::Assistant { usage, .. }) = &mut assistant {
        usage.total_tokens = 100_123;
    }

    assert_eq!(tracker.estimate_context_tokens(&[assistant]), 100_123);
}

#[test]
fn zero_native_total_falls_back_to_usage_components() {
    let tracker = ContextTracker::new();
    let mut assistant = anchored_assistant_at(90_000, 10_000, 0);
    if let AgentMessage::Llm(Message::Assistant { usage, .. }) = &mut assistant {
        usage.total_tokens = 0;
    }

    assert_eq!(tracker.estimate_context_tokens(&[assistant]), 100_050);
}

/// A provider count that cannot describe the prefix it answered — here a
/// gateway summing a whole run's prompt tokens into one response — must not
/// anchor the estimate; the local estimate of the actual history is used.
#[test]
fn implausible_usage_is_not_a_context_anchor() {
    let tracker = ContextTracker::new();
    let history = "x".repeat(400_000); // 100k local tokens
    let messages = vec![
        user_msg(&history),
        assistant_with_input("done", 305_000, 4_900_000),
    ];

    let estimate = tracker.estimate_context_tokens(&messages);
    assert!(
        (100_000..101_000).contains(&estimate),
        "5.2M usage on a 100k prefix must fall back to the local estimate: {estimate}"
    );
}

/// Rejecting one bogus response falls back to the previous trustworthy anchor
/// plus the trailing delta, not to a full-history estimate.
#[test]
fn implausible_usage_falls_back_to_previous_anchor() {
    let tracker = ContextTracker::new();
    let messages = vec![
        user_msg("q"),
        anchored_assistant_at(90_000, 10_000, 1),
        user_msg(&"y".repeat(400)),
        assistant_with_input("done", 305_000, 4_900_000),
    ];

    let estimate = tracker.estimate_context_tokens(&messages);
    // 100_050 anchor + 100 trailing user tokens + "done" (1 token).
    assert_eq!(estimate, 100_050 + 100 + 1);
}

/// The bound is loose on purpose: CJK text and images legitimately count far
/// above the UTF-16 / 4 heuristic, and small requests carry provider overhead.
#[test]
fn moderately_high_usage_stays_a_context_anchor() {
    let tracker = ContextTracker::new();
    let cjk_history = "文".repeat(40_000); // 10k local tokens, ~3x more real
    let messages = vec![
        user_msg(&cjk_history),
        assistant_with_input("好", 35_000, 0),
    ];

    assert_eq!(tracker.estimate_context_tokens(&messages), 35_050);
}

#[test]
fn usage_plausibility_bound_is_factor_plus_slack() {
    use evotengine::context::window::usage_is_plausible;
    use evotengine::context::window::USAGE_PLAUSIBILITY_FACTOR;
    use evotengine::context::window::USAGE_PLAUSIBILITY_SLACK_TOKENS;

    let local = 10_000;
    let bound = local * USAGE_PLAUSIBILITY_FACTOR + USAGE_PLAUSIBILITY_SLACK_TOKENS;
    assert!(usage_is_plausible(bound, local));
    assert!(!usage_is_plausible(bound + 1, local));
    // Tiny requests are always covered by the slack alone.
    assert!(usage_is_plausible(USAGE_PLAUSIBILITY_SLACK_TOKENS, 0));
    // The incident shape: 5.2M reported against a ~300k request.
    assert!(!usage_is_plausible(5_200_000, 300_000));
}
