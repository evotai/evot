//! Compaction controller — integrates trigger, planner, and executor into the agent loop.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::config::CompactionConfig;
use super::executor;
use super::executor::ExecutionResult;
use super::plan;
use super::prune::ApplyReport;
use super::prune::ApplyTrigger;
use super::prune::DecideReport;
use super::prune::PruneLedger;
use super::prune::PruneOptions;
use super::summarizer::mode::SummarizerContext;
use super::summary::LlmPolicy;
use super::summary::SummaryContexts;
use super::trigger::TriggerInput;
use super::trigger::{self};
use super::types::*;
use crate::context::tokens::total_tokens;
use crate::types::AgentMessage;

/// Threshold-compaction suppression key (droid-style): once a threshold
/// compaction failed to bring usage back under the limit, further threshold
/// compactions for the same model/threshold are skipped until usage recovers.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ThresholdKey {
    model: ModelId,
    threshold: usize,
}

/// Stateful controller that lives across turns in the agent loop.
pub struct CompactionController {
    config: CompactionConfig,
    overflow_recovery_attempted: bool,
    last_compaction_ts: Option<u64>,
    threshold_suppression: Option<ThresholdKey>,
    /// Cross-compaction state (previous summary, cumulative file ops).
    /// Seeded from the session's last compaction on resume so follow-up
    /// compactions update the existing summary instead of restarting.
    state: CompactionState,
    observer: Option<CompactionObserver>,
    /// Judge for the lossless prune branch; `None` keeps the summary-only
    /// behaviour. With a judge, verdicts collect in the [`PruneLedger`] and
    /// are applied at run end; every compaction prunes first and summarises
    /// only what the prune could not bring under the threshold.
    judge: Option<Arc<dyn crate::judge::Judge>>,
    prune_options: PruneOptions,
    /// Shared with the session so verdicts survive across runs; a run holds
    /// it only while it prunes, and runs of one session never overlap.
    ledger: Arc<tokio::sync::Mutex<PruneLedger>>,
}

/// What one run-end prune step did, for the event stream.
#[derive(Debug, Clone, Default)]
pub struct PruneOutcome {
    pub decided: Option<DecideReport>,
    pub applied: Option<ApplyReport>,
}

impl CompactionController {
    pub fn new(config: CompactionConfig) -> Self {
        Self {
            config,
            overflow_recovery_attempted: false,
            last_compaction_ts: None,
            threshold_suppression: None,
            state: CompactionState::default(),
            observer: None,
            judge: None,
            prune_options: PruneOptions::default(),
            ledger: Arc::new(tokio::sync::Mutex::new(PruneLedger::default())),
        }
    }

    /// Share the prune ledger across runs of a session.
    pub fn with_prune_ledger(mut self, ledger: Arc<tokio::sync::Mutex<PruneLedger>>) -> Self {
        self.ledger = ledger;
        self
    }

    /// Enable the prune branch: the judge decides continuously which tool
    /// calls still matter and edits are applied in cache-friendly batches.
    pub fn with_judge(mut self, judge: Arc<dyn crate::judge::Judge>) -> Self {
        self.judge = Some(judge);
        self
    }

    pub fn has_judge(&self) -> bool {
        self.judge.is_some()
    }

    /// True when the judge has a say and has not been asked yet in this
    /// process: the run start of a resumed session is then the same kind of
    /// boundary as a run end.
    pub async fn prune_pending_first_ask(&self) -> bool {
        self.judge.is_some() && self.ledger.lock().await.is_fresh()
    }

