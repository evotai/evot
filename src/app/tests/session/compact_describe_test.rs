use evot::session::compact::orchestrator::ManualCompactionOutcome;

fn compacted(
    method: Option<evot_engine::CompactionMethod>,
    used_fallback: bool,
    context_window: usize,
    tokens_after: usize,
) -> ManualCompactionOutcome {
    ManualCompactionOutcome::Compacted {
        summary: "s".into(),
        tokens_before: 100,
        tokens_after,
        messages_before: 5,
        messages_after: 2,
        context_window,
        messages_evicted: 3,
        current_run_reclaimed: 0,
        compaction_level: 1,
        used_fallback,
        method,
    }
}

#[test]
fn local_compaction_reports_only_the_token_and_message_delta() {
    let text = compacted(Some(evot_engine::CompactionMethod::Local), false, 1000, 20).describe();
    assert_eq!(text, "Session compacted: 100 → 20 tokens, 5 → 2 messages.");
}

#[test]
fn a_deterministic_summary_is_disclosed_as_a_fallback() {
    let text = compacted(Some(evot_engine::CompactionMethod::Local), true, 1000, 20).describe();
    assert!(
        text.contains("a deterministic fallback summary was used"),
        "{text}"
    );
}

/// Compaction that leaves usage above the window must keep warning: the user
/// has to switch models or start a new session, not retry the same compaction.
#[test]
fn usage_still_above_the_window_keeps_the_warning() {
    let text = compacted(
        Some(evot_engine::CompactionMethod::Local),
        false,
        1000,
        1200,
    )
    .describe();
    assert!(
        text.contains(
            "Warning: context is still 1200 tokens, above this model's 1000-token window."
        ),
        "{text}"
    );
}

#[test]
fn no_op_and_cancelled_outcomes_stay_distinguishable() {
    assert_eq!(
        ManualCompactionOutcome::NothingToCompact.describe(),
        "Nothing to compact."
    );
    assert_eq!(
        ManualCompactionOutcome::Cancelled.describe(),
        "Compaction cancelled."
    );
}
