use evot::agent::run::observability::StatsAggregator;
use evot::observability::*;
use evot::types::*;

// ---------------------------------------------------------------------------
// Basic ingest + summary
// ---------------------------------------------------------------------------

#[test]
fn aggregator_empty_summary() {
    let mut agg = StatsAggregator::new();
    let usage = UsageSummary::default();
    let summary = agg.to_run_summary(0, 0, &usage);
    assert_eq!(summary.llm_call_count, 0);
    assert_eq!(summary.tool_call_count, 0);
    assert!(summary.llm_metrics.is_empty());
    assert!(summary.tool_stats.is_empty());
    assert!(summary.compact_history.is_empty());
}

#[test]
fn aggregator_ingests_llm_call_started() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 5,
        message_bytes: 1200,
        system_prompt_tokens: 300,
        tool_definition_tokens: 0,
        ..Default::default()
    }));
    assert_eq!(agg.llm_call_count, 1);
    assert_eq!(agg.system_prompt_tokens, 300);
    assert_eq!(agg.last_model.as_deref(), Some("claude-3"));
}

#[test]
fn aggregator_ingests_llm_call_completed() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::LlmCallCompleted(LlmCallCompletedStats {
        turn: 1,
        attempt: 0,
        usage: UsageSummary {
            input: 1000,
            output: 200,
            cache_read: 0,
            cache_write: 0,
        },
        metrics: Some(LlmCallMetrics {
            duration_ms: 3000,
            ttfb_ms: 200,
            ttft_ms: 500,
            streaming_ms: 2500,
            chunk_count: 42,
        }),
        error: None,
        context_window: 0,
        stop_reason: "stop".into(),
    }));
    assert_eq!(agg.llm_metrics.len(), 1);
    assert_eq!(agg.llm_output_tokens, vec![200]);
}

#[test]
fn aggregator_ingests_tool_finished() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::ToolFinished(ToolFinishedStats {
        tool_call_id: "tc1".into(),
        tool_name: "read".into(),
        result_tokens: 150,
        duration_ms: 80,
        is_error: false,
    }));
    agg.ingest(&TranscriptStats::ToolFinished(ToolFinishedStats {
        tool_call_id: "tc2".into(),
        tool_name: "read".into(),
        result_tokens: 200,
        duration_ms: 120,
        is_error: false,
    }));
    agg.ingest(&TranscriptStats::ToolFinished(ToolFinishedStats {
        tool_call_id: "tc3".into(),
        tool_name: "bash".into(),
        result_tokens: 50,
        duration_ms: 500,
        is_error: true,
    }));

    assert_eq!(agg.tool_call_count, 3);

    let rf = agg.tool_stats.get("read");
    assert!(rf.is_some());
    let rf = rf.unwrap();
    assert_eq!(rf.calls, 2);
    assert_eq!(rf.result_tokens, 350);
    assert_eq!(rf.errors, 0);

    let bash = agg.tool_stats.get("bash");
    assert!(bash.is_some());
    let bash = bash.unwrap();
    assert_eq!(bash.calls, 1);
    assert_eq!(bash.errors, 1);
}

#[test]
fn aggregator_ingests_compaction_completed() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::ContextCompactionCompleted(
        ContextCompactionCompletedStats {
            reason: evot::types::CompactReason::Threshold,
            result: evot::observability::CompactionResult::Compacted {
                before_message_count: 20,
                after_message_count: 10,
                before_tokens: 50000,
                after_tokens: 25000,
                messages_evicted: 10,
                current_run_reclaimed: 0,
                method: None,
                remote_blob_bytes: None,
                fallback_reason: None,
            },
            context_window: 0,
            will_retry: false,
        },
    ));
    assert_eq!(agg.compact_history.len(), 1);
    assert_eq!(agg.compact_history[0].level, 3);
    assert_eq!(agg.compact_history[0].from_tokens, 50000);
    assert_eq!(agg.compact_history[0].to_tokens, 25000);
}

#[test]
fn aggregator_ignores_noop_compaction() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::ContextCompactionCompleted(
        ContextCompactionCompletedStats {
            reason: evot::types::CompactReason::Threshold,
            result: evot::observability::CompactionResult::NoOp,
            context_window: 0,
            will_retry: false,
        },
    ));
    assert!(agg.compact_history.is_empty());
}

#[test]
fn aggregator_ingests_run_once_cleared_compaction() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::ContextCompactionCompleted(
        ContextCompactionCompletedStats {
            reason: evot::types::CompactReason::Threshold,
            result: evot::observability::CompactionResult::Compacted {
                before_message_count: 8,
                after_message_count: 6,
                before_tokens: 80000,
                after_tokens: 60000,
                messages_evicted: 0,
                current_run_reclaimed: 2,
                method: None,
                remote_blob_bytes: None,
                fallback_reason: None,
            },
            context_window: 0,
            will_retry: false,
        },
    ));
    assert_eq!(agg.compact_history.len(), 1);
    assert_eq!(agg.compact_history[0].level, 1);
    assert_eq!(agg.compact_history[0].from_tokens, 80000);
    assert_eq!(agg.compact_history[0].to_tokens, 60000);
}

