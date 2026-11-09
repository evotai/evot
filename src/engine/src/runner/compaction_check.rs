//! Context compaction integration with the agent loop.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::config::AgentLoopConfig;
use super::event_sink::EventSink;
use crate::context::compaction::Checkpoint;
use crate::context::tokens::total_tokens;
use crate::context::window::usage_is_plausible;
use crate::context::AfterResponseAction;
use crate::context::CompactionController;
use crate::context::CompactionResponse;
use crate::context::ContextTracker;
use crate::context::ModelId;
use crate::context::SummarizerContext;
use crate::context::SummaryContexts;
use crate::context::UsageSnapshot;
use crate::types::*;

/// User-visible message emitted when overflow recovery is exhausted.
const OVERFLOW_EXHAUSTED_MESSAGE: &str =
    "Context overflow recovery failed after one compact-and-retry attempt. \
     Try reducing context or switching to a larger-context model.";

/// User-visible message emitted when overflow recovery could not compact.
const OVERFLOW_RECOVERY_FAILED_MESSAGE: &str =
    "Context overflow recovery failed: could not compact the context. \
     Try reducing context or switching to a larger-context model.";

/// User-visible message emitted when the provider refuses again after the
/// context was already compacted and retried once.
const REFUSAL_EXHAUSTED_MESSAGE: &str =
    "The provider refused the request again after compacting the context and retrying. \
     Rephrase the request or remove the content that triggers the safety filter.";

/// User-visible message emitted when refusal recovery could not compact.
const REFUSAL_RECOVERY_FAILED_MESSAGE: &str =
    "Refusal recovery failed: could not compact the context. \
     Rephrase the request or remove the content that triggers the safety filter.";

pub(super) struct CompactionRequestShape<'a> {
    pub(super) system_prompt: &'a str,
    pub(super) tools: &'a [crate::provider::ToolDefinition],
    pub(super) prompt_cache_key: Option<&'a str>,
}

