//! Observability aggregation — build run summaries from transcript stats.

use std::collections::HashMap;

use crate::observability::CompactionResult;
use crate::observability::TranscriptStats;
use crate::types::CompactRecord;
use crate::types::LlmCallMetrics;
use crate::types::RunSummaryData;
use crate::types::ToolAggStats;
use crate::types::TranscriptItem;
use crate::types::UsageSummary;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Build a `CompactRecord` from a `CompactionResult`, or `None` for `NoOp`.
pub fn compact_record_from_result(result: &CompactionResult) -> Option<CompactRecord> {
    match result {
        CompactionResult::Compacted {
            before_message_count: _,
            before_tokens,
            after_tokens,
            messages_evicted,
            ..
        } => {
            let level = if *messages_evicted > 0 { 3 } else { 1 };
            Some(CompactRecord {
                level,
                from_tokens: *before_tokens,
                to_tokens: *after_tokens,
                action_map: String::new(),
            })
        }
        CompactionResult::NoOp => None,
    }
}

// ---------------------------------------------------------------------------
// StatsAggregator
// ---------------------------------------------------------------------------

/// Incrementally aggregates `TranscriptStats` into a run summary.
///
/// Used by both the real-time REPL path (ingest stats as events arrive) and
/// the offline path (ingest stats read back from transcript.jsonl).
#[derive(Debug, Default)]
pub struct StatsAggregator {
    pub llm_call_count: u32,
    pub tool_call_count: u32,
    pub system_prompt_tokens: usize,
    pub last_model: Option<String>,
    pub llm_metrics: Vec<LlmCallMetrics>,
    pub llm_output_tokens: Vec<u64>,
    pub tool_stats: HashMap<String, ToolAggStats>,
    pub compact_history: Vec<CompactRecord>,
    /// Latest context budget snapshot (estimated_tokens, budget_tokens).
    pub last_context_budget: Option<(usize, usize)>,
    // Run-level summary (from RunFinished stats)
    pub run_duration_ms: Option<u64>,
    pub run_usage: Option<UsageSummary>,
    pub run_turn_count: Option<u32>,
}

impl StatsAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset all accumulated state (call on RunStarted).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Ingest a single `TranscriptStats` event.
    pub fn ingest(&mut self, stats: &TranscriptStats) {
        match stats {
            TranscriptStats::LlmCallStarted(s) => {
                self.llm_call_count += 1;
                self.system_prompt_tokens = s.system_prompt_tokens;
                self.last_model = Some(s.model.clone());
            }
            TranscriptStats::LlmCallRetry(_) => {}
            TranscriptStats::LlmCallCompleted(s) => {
                if let Some(m) = &s.metrics {
                    self.llm_metrics.push(m.clone());
                }
                self.llm_output_tokens.push(s.usage.output);
            }
            TranscriptStats::ToolFinished(s) => {
                self.tool_call_count += 1;
                let entry = self.tool_stats.entry(s.tool_name.clone()).or_default();
                entry.calls += 1;
                entry.result_tokens += s.result_tokens;
                entry.duration_ms += s.duration_ms;
                if s.is_error {
                    entry.errors += 1;
                }
            }
            TranscriptStats::ContextCompactionStarted(s) => {
                self.last_context_budget = Some((s.estimated_tokens, s.budget_tokens));
            }
            TranscriptStats::ContextCompactionCompleted(s) => {
                if let Some(record) = compact_record_from_result(&s.result) {
                    self.compact_history.push(record);
                }
            }
            // Applied prunes reach the compact history through their own
            // CompactionCompleted record; the decide rounds are evaluation data.
            TranscriptStats::ContextPruned(_) => {}
            TranscriptStats::RunFinished(s) => {
                self.run_duration_ms = Some(s.duration_ms);
                self.run_usage = Some(s.usage.clone());
                self.run_turn_count = Some(s.turn_count);
            }
        }
    }

    /// Build a `RunSummaryData` for the real-time path.
    ///
    /// The caller provides the top-level run fields (from the RunFinished
    /// event payload), while tool/llm/compact details come from the aggregator.
    pub fn to_run_summary(
        &mut self,
        duration_ms: u64,
        turn_count: u32,
        usage: &UsageSummary,
    ) -> RunSummaryData {
        let mut tool_stats: Vec<(String, ToolAggStats)> = self.tool_stats.drain().collect();
        tool_stats.sort_by(|a, b| b.1.result_tokens.cmp(&a.1.result_tokens));

        RunSummaryData {
            duration_ms,
            turn_count,
            usage: usage.clone(),
            llm_call_count: self.llm_call_count,
            tool_call_count: self.tool_call_count,
            system_prompt_tokens: self.system_prompt_tokens,
            last_message_stats: None,
            llm_metrics: std::mem::take(&mut self.llm_metrics),
            llm_output_tokens: std::mem::take(&mut self.llm_output_tokens),
            tool_stats,
            compact_history: std::mem::take(&mut self.compact_history),
            last_context_budget: self.last_context_budget.take(),
        }
    }

    /// Build a `RunSummaryData` purely from ingested stats (offline path).
    ///
    /// Returns `None` if no `RunFinished` stats have been ingested.
    pub fn to_run_summary_from_stats(&mut self) -> Option<RunSummaryData> {
        let duration_ms = self.run_duration_ms?;
        let usage = self.run_usage.clone()?;
        let turn_count = self.run_turn_count?;
        Some(self.to_run_summary(duration_ms, turn_count, &usage))
    }

    /// Convenience: batch-ingest all stats from a slice of transcript items.
    pub fn from_items(items: &[TranscriptItem]) -> Self {
        let mut agg = Self::new();
        for item in items {
            if let Some(stats) = TranscriptStats::try_from_item(item) {
                agg.ingest(&stats);
            }
        }
        agg
    }
}