#[test]
fn aggregator_compaction_action_map_positions() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::ContextCompactionCompleted(
        ContextCompactionCompletedStats {
            reason: evot::types::CompactReason::Threshold,
            result: evot::observability::CompactionResult::Compacted {
                before_message_count: 10,
                after_message_count: 8,
                before_tokens: 40000,
                after_tokens: 30000,
                messages_evicted: 2,
                current_run_reclaimed: 0,
                method: None,
                remote_blob_bytes: None,
                fallback_reason: None,
            },
            context_window: 0,
            will_retry: false,
        },
    ));
    assert_eq!(agg.compact_history.len(), 1);
    assert_eq!(agg.compact_history[0].level, 3);
}

#[test]
fn aggregator_ingests_run_finished() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::RunFinished(RunFinishedStats {
        usage: UsageSummary {
            input: 5000,
            output: 1000,
            cache_read: 200,
            cache_write: 50,
        },
        turn_count: 3,
        duration_ms: 12000,
        transcript_count: 15,
    }));
    assert_eq!(agg.run_duration_ms, Some(12000));
    assert_eq!(agg.run_turn_count, Some(3));
    assert!(agg.run_usage.is_some());
}

// ---------------------------------------------------------------------------
// to_run_summary
// ---------------------------------------------------------------------------

#[test]
fn aggregator_to_run_summary_produces_correct_data() {
    let mut agg = StatsAggregator::new();

    // Simulate a run with 2 LLM calls and 1 tool call
    agg.ingest(&TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 3,
        message_bytes: 500,
        system_prompt_tokens: 200,
        tool_definition_tokens: 0,
        ..Default::default()
    }));
    agg.ingest(&TranscriptStats::LlmCallCompleted(LlmCallCompletedStats {
        turn: 1,
        attempt: 0,
        usage: UsageSummary {
            input: 500,
            output: 100,
            cache_read: 0,
            cache_write: 0,
        },
        metrics: Some(LlmCallMetrics {
            duration_ms: 2000,
            ttfb_ms: 100,
            ttft_ms: 300,
            streaming_ms: 1700,
            chunk_count: 20,
        }),
        error: None,
        context_window: 0,
        stop_reason: "stop".into(),
    }));
    agg.ingest(&TranscriptStats::ToolFinished(ToolFinishedStats {
        tool_call_id: "tc1".into(),
        tool_name: "bash".into(),
        result_tokens: 50,
        duration_ms: 300,
        is_error: false,
    }));
    agg.ingest(&TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 5,
        message_bytes: 800,
        system_prompt_tokens: 200,
        tool_definition_tokens: 0,
        ..Default::default()
    }));
    agg.ingest(&TranscriptStats::LlmCallCompleted(LlmCallCompletedStats {
        turn: 1,
        attempt: 0,
        usage: UsageSummary {
            input: 800,
            output: 150,
            cache_read: 0,
            cache_write: 0,
        },
        metrics: Some(LlmCallMetrics {
            duration_ms: 1500,
            ttfb_ms: 80,
            ttft_ms: 200,
            streaming_ms: 1300,
            chunk_count: 15,
        }),
        error: None,
        context_window: 0,
        stop_reason: "stop".into(),
    }));

    let usage = UsageSummary {
        input: 1300,
        output: 250,
        cache_read: 0,
        cache_write: 0,
    };
    let summary = agg.to_run_summary(5000, 1, &usage);

    assert_eq!(summary.llm_call_count, 2);
    assert_eq!(summary.tool_call_count, 1);
    assert_eq!(summary.system_prompt_tokens, 200);
    assert_eq!(summary.llm_metrics.len(), 2);
    assert_eq!(summary.llm_output_tokens, vec![100, 150]);
    assert_eq!(summary.tool_stats.len(), 1);
    assert_eq!(summary.tool_stats[0].0, "bash");
    assert_eq!(summary.duration_ms, 5000);
    assert_eq!(summary.turn_count, 1);
    assert!(summary.last_message_stats.is_none());
}

// ---------------------------------------------------------------------------
// to_run_summary_from_stats (offline path)
// ---------------------------------------------------------------------------

#[test]
fn aggregator_to_run_summary_from_stats_returns_none_without_run_finished() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 3,
        message_bytes: 500,
        system_prompt_tokens: 200,
        tool_definition_tokens: 0,
        ..Default::default()
    }));
    assert!(agg.to_run_summary_from_stats().is_none());
}