    /// One prune step: ask the judge when the context grew enough since the
    /// last round, then apply whatever is pending.
    ///
    /// Called at every run end (`RunEnd`) and, once the context is past
    /// `prune_trigger_threshold`, after each response (`Threshold`). Asking
    /// is a separate request to the judge and leaves the main model's cache
    /// alone; applying edits history and costs one cache miss, accepted
    /// because a trimmed context is what the run needs to keep going.
    pub async fn prune_step(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        context_tokens: usize,
        trigger: ApplyTrigger,
        now_ms: u64,
        cancel: CancellationToken,
    ) -> PruneOutcome {
        let Some(judge) = self.judge.clone() else {
            return PruneOutcome::default();
        };
        let mut outcome = PruneOutcome::default();
        let ledger = self.ledger.clone();
        let mut ledger = ledger.lock().await;
        if ledger.should_decide(messages, context_tokens, &self.prune_options) {
            notify_compaction_phase(&self.observer, CompactionPhase::Pruning);
            match ledger
                .decide(messages, judge.as_ref(), &self.prune_options, cancel)
                .await
            {
                Ok(report) => {
                    tracing::info!(
                        verdicts = report.verdicts.len(),
                        pending_tokens = report.pending_tokens,
                        requests = report.requests,
                        elapsed_ms = report.elapsed_ms,
                        "judge prune: decided"
                    );
                    outcome.decided = Some(report);
                }
                Err(error) => tracing::warn!(error = %error, "judge prune: decide failed"),
            }
        }
        if ledger.has_pending() {
            outcome.applied = Some(self.apply_with(&mut ledger, messages, trigger, now_ms));
        }
        outcome
    }

    fn apply_with(
        &mut self,
        ledger: &mut PruneLedger,
        messages: &mut Vec<AgentMessage>,
        trigger: ApplyTrigger,
        now_ms: u64,
    ) -> ApplyReport {
        let (pruned, report) = ledger.apply(std::mem::take(messages), &self.prune_options, trigger);
        *messages = pruned;
        if report.removed + report.truncated > 0 {
            self.last_compaction_ts = Some(now_ms);
            tracing::info!(
                removed = report.removed,
                truncated = report.truncated,
                skipped = report.skipped,
                before_tokens = report.before_tokens,
                after_tokens = report.after_tokens,
                trigger = ?report.trigger,
                "judge prune: applied"
            );
        }
        notify_compaction_phase(&self.observer, CompactionPhase::Complete);
        report
    }

    pub fn with_prune_options(mut self, options: PruneOptions) -> Self {
        self.prune_options = options;
        self
    }

    /// Seed cross-compaction state (e.g. restored from a persisted session).
    pub fn with_state(mut self, state: CompactionState) -> Self {
        self.last_compaction_ts = (state.timestamp > 0).then_some(state.timestamp);
        self.state = state;
        self
    }

    /// Observe live phases for automatic compaction.
    pub fn with_observer(mut self, observer: CompactionObserver) -> Self {
        self.observer = Some(observer);
        self
    }

    /// Current cross-compaction state (for persistence by the caller).
    pub fn state(&self) -> &CompactionState {
        &self.state
    }

    /// Access current config.
    pub fn config(&self) -> &CompactionConfig {
        &self.config
    }

    /// Start a new user turn. Overflow recovery is limited per user turn, so a
    /// newly accepted user message resets the compact-and-retry allowance.
    pub fn on_user_message(&mut self) {
        self.overflow_recovery_attempted = false;
    }

    /// Call when an assistant response other than an error completes. This
    /// mirrors pi's `message_end` lifecycle: stop, length, tool-use, and aborted
    /// responses all clear the previous compact-and-retry attempt immediately.
    pub fn on_non_error_response(&mut self) {
        self.overflow_recovery_attempted = false;
    }

    /// Evaluate compaction using one model context for both remote and local
    /// summary stages.
    pub async fn after_response(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        usage: &UsageSnapshot,
        current_model: &ModelId,
        summarizer_ctx: Option<&SummarizerContext>,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        self.after_response_with_contexts(
            messages,
            usage,
            current_model,
            SummaryContexts::same(summarizer_ctx),
            cancel,
        )
        .await
    }

    /// Evaluate whether compaction should run after an assistant response.
    /// Remote and local LLM stages may use different model contexts.
    pub async fn after_response_with_contexts(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        usage: &UsageSnapshot,
        current_model: &ModelId,
        contexts: SummaryContexts<'_>,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        let trigger_input = TriggerInput {
            usage: Some(usage.clone()),
            current_model: current_model.clone(),
            last_compaction_ts: self.last_compaction_ts,
            overflow_recovery_attempted: self.overflow_recovery_attempted,
        };
        self.clear_suppression_if_recovered(usage, current_model);

