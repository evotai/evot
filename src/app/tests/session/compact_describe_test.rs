use evot::session::compact::orchestrator::ManualCompactionOutcome;

fn compacted(
    method: Option<evot_engine::CompactionMethod>,
    used_fallback: bool,
    fallback_reason: Option<&str>,
    remote_blob_bytes: Option<usize>,
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
        remote_blob_bytes,
        fallback_reason: fallback_reason.map(str::to_string),
    }
}

#[test]
fn local_compaction_reports_only_the_token_and_message_delta() {
    let text = compacted(
        Some(evot_engine::CompactionMethod::Local),
        false,
        None,
        None,
        1000,
        20,
    )
    .describe();
    assert_eq!(text, "Session compacted: 100 → 20 tokens, 5 → 2 messages.");
}

#[test]
fn remote_compaction_reports_the_native_blob_size() {
    let text = compacted(
        Some(evot_engine::CompactionMethod::Remote),
        false,
        None,
        Some(4096),
        1000,
        20,
    )
    .describe();
    assert!(
        text.contains("Provider-native remote compaction was used."),
        "{text}"
    );
    assert!(text.contains("Native blob: 4096 bytes."), "{text}");
}

#[test]
fn a_failed_remote_attempt_names_the_local_fallback_and_its_reason() {
    let text = compacted(
        Some(evot_engine::CompactionMethod::RemoteFailedLocal),
        false,
        Some("upstream 503"),
        None,
        1000,
        20,
    )
    .describe();
    assert!(
        text.contains("Provider-native remote compaction failed; local summarization was used."),
        "{text}"
    );
    assert!(text.contains("Reason: upstream 503"), "{text}");
}

#[test]
fn a_deterministic_summary_is_disclosed_as_a_fallback() {
    let text = compacted(
        Some(evot_engine::CompactionMethod::Local),
        true,
        None,
        None,
        1000,
        20,
    )
    .describe();
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
        None,
        None,
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