#[test]
fn aggregator_to_run_summary_from_stats_works_with_run_finished() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 3,
        message_bytes: 500,
        system_prompt_tokens: 200,
        tool_definition_tokens: 0,
        ..Default::default()
    }));
    agg.ingest(&TranscriptStats::RunFinished(RunFinishedStats {
        usage: UsageSummary {
            input: 500,
            output: 100,
            cache_read: 0,
            cache_write: 0,
        },
        turn_count: 1,
        duration_ms: 3000,
        transcript_count: 5,
    }));
    let summary = agg.to_run_summary_from_stats();
    assert!(summary.is_some());
    let summary = summary.unwrap();
    assert_eq!(summary.duration_ms, 3000);
    assert_eq!(summary.turn_count, 1);
    assert_eq!(summary.usage.input, 500);
}

// ---------------------------------------------------------------------------
// from_items (batch ingest)
// ---------------------------------------------------------------------------

#[test]
fn aggregator_from_items_batch_ingest() {
    let items = vec![
        TranscriptItem::User {
            provenance: None,
            text: "hello".into(),
            content: vec![],
        },
        TranscriptStats::LlmCallStarted(LlmCallStartedStats {
            turn: 1,
            attempt: 0,
            injected_count: 0,
            model: "claude-3".into(),
            message_count: 1,
            message_bytes: 100,
            system_prompt_tokens: 50,
            tool_definition_tokens: 0,
            ..Default::default()
        })
        .to_item(),
        TranscriptStats::LlmCallRetry(LlmCallRetryStats {
            turn: 1,
            attempt: 1,
            max_retries: 3,
            delay_ms: 1000,
            error: "network".into(),
        })
        .to_item(),
        TranscriptStats::LlmCallCompleted(LlmCallCompletedStats {
            turn: 1,
            attempt: 0,
            usage: UsageSummary {
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
            },
            metrics: None,
            error: None,
            context_window: 0,
            stop_reason: "stop".into(),
        })
        .to_item(),
        TranscriptItem::Assistant {
            content: vec![AssistantBlock::Text { text: "hi".into() }],
            stop_reason: "end_turn".into(),
            usage: UsageSummary::default(),
            model: String::new(),
            provider: String::new(),
            timestamp: 0,
            error_message: None,
        },
        TranscriptStats::RunFinished(RunFinishedStats {
            usage: UsageSummary {
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
            },
            turn_count: 1,
            duration_ms: 2000,
            transcript_count: 3,
        })
        .to_item(),
    ];

    let agg = StatsAggregator::from_items(&items);
    assert_eq!(agg.llm_call_count, 1);
    assert_eq!(agg.run_duration_ms, Some(2000));
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

#[test]
fn aggregator_reset_clears_state() {
    let mut agg = StatsAggregator::new();
    agg.ingest(&TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        turn: 1,
        attempt: 0,
        injected_count: 0,
        model: "claude-3".into(),
        message_count: 3,
        message_bytes: 500,
        system_prompt_tokens: 200,
        tool_definition_tokens: 0,
        ..Default::default()
    }));
    assert_eq!(agg.llm_call_count, 1);

    agg.reset();
    assert_eq!(agg.llm_call_count, 0);
    assert!(agg.last_model.is_none());
    assert_eq!(agg.system_prompt_tokens, 0);
}

// ---------------------------------------------------------------------------
// Trace span detail — delta-persisted request payload lookback
// ---------------------------------------------------------------------------

#[test]
fn trace_span_payload_resolves_nearest_non_empty_record() -> Result<(), String> {
    use evot::gateway::channels::http::dashboard::trace::project_span_detail;

    let assistant = TranscriptItem::Assistant {
        content: vec![],
        stop_reason: "end_turn".into(),
        usage: UsageSummary::default(),
        model: "m".into(),
        provider: "p".into(),
        timestamp: 0,
        error_message: None,
    };
    let full = TranscriptStats::LlmCallStarted(LlmCallStartedStats {
        system_prompt: "the prompt".into(),
        tool_definitions: vec![ToolDef {
            name: "read".into(),
            description: "read a file".into(),
            parameters: serde_json::json!({"type": "object"}),
        }],
        ..Default::default()
    })
    .to_item();
    // Delta-stripped repeat: payload omitted because it did not change.
    let stripped = TranscriptStats::LlmCallStarted(LlmCallStartedStats::default()).to_item();

    let entries: Vec<TranscriptEntry> = [full, assistant.clone(), stripped, assistant]
        .into_iter()
        .enumerate()
        .map(|(i, item)| TranscriptEntry::new("s".into(), None, (i + 1) as u64, 1, item))
        .collect();

    // The second span's own record is empty; its payload resolves from the
    // nearest earlier non-empty record.
    let detail = project_span_detail(&entries, 4).ok_or("span not found")?;
    assert_eq!(detail.system_prompt, "the prompt");
    assert_eq!(detail.tool_definitions.len(), 1);
    assert_eq!(detail.tool_definitions[0].name, "read");
    Ok(())
}