        match trigger::evaluate(&trigger_input, &self.config) {
            TriggerDecision::Skip => {
                // Below the summary threshold. The prune branch has its own,
                // lower line; usage from another model says nothing about
                // this context and is not a size.
                if usage.model == *current_model {
                    let context_tokens = trigger::calculate_context_tokens(usage);
                    return self.prune_mid_run(messages, context_tokens, cancel).await;
                }
                CompactionResponse::skip()
            }

            TriggerDecision::Overflow {
                context_tokens,
                will_retry,
            } => {
                if will_retry
                    && matches!(
                        messages.last(),
                        Some(AgentMessage::Llm(crate::types::Message::Assistant { .. }))
                    )
                {
                    messages.pop();
                }

                // A provider overflow overrides the configured window and
                // local estimate. Do not accept a prune-only pass merely
                // because it falls below the ordinary summary threshold:
                // that would spend the recovery allowance on a request the
                // provider may still reject. Summarize before retrying.
                // Cancellation or no plan leaves the turn terminal instead
                // of resending the same oversized context.
                let request_overhead_tokens = contexts.request_overhead_tokens();
                let mut stats = self
                    .summarize_compaction(
                        messages,
                        contexts,
                        request_overhead_tokens,
                        LlmPolicy::Required,
                        0,
                        cancel.clone(),
                    )
                    .await;
                if will_retry && stats.is_none() && !cancel.is_cancelled() {
                    // Recovery must not depend on a second model call: the
                    // summarize request goes to the same provider that just
                    // rejected the oversized payload and can fail for the
                    // same reason (e.g. a relay byte limit). First retry the
                    // same pi-style plan with a deterministic summary.
                    stats = self
                        .summarize_compaction(
                            messages,
                            SummaryContexts::default(),
                            request_overhead_tokens,
                            LlmPolicy::Skip,
                            0,
                            cancel.clone(),
                        )
                        .await;
                }
                if will_retry
                    && stats.is_none()
                    && !cancel.is_cancelled()
                    && matches!(
                        messages.last(),
                        Some(AgentMessage::Llm(crate::types::Message::ToolResult { .. }))
                    )
                {
                    // Pi's ordinary planner never cuts at a tool result. If a
                    // single active tool turn fills the request, that leaves no
                    // valid retained suffix and the normal plan is a no-op.
                    // The provider has already rejected this exact payload, so
                    // summarize the complete tool turn rather than resending it.
                    let minimum_first_kept = messages.len();
                    stats = self
                        .summarize_compaction(
                            messages,
                            SummaryContexts::default(),
                            request_overhead_tokens,
                            LlmPolicy::Skip,
                            minimum_first_kept,
                            cancel.clone(),
                        )
                        .await;
                }
                let retry_after_compaction = will_retry && stats.is_some();
                if retry_after_compaction {
                    self.overflow_recovery_attempted = true;
                }

                CompactionResponse {
                    action: if retry_after_compaction {
                        AfterResponseAction::Retry
                    } else {
                        AfterResponseAction::Continue
                    },
                    stats,
                    reason: Some(CompactReason::Overflow),
                    context_tokens: Some(context_tokens),
                    overflow_exhausted: false,
                    overflow_recovery_failed: will_retry
                        && !retry_after_compaction
                        && !cancel.is_cancelled(),
                    pruned: None,
                }
            }

            TriggerDecision::OverflowExhausted { context_tokens } => {
                // A compact-and-retry was already attempted this turn and the
                // context still overflows. Do not retry again — signal the loop
                // to surface a user-visible message.
                CompactionResponse {
                    action: AfterResponseAction::Continue,
                    stats: None,
                    reason: Some(CompactReason::Overflow),
                    context_tokens: Some(context_tokens),
                    overflow_exhausted: true,
                    overflow_recovery_failed: false,
                    pruned: None,
                }
            }

            TriggerDecision::Refusal { context_tokens } => {
                self.recover_from_refusal(messages, context_tokens, contexts, cancel)
                    .await
            }

            TriggerDecision::RefusalExhausted { context_tokens } => CompactionResponse {
                action: AfterResponseAction::Continue,
                stats: None,
                reason: Some(CompactReason::Refusal),
                context_tokens: Some(context_tokens),
                overflow_exhausted: true,
                overflow_recovery_failed: false,
                pruned: None,
            },

            TriggerDecision::Threshold { context_tokens } => {
                // With a judge, `run_compaction` prunes first and only
                // summarises if the lossless cut is not enough: the prefix is
                // rebuilt either way, so the prune costs nothing extra here.
                self.threshold_compact(messages, context_tokens, current_model, contexts, cancel)
                    .await
            }
        }
    }

    /// Estimate-driven threshold check using one model for all summary stages.
    pub async fn compact_on_estimate(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        estimated_tokens: usize,
        current_model: &ModelId,
        summarizer_ctx: Option<&SummarizerContext>,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        self.compact_on_estimate_with_contexts(
            messages,
            estimated_tokens,
            current_model,
            SummaryContexts::same(summarizer_ctx),
            cancel,
        )
        .await
    }

    /// Estimate-driven threshold check with independent summary contexts.
    pub async fn compact_on_estimate_with_contexts(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        estimated_tokens: usize,
        current_model: &ModelId,
        contexts: SummaryContexts<'_>,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        if self.config.context_window == 0 {
            return CompactionResponse::skip();
        }
        if estimated_tokens < self.config.trigger_threshold() {
            self.clear_suppression_for(current_model);
            return self.prune_mid_run(messages, estimated_tokens, cancel).await;
        }
        self.threshold_compact(messages, estimated_tokens, current_model, contexts, cancel)
            .await
    }

    /// The prune branch between responses: nothing below its threshold or
    /// without a judge; otherwise one `prune_step`, reported on the response
    /// so the runner can emit it.
    async fn prune_mid_run(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        context_tokens: usize,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        if self.judge.is_none()
            || self.config.context_window == 0
            || context_tokens < self.config.prune_trigger_threshold()
        {
            return CompactionResponse::skip();
        }
        let outcome = self
            .prune_step(
                messages,
                context_tokens,
                ApplyTrigger::Threshold,
                crate::context::now_ms(),
                cancel,
            )
            .await;
        let mut response = CompactionResponse::skip();
        if outcome.decided.is_some() || outcome.applied.is_some() {
            response.pruned = Some(outcome);
        }
        response
    }

    /// Force a compaction (e.g., manual trigger from user command).
    pub async fn force_compact(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        summarizer_ctx: Option<&SummarizerContext>,
        cancel: CancellationToken,
    ) -> Option<CompactionStats> {
        let contexts = SummaryContexts::same(summarizer_ctx);
        let request_overhead_tokens = contexts.request_overhead_tokens();
        self.run_compaction(
            messages,
            contexts,
            request_overhead_tokens,
            LlmPolicy::Required,
            0,
            cancel,
        )
        .await
    }

    /// Safety-refusal recovery: compact so the retry no longer resends the
    /// content the provider refused, then retry once.
    ///
    /// The judge prune is skipped: it keeps what is still relevant, and the
    /// refused content is usually the most recent (relevant) tool output, so a
    /// prune-only pass would resend it and be refused again. The summary uses
    /// the manual `/compact` policy: LLM first, deterministic fallback when the
    /// summarizer is refused for the same content.
    async fn recover_from_refusal(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        context_tokens: usize,
        contexts: SummaryContexts<'_>,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        // The refused response is not part of the conversation to retry.
        if matches!(
            messages.last(),
            Some(AgentMessage::Llm(crate::types::Message::Assistant { .. }))
        ) {
            messages.pop();
        }

        let request_overhead_tokens = contexts.request_overhead_tokens();
        let mut stats = self
            .summarize_compaction(
                messages,
                contexts,
                request_overhead_tokens,
                LlmPolicy::PreferLlm,
                0,
                cancel.clone(),
            )
            .await;
        if stats.is_none()
            && !cancel.is_cancelled()
            && matches!(
                messages.last(),
                Some(AgentMessage::Llm(crate::types::Message::ToolResult { .. }))
            )
        {
            // The retained tail covers the whole context, typically one active
            // tool turn whose output was refused. Summarize the complete turn
            // deterministically so the refused output leaves the request.
            let minimum_first_kept = messages.len();
            stats = self
                .summarize_compaction(
                    messages,
                    SummaryContexts::default(),
                    request_overhead_tokens,
                    LlmPolicy::Skip,
                    minimum_first_kept,
                    cancel.clone(),
                )
                .await;
        }

        let retry = stats.is_some();
        if retry {
            self.overflow_recovery_attempted = true;
        }
        CompactionResponse {
            action: if retry {
                AfterResponseAction::Retry
            } else {
                AfterResponseAction::Continue
            },
            stats,
            reason: Some(CompactReason::Refusal),
            context_tokens: Some(context_tokens),
            overflow_exhausted: false,
            overflow_recovery_failed: !retry && !cancel.is_cancelled(),
            pruned: None,
        }
    }

    /// Shared threshold path: honor suppression, compact, then arm suppression
    /// so a compaction that could not lower usage does not repeat every turn.
    async fn threshold_compact(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        context_tokens: usize,
        current_model: &ModelId,
        contexts: SummaryContexts<'_>,
        cancel: CancellationToken,
    ) -> CompactionResponse {
        let key = ThresholdKey {
            model: current_model.clone(),
            threshold: self.config.trigger_threshold(),
        };
        if self.threshold_suppression.as_ref() == Some(&key) {
            tracing::debug!(
                context_tokens,
                threshold = key.threshold,
                "threshold compaction suppressed: previous compaction did not lower usage"
            );
            return CompactionResponse::skip();
        }

        let request_overhead_tokens = contexts.request_overhead_tokens();
        let stats = self
            .run_compaction(
                messages,
                contexts,
                request_overhead_tokens,
                LlmPolicy::Required,
                0,
                cancel,
            )
            .await;
        if stats.is_some() {
            self.threshold_suppression = Some(key);
        }
        CompactionResponse {
            action: AfterResponseAction::Continue,
            stats,
            reason: Some(CompactReason::Threshold),
            context_tokens: Some(context_tokens),
            overflow_exhausted: false,
            overflow_recovery_failed: false,
            pruned: None,
        }
    }

    /// Post-compaction usage back under the threshold re-arms threshold
    /// compaction. Stale usage (predating the last compaction) is ignored.
    fn clear_suppression_if_recovered(&mut self, usage: &UsageSnapshot, current_model: &ModelId) {
        if self.config.context_window == 0 || usage.model != *current_model {
            return;
        }
        if let Some(last_ts) = self.last_compaction_ts {
            if usage.timestamp > 0 && last_ts > 0 && usage.timestamp <= last_ts {
                return;
            }
        }
        if trigger::context_tokens(usage) <= self.config.trigger_threshold() {
            self.clear_suppression_for(current_model);
        }
    }

    fn clear_suppression_for(&mut self, current_model: &ModelId) {
        if self
            .threshold_suppression
            .as_ref()
            .is_some_and(|key| key.model == *current_model)
        {
            self.threshold_suppression = None;
        }
    }

    async fn run_compaction(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        contexts: SummaryContexts<'_>,
        request_overhead_tokens: usize,
        llm_policy: LlmPolicy,
        minimum_first_kept: usize,
        cancel: CancellationToken,
    ) -> Option<CompactionStats> {
        if let Some(stats) = self
            .prune_before_summary(messages, request_overhead_tokens, cancel.clone())
            .await
        {
            return Some(stats);
        }
        self.summarize_compaction(
            messages,
            contexts,
            request_overhead_tokens,
            llm_policy,
            minimum_first_kept,
            cancel,
        )
        .await
    }

    /// Plan and summarize without the judge prune step.
    async fn summarize_compaction(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        contexts: SummaryContexts<'_>,
        request_overhead_tokens: usize,
        llm_policy: LlmPolicy,
        minimum_first_kept: usize,
        cancel: CancellationToken,
    ) -> Option<CompactionStats> {
        // A resumed context already contains the previous summary as a user
        // message. Remove only the exact message recorded in state so the
        // summarizer receives it once via `previous_summary`, not again as
        // ordinary conversation text.
        let removed_summary = self
            .state
            .context_summary_message
            .as_deref()
            .and_then(|summary| {
                messages
                    .iter()
                    .position(|message| is_exact_user_text(message, summary))
            })
            .map(|index| (index, messages.remove(index)));

        let retained_tail = self.config.retained_tail_budget(request_overhead_tokens);
        let Some(plan) =
            plan::plan_messages_from_boundary(messages, retained_tail, minimum_first_kept)
        else {
            restore_removed_summary(messages, removed_summary);
            return None;
        };
        notify_compaction_phase(&self.observer, CompactionPhase::Planning);

        let result = executor::execute_with_contexts(
            std::mem::take(messages),
            &plan,
            &self.config,
            Some(&self.state),
            contexts,
            executor::ExecutionOptions {
                llm_policy,
                observer: self.observer.clone(),
                cancel: cancel.clone(),
            },
        )
        .await;

        match result {
            ExecutionResult::Skipped(returned) => {
                *messages = returned;
                restore_removed_summary(messages, removed_summary);
                if !cancel.is_cancelled() {
                    notify_compaction_phase(&self.observer, CompactionPhase::Complete);
                }
                None
            }
            ExecutionResult::Compacted(outcome) => {
                *messages = outcome.messages;
                self.state = outcome.state;
                self.last_compaction_ts = Some(self.state.timestamp);
                notify_compaction_phase(&self.observer, CompactionPhase::Complete);
                Some(outcome.stats)
            }
        }
    }
}