impl CompactionRequestShape<'_> {
    fn summarizer_context(&self, config: &AgentLoopConfig) -> SummarizerContext {
        SummarizerContext {
            provider: Arc::clone(&config.provider),
            model: config.model.clone(),
            api_key: config.api_key.clone(),
            thinking_level: config.thinking_level,
            system_prompt: self.system_prompt.to_string(),
            tools: self.tools.to_vec(),
            max_tokens: config.max_tokens,
            cache_config: config.cache_config.clone(),
            prompt_cache_key: self.prompt_cache_key.map(str::to_string),
            model_config: config.model_config.clone(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionCheckPhase {
    BeforePrompt,
    /// Between tool turns of one run, once the local estimate or the latest
    /// real usage says the active context has reached the summary threshold.
    /// Without this a tool-heavy run only compacts when the provider rejects
    /// the request, which a large-window model or a lenient gateway may never
    /// do.
    ToolTurn,
    RunEnd,
}

pub(super) struct CompactionCheckInput<'a> {
    pub(super) assistant_message: &'a Message,
    pub(super) config: &'a AgentLoopConfig,
    pub(super) request_shape: CompactionRequestShape<'a>,
    pub(super) phase: CompactionCheckPhase,
}

/// Apply pi's single response-driven compaction policy.
///
/// Run-end checks ignore aborted responses. Before a new explicit prompt, the
/// same response is checked again with aborted usage included. Tool turns
/// invoke it only through [`tool_turn_needs_compaction_check`]; steering,
/// retry, and follow-up turns never do.
pub(super) async fn check_compaction(
    controller: &mut Option<CompactionController>,
    tracker: &mut ContextTracker,
    messages: &mut Vec<AgentMessage>,
    input: CompactionCheckInput<'_>,
    cancel: CancellationToken,
    tx: &EventSink,
) -> bool {
    let CompactionCheckInput {
        assistant_message,
        config,
        request_shape,
        phase,
    } = input;
    if phase == CompactionCheckPhase::RunEnd
        && matches!(assistant_message, Message::Assistant {
            stop_reason: StopReason::Aborted,
            ..
        })
    {
        return false;
    }

    let ctrl = match controller.as_mut() {
        Some(ctrl) => ctrl,
        None => return false,
    };
    let mut usage = match usage_snapshot_from_message(assistant_message) {
        Some(usage) => usage,
        None => return false,
    };
    // The pre-prompt check runs before the turn loop records this request's
    // overhead; refresh it so the plausibility bound sees the same request.
    tracker.record_request_overhead(request_shape.system_prompt, request_shape.tools);

    // A provider count that cannot describe the request it answered (e.g. a
    // gateway summing a whole run's prompt tokens into the final response) must
    // not be read as a silent overflow or a threshold hit. Drop the numbers and
    // let the estimate fallback below decide from the last trustworthy anchor.
    // Explicit overflow errors keep their dedicated compact-and-retry path.
    let local_estimate =
        total_tokens(messages).saturating_add(tracker.system_tool_overhead_tokens());
    let reported = crate::context::compaction::trigger::context_tokens(&usage);
    let usage_rejected =
        usage.stop_reason != StopReason::Error && !usage_is_plausible(reported, local_estimate);
    if usage_rejected {
        tracing::warn!(
            reported_tokens = reported,
            local_estimate,
            model = %usage.model.model,
            provider = %usage.model.provider,
            "provider usage cannot describe this request; ignoring it for compaction"
        );
        usage.input = 0;
        usage.cache_read = 0;
        usage.cache_write = 0;
        usage.output = 0;
        usage.total_tokens = 0;
    }
    let current_model = ModelId {
        provider: target_provider(config)
            .unwrap_or(&usage.model.provider)
            .to_string(),
        model: config.model.clone(),
    };
    // A dedicated summary model (e.g. the model that produced this history
    // before a switch) is tried first; when it is unavailable the active model
    // takes over unless an explicit fallback was configured.
    let checkpoint = match phase {
        CompactionCheckPhase::RunEnd => Checkpoint::RunEnd,
        CompactionCheckPhase::BeforePrompt | CompactionCheckPhase::ToolTurn => Checkpoint::MidRun,
    };
    let remote_ctx = request_shape.summarizer_context(config);
    let llm_ctx = config.compaction_context.as_ref().unwrap_or(&remote_ctx);
    let fallback_ctx = config
        .compaction_fallback_context
        .as_ref()
        .or(config.compaction_context.as_ref().map(|_| &remote_ctx));
    let contexts = SummaryContexts::separate(Some(&remote_ctx), Some(llm_ctx), fallback_ctx);
    let response = ctrl
        .after_response_with_contexts(
            messages,
            &usage,
            &current_model,
            contexts,
            checkpoint,
            cancel.clone(),
        )
        .await;

    // Error/all-zero responses do not provide a direct context size. Mirror
    // pi's `estimateContextTokens`: anchor on the selected model's latest real
    // usage plus trailing messages when one exists; otherwise the full local
    // estimate of the current history is the only size we have and still
    // guards the window. Some gateways never report usage on tool_use
    // responses (kimi-k3 via evot-pro), so a long tool-heavy run would
    // otherwise grow past the model's limit with no compaction at all. The
    // byte heuristic overcounts, which errs toward compacting early — the
    // safe side of the window. A foreign model's usage is never the anchor,
    // so a model switch cannot compact against the old model's boundary.
    // Any response the trigger already classified (overflow, exhausted, failed
    // recovery) must not re-enter through the estimate fallback.
    //
    // A tool turn always takes the anchor path when usage alone did not act:
    // the response's usage predates the tool results just appended, and the
    // anchor adds those trailing messages, so the summary happens before the
    // oversized request is sent instead of one turn later.
    let anchor_estimate = if response.action == AfterResponseAction::Continue
        && response.stats.is_none()
        && response.reason.is_none()
        && (usage_rejected
            || phase == CompactionCheckPhase::ToolTurn
            || needs_usage_anchor_estimate(assistant_message))
    {
        Some(
            tracker
                .estimate_context_tokens_from_anchor_for_model(
                    messages,
                    Some(&current_model.provider),
                    Some(&current_model.model),
                )
                .unwrap_or(local_estimate),
        )
    } else {
        None
    };
    let response = if let Some(estimated_tokens) = anchor_estimate {
        ctrl.compact_on_estimate_with_contexts(
            messages,
            estimated_tokens,
            &current_model,
            contexts,
            checkpoint,
            cancel,
        )
        .await
    } else {
        response
    };

    let should_retry = response.action == AfterResponseAction::Retry;
    emit_compaction_events(ctrl, tracker, messages, &response, tx).await;
    should_retry
}

/// Emit compaction lifecycle events and the overflow-exhausted notice.
///
/// Shared by post-response and pre-prompt compaction so both surface the same
/// observability events and persist via the app layer's compact orchestrator.
async fn emit_compaction_events(
    ctrl: &CompactionController,
    tracker: &mut ContextTracker,
    messages: &[AgentMessage],
    response: &CompactionResponse,
    tx: &EventSink,
) {
    if let Some(ref stats) = response.stats {
        let reason = response
            .reason
            .unwrap_or(crate::context::CompactReason::Threshold);
        let will_retry = response.action == AfterResponseAction::Retry;
        tx.send(AgentEvent::ContextCompactionStarted {
            reason,
            estimated_tokens: response.context_tokens.unwrap_or(stats.before_tokens),
            context_window: ctrl.config().displayed_window(),
            reserve_tokens: ctrl.config().reserve_tokens,
            trigger_threshold: ctrl.config().trigger_threshold(),
            will_retry,
        })
        .await
        .ok();
        tx.send(AgentEvent::ContextCompactionEnd {
            reason,
            stats: stats.clone(),
            messages: messages.to_vec(),
            state: ctrl.state().clone(),
            summary: stats.summary.clone(),
            context_window: ctrl.config().displayed_window(),
            will_retry,
        })
        .await
        .ok();
        tracker.record_compaction_done(ctrl.state().timestamp);
    }

    let refusal = response.reason == Some(crate::context::CompactReason::Refusal);
    if response.overflow_exhausted {
        let message = if refusal {
            REFUSAL_EXHAUSTED_MESSAGE
        } else {
            OVERFLOW_EXHAUSTED_MESSAGE
        };
        tx.send(AgentEvent::Error {
            error: AgentErrorInfo {
                kind: AgentErrorKind::Runtime,
                message: message.to_string(),
            },
        })
        .await
        .ok();
    }

    if response.overflow_recovery_failed {
        let message = if refusal {
            REFUSAL_RECOVERY_FAILED_MESSAGE
        } else {
            OVERFLOW_RECOVERY_FAILED_MESSAGE
        };
        tx.send(AgentEvent::Error {
            error: AgentErrorInfo {
                kind: AgentErrorKind::Runtime,
                message: message.to_string(),
            },
        })
        .await
        .ok();
    }
}

/// Whether a tool turn should run the compaction check before the next
/// provider call: the active context plus request overhead has reached the
/// mid-run summary threshold, by either measure. The byte heuristic can
/// undercount (CJK text, dense code), so the active model's latest real usage
/// plus the messages appended after it also opens the check; the
/// usage-driven check then decides. Below the line the turn continues without
/// touching the controller.
pub(super) fn tool_turn_needs_compaction_check(
    controller: &Option<CompactionController>,
    tracker: &ContextTracker,
    messages: &[AgentMessage],
    loop_config: &AgentLoopConfig,
    assistant_message: &Message,
) -> bool {
    let Some(ctrl) = controller.as_ref() else {
        return false;
    };
    let config = ctrl.config();
    if config.context_window == 0 {
        return false;
    }
    let threshold = config.trigger_threshold();
    let local_estimate =
        total_tokens(messages).saturating_add(tracker.system_tool_overhead_tokens());
    if local_estimate >= threshold {
        return true;
    }
    let response_provider = match assistant_message {
        Message::Assistant { provider, .. } => provider.as_str(),
        _ => "",
    };
    let provider = target_provider(loop_config).unwrap_or(response_provider);
    tracker
        .estimate_context_tokens_from_anchor_for_model(
            messages,
            Some(provider),
            Some(&loop_config.model),
        )
        .is_some_and(|anchored| anchored >= threshold)
}

/// A tool turn below the threshold still shows the controller its usage: a
/// compaction suppresses further threshold compactions until usage is seen
/// back under the line, and without this the next time the context grows to
/// the threshold the check would be refused as "did not lower usage".
pub(super) fn note_tool_turn_usage(
    controller: &mut Option<CompactionController>,
    config: &AgentLoopConfig,
    assistant_message: &Message,
) {
    let Some(ctrl) = controller.as_mut() else {
        return;
    };
    let Some(usage) = usage_snapshot_from_message(assistant_message) else {
        return;
    };
    let current_model = ModelId {
        provider: target_provider(config)
            .unwrap_or(&usage.model.provider)
            .to_string(),
        model: config.model.clone(),
    };
    ctrl.clear_suppression_if_recovered(&usage, &current_model);
}

fn target_provider(config: &AgentLoopConfig) -> Option<&str> {
    config.model_config.as_ref().map(|model| model.provider())
}

/// Whether pi would estimate this response from the latest real usage anchor.
/// Overflow errors stay on the dedicated compact-and-retry path.
fn needs_usage_anchor_estimate(message: &Message) -> bool {
    matches!(
        message,
        Message::Assistant {
            stop_reason: StopReason::Error,
            error_message,
            ..
        } if !error_message
            .as_deref()
            .is_some_and(crate::provider::error::is_context_overflow_message)
    ) || matches!(
        message,
        Message::Assistant { usage, .. } if usage.context_tokens() == 0
    )
}

fn usage_snapshot_from_message(message: &Message) -> Option<UsageSnapshot> {
    if let Message::Assistant {
        usage,
        stop_reason,
        model,
        provider,
        timestamp,
        error_message,
        ..
    } = message
    {
        Some(UsageSnapshot {
            input: usage.input as usize,
            cache_read: usage.cache_read as usize,
            cache_write: usage.cache_write as usize,
            output: usage.output as usize,
            total_tokens: usage.total_tokens as usize,
            model: ModelId {
                provider: provider.clone(),
                model: model.clone(),
            },
            timestamp: *timestamp,
            stop_reason: stop_reason.clone(),
            error_message: error_message.clone(),
        })
    } else {
        None
    }
}
