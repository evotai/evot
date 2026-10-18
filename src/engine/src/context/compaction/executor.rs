//! Executor — applies a compaction plan to an in-memory message list.
//!
//! Pipeline: reclaim (lossless) → summary chain → assemble. All summary
//! generation lives in [`super::summary`]; this module only rebuilds the
//! message list and cross-compaction state around the result.

use tokio_util::sync::CancellationToken;

use super::config::CompactionConfig;
use super::memory;
use super::plan::CompactionPlan;
use super::remote;
use super::summary;
use super::summary::LlmPolicy;
use super::summary::SummaryContexts;
use super::summary::SummaryOutcome;
use super::summary::SummaryRequest;
use super::transforms;
use super::types::CompactionMethod;
use super::types::CompactionObserver;
use super::types::CompactionOutcome;
use super::types::CompactionState;
use super::types::CompactionStats;
use crate::context::compaction::summarizer::mode::SummarizerContext;
use crate::context::tokens::total_tokens;
use crate::types::AgentMessage;
use crate::types::Content;
use crate::types::Message;

/// Runtime controls for one compaction execution.
pub struct ExecutionOptions {
    pub llm_policy: LlmPolicy,
    pub observer: Option<CompactionObserver>,
    pub cancel: CancellationToken,
}

/// Result of applying a plan.
pub enum ExecutionResult {
    Compacted(Box<CompactionOutcome>),
    /// No compaction happened (cancelled, or the required LLM summary failed).
    /// The messages are returned unchanged so the caller can restore them.
    Skipped(Vec<AgentMessage>),
}

/// Execute using one context for both remote and local LLM stages.
pub async fn execute(
    messages: Vec<AgentMessage>,
    plan: &CompactionPlan,
    config: &CompactionConfig,
    prev_state: Option<&CompactionState>,
    summarizer_ctx: Option<&SummarizerContext>,
    options: ExecutionOptions,
) -> ExecutionResult {
    execute_with_contexts(
        messages,
        plan,
        config,
        prev_state,
        SummaryContexts::same(summarizer_ctx),
        options,
    )
    .await
}

/// Execute with independent remote and local summary contexts.
pub async fn execute_with_contexts(
    messages: Vec<AgentMessage>,
    plan: &CompactionPlan,
    config: &CompactionConfig,
    prev_state: Option<&CompactionState>,
    contexts: SummaryContexts<'_>,
    options: ExecutionOptions,
) -> ExecutionResult {
    if options.cancel.is_cancelled() {
        return ExecutionResult::Skipped(messages);
    }
    let before_message_count = messages.len();
    let before_tokens = total_tokens(&messages);

    // Step 1: reclaim expired tool results (lossless, index-stable).
    let (messages, current_run_reclaimed) = transforms::reclaim::run(messages);

    // Step 2: generate the summary via the shared chain.
    let evicted = &messages[plan.summarize.clone()];
    let turn_prefix = plan
        .turn_prefix
        .as_ref()
        .map(|range| &messages[range.clone()]);
    let outcome = summary::summarize(
        SummaryRequest {
            evicted,
            turn_prefix,
            prev_state,
            custom_instructions: None,
            file_ops: plan.file_ops.clone(),
            override_text: None,
        },
        contexts,
        config,
        summary::SummaryOptions {
            llm_policy: options.llm_policy,
            timeout: None,
            observer: options.observer,
            cancel: options.cancel.clone(),
        },
    )
    .await;
    let result = match outcome {
        SummaryOutcome::Ready(result) => result,
        SummaryOutcome::Aborted | SummaryOutcome::Cancelled => {
            return ExecutionResult::Skipped(messages)
        }
    };
    if options.cancel.is_cancelled() {
        return ExecutionResult::Skipped(messages);
    }

    // Step 3: assemble the summary and retained tail without replay repairs.
    // These messages can be persisted in a compact snapshot. Missing-outcome
    // placeholders and failed-turn filtering belong only to the outgoing view.
    let is_remote = result.remote.is_some();
    let summary_message = replacement_message(&result, contexts.remote);
    let mut rebuilt = Vec::with_capacity(1 + messages.len() - plan.first_kept);
    rebuilt.push(summary_message);
    rebuilt.extend_from_slice(&messages[plan.first_kept..]);

    // Step 4: cross-compaction state. The exact context message is recorded so
    // the next compaction can dedupe it; remote state has no text message.
    let mut state = memory::build_state(evicted, turn_prefix, prev_state);
    state.last_summary = Some(result.text.clone());
    state.context_summary_message = (!is_remote).then(|| result.text.clone());

    let stats = CompactionStats {
        summary: Some(result.text),
        before_message_count,
        after_message_count: rebuilt.len(),
        before_tokens,
        after_tokens: total_tokens(&rebuilt),
        messages_evicted: plan.first_kept,
        current_run_reclaimed,
        method: Some(result.method),
        remote_blob_bytes: result
            .remote
            .as_ref()
            .map(|compaction| compaction.encrypted_bytes),
        fallback_reason: result.fallback_reason,
    };

    ExecutionResult::Compacted(Box::new(CompactionOutcome {
        messages: rebuilt,
        state,
        stats,
    }))
}

/// The message that replaces the evicted zone: an opaque provider-native item
/// when remote compaction ran, otherwise a plain user summary message.
fn replacement_message(
    result: &summary::SummaryResult,
    summarizer_ctx: Option<&SummarizerContext>,
) -> AgentMessage {
    if let (Some(remote_compaction), Some(ctx)) = (result.remote.clone(), summarizer_ctx) {
        if result.method == CompactionMethod::Remote {
            return remote::replacement_message(ctx, remote_compaction, result.text.clone());
        }
    }
    AgentMessage::Llm(Message::User {
        provenance: None,
        content: vec![Content::Text {
            text: result.text.clone(),
        }],
        timestamp: crate::context::now_ms(),
    })
}