impl CompactionController {
    /// The lossless step every compaction starts with when a judge is set.
    /// The summary is about to rebuild the cache prefix anyway, so the prune
    /// is free now: ask the judge about everything still undecided (a resumed
    /// session has never been asked), apply, and if the cut alone brings the
    /// context back under the threshold, report that and skip the summary.
    async fn prune_before_summary(
        &mut self,
        messages: &mut Vec<AgentMessage>,
        request_overhead_tokens: usize,
        cancel: CancellationToken,
    ) -> Option<CompactionStats> {
        let judge = self.judge.clone()?;
        let ledger = self.ledger.clone();
        let mut ledger = ledger.lock().await;
        notify_compaction_phase(&self.observer, CompactionPhase::Pruning);
        let before_tokens = total_tokens(messages);
        let before_messages = messages.len();
        if let Err(error) = ledger
            .decide(messages, judge.as_ref(), &self.prune_options, cancel)
            .await
        {
            tracing::warn!(error = %error, "judge prune before compaction: decide failed");
        }
        if ledger.pending_count() == 0 {
            return None;
        }
        let now = crate::context::now_ms();
        let report = self.apply_with(&mut ledger, messages, ApplyTrigger::BeforeCompaction, now);
        drop(ledger);
        if report.removed + report.truncated == 0 {
            return None;
        }
        let after_tokens = total_tokens(messages);
        let fits =
            after_tokens.saturating_add(request_overhead_tokens) <= self.config.trigger_threshold();
        if !fits {
            return None;
        }
        notify_compaction_phase(&self.observer, CompactionPhase::Complete);
        Some(CompactionStats {
            summary: None,
            before_message_count: before_messages,
            after_message_count: messages.len(),
            before_tokens,
            after_tokens,
            messages_evicted: before_messages.saturating_sub(messages.len()),
            current_run_reclaimed: 0,
            method: Some(CompactionMethod::Prune),
            fallback_reason: None,
            remote_blob_bytes: None,
        })
    }
}

fn is_exact_user_text(message: &AgentMessage, expected: &str) -> bool {
    let AgentMessage::Llm(crate::types::Message::User { content, .. }) = message else {
        return false;
    };
    matches!(content.as_slice(), [crate::types::Content::Text { text }] if text == expected)
}

fn restore_removed_summary(
    messages: &mut Vec<AgentMessage>,
    removed: Option<(usize, AgentMessage)>,
) {
    if let Some((index, message)) = removed {
        messages.insert(index.min(messages.len()), message);
    }
}

/// Response from the compaction controller to the agent loop.
pub struct CompactionResponse {
    /// What the loop should do next.
    pub action: AfterResponseAction,
    /// Stats if compaction ran, None if skipped or nothing to evict.
    pub stats: Option<CompactionStats>,
    pub reason: Option<CompactReason>,
    pub context_tokens: Option<usize>,
    /// Set when a compact-and-retry was already attempted this turn and the
    /// same failure recurred (overflow, or refusal when `reason` is
    /// `Refusal`). The loop should surface this to the user.
    pub overflow_exhausted: bool,
    /// Set when an overflow or refusal demanded a compact-and-retry but
    /// compaction could not run (nothing to evict). The loop should surface
    /// this to the user instead of failing silently.
    pub overflow_recovery_failed: bool,
    /// What the mid-run prune branch did on this response, if anything.
    pub pruned: Option<PruneOutcome>,
}

impl CompactionResponse {
    fn skip() -> Self {
        Self {
            action: AfterResponseAction::Continue,
            stats: None,
            reason: None,
            context_tokens: None,
            overflow_exhausted: false,
            overflow_recovery_failed: false,
            pruned: None,
        }
    }
}
