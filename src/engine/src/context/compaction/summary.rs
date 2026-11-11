//! Summary chain — the single HOW of compaction, shared by the automatic
//! agent-loop path and the manual `/compact` orchestrator:
//!
//! ```text
//! override text → LLM text summary → emergency
//! ```
//!
//! Each stage that fails records why and falls through to the next; user
//! cancellation aborts the chain without producing a summary.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::config::truncate_summary;
use super::config::CompactionConfig;
use super::emergency;
use super::summarizer::mode::SummarizerContext;
use super::summarizer::serialize;
use super::summarizer::types::SummarizerError;
use super::summarizer::types::SummarizerInput;
use super::types::notify_compaction_phase;
use super::types::CompactionObserver;
use super::types::CompactionPhase;
use super::types::CompactionState;
use super::types::FileOps;
use crate::types::AgentMessage;

/// Provider contexts used by the summary chain.
///
/// `active` describes the request shape retained history is replayed to. LLM
/// summarization may use a dedicated compaction model, with an optional
/// fallback model.
#[derive(Clone, Copy, Default)]
pub struct SummaryContexts<'a> {
    pub active: Option<&'a SummarizerContext>,
    pub llm: Option<&'a SummarizerContext>,
    pub llm_fallback: Option<&'a SummarizerContext>,
}

impl<'a> SummaryContexts<'a> {
    pub fn same(ctx: Option<&'a SummarizerContext>) -> Self {
        Self {
            active: ctx,
            llm: ctx,
            llm_fallback: None,
        }
    }

    pub fn separate(
        active: Option<&'a SummarizerContext>,
        llm: Option<&'a SummarizerContext>,
        llm_fallback: Option<&'a SummarizerContext>,
    ) -> Self {
        Self {
            active,
            llm,
            llm_fallback,
        }
    }

    /// Tokens occupied by the active request shape. Dedicated summary models
    /// are intentionally ignored because retained history is replayed to the
    /// active model.
    pub fn request_overhead_tokens(&self) -> usize {
        let Some(ctx) = self.active else {
            return 0;
        };
        let system = crate::context::estimate_tokens(&ctx.system_prompt);
        let tools = serde_json::to_string(&ctx.tools)
            .map(|json| crate::context::estimate_tokens(&json))
            .unwrap_or_else(|_| {
                ctx.tools
                    .iter()
                    .map(|tool| {
                        crate::context::estimate_tokens(&tool.name)
                            + crate::context::estimate_tokens(&tool.description)
                            + crate::context::estimate_tokens(&tool.parameters.to_string())
                    })
                    .sum()
            });
        system.saturating_add(tools)
    }
}

/// How the chain treats the LLM stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmPolicy {
    /// Use the LLM when a context is available; an attempted LLM failure aborts
    /// compaction. Without a context, use the deterministic summary.
    Required,
    /// Use the LLM; if it fails or times out, use the deterministic emergency
    /// summary instead (manual `/compact` path).
    PreferLlm,
    /// Skip the LLM entirely — overflow recovery must not issue a second
    /// request to the provider that just rejected the oversized payload.
    Skip,
}

/// What to summarize. Slices reference the caller's (post-reclaim) messages.
pub struct SummaryRequest<'a> {
    /// Summarize zone (excludes the split-turn prefix).
    pub evicted: &'a [AgentMessage],
    /// Split-turn prefix, summarized separately.
    pub turn_prefix: Option<&'a [AgentMessage]>,
    /// Cross-compaction state: previous summary, cumulative file ops.
    pub prev_state: Option<&'a CompactionState>,
    /// Optional user guidance for the summary.
    pub custom_instructions: Option<&'a str>,
    /// Planner-extracted file ops, merged into the serialized input.
    pub file_ops: FileOps,
    /// Pre-supplied summary text: skips the LLM stage entirely.
    pub override_text: Option<String>,
}

/// Runtime controls for one chain run.
pub struct SummaryOptions {
    pub llm_policy: LlmPolicy,
    /// Wall-clock bound for the LLM stage. `None` = unbounded.
    pub timeout: Option<Duration>,
    pub observer: Option<CompactionObserver>,
    pub cancel: CancellationToken,
}

/// Result of the chain.
pub enum SummaryOutcome {
    Ready(SummaryResult),
    /// LLM failed under `LlmPolicy::Required` — compaction must not proceed.
    Aborted,
    /// User cancelled — compaction must not proceed and must not fall back.
    Cancelled,
}

pub struct SummaryResult {
    /// Bounded readable summary.
    pub text: String,
    /// True when the deterministic summary replaced a requested LLM summary.
    pub used_fallback: bool,
}

/// Run the chain and produce a summary for the evicted zone.
pub async fn summarize(
    request: SummaryRequest<'_>,
    contexts: SummaryContexts<'_>,
    config: &CompactionConfig,
    options: SummaryOptions,
) -> SummaryOutcome {
    let input = prepare_input(&request, config, serialize::SerializationOptions::default());

    notify_compaction_phase(&options.observer, CompactionPhase::Local);

    // Stage 0: explicit override — keeps the split-turn context.
    if let Some(text) = request.override_text {
        return SummaryOutcome::Ready(SummaryResult {
            text: finalize(
                with_turn_context(text, input.turn_prefix.as_deref()),
                config,
            ),
            used_fallback: false,
        });
    }

    // Stage 1: LLM text summary.
    let mut used_fallback = false;
    if options.llm_policy != LlmPolicy::Skip {
        if let Some(ctx) = contexts.llm {
            match run_llm_with_degradation(
                &request,
                input.clone(),
                ctx,
                contexts.llm_fallback,
                config,
                &options,
            )
            .await
            {
                LlmStage::Ready(text) => {
                    return SummaryOutcome::Ready(SummaryResult {
                        text: finalize(text, config),
                        used_fallback: false,
                    });
                }
                LlmStage::Cancelled => return SummaryOutcome::Cancelled,
                LlmStage::Failed(_) => match options.llm_policy {
                    LlmPolicy::Required => return SummaryOutcome::Aborted,
                    LlmPolicy::PreferLlm => used_fallback = true,
                    LlmPolicy::Skip => {}
                },
            }
        } else {
            used_fallback = true;
        }
    }

    // Stage 2: deterministic emergency summary — never issues a model request.
    if options.cancel.is_cancelled() {
        return SummaryOutcome::Cancelled;
    }
    SummaryOutcome::Ready(SummaryResult {
        text: finalize(emergency::summarize(&input).summary, config),
        used_fallback,
    })
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

enum LlmStage {
    Ready(String),
    Failed(String),
    Cancelled,
}

/// Primary model first; any failure hands the same input to the fallback
/// model (typically the active model after a switch, when the previous one is
/// gone). A context overflow on the last model tried gets one more attempt
/// with the tool transcript abbreviated.
async fn run_llm_with_degradation(
    request: &SummaryRequest<'_>,
    input: SummarizerInput,
    primary: &SummarizerContext,
    fallback: Option<&SummarizerContext>,
    config: &CompactionConfig,
    options: &SummaryOptions,
) -> LlmStage {
    let mut ctx = primary;
    let mut reason = match run_llm_stage(input.clone(), ctx, config, options).await {
        LlmStage::Failed(reason) => reason,
        done => return done,
    };
    if let Some(fallback) = fallback.filter(|fallback| fallback.model != primary.model) {
        tracing::warn!(
            model = %primary.model,
            fallback_model = %fallback.model,
            error = %reason,
            "compaction summary failed on primary model; trying fallback model"
        );
        ctx = fallback;
        reason = match run_llm_stage(input, ctx, config, options).await {
            LlmStage::Failed(reason) => reason,
            done => return done,
        };
    }
    if !crate::provider::error::is_context_overflow_message(&reason) {
        return LlmStage::Failed(reason);
    }
    tracing::warn!(
        model = %ctx.model,
        "compaction summary exceeds model context; abbreviating tool transcript"
    );
    let abbreviated = prepare_input(request, config, serialize::SerializationOptions {
        abbreviate_tools: true,
    });
    run_llm_stage(abbreviated, ctx, config, options).await
}

async fn run_llm_stage(
    input: SummarizerInput,
    ctx: &SummarizerContext,
    config: &CompactionConfig,
    options: &SummaryOptions,
) -> LlmStage {
    let cancel = stage_cancel(options);
    let summarize = config.summarizer_mode.summarize_with_observer(
        input,
        Some(ctx),
        config.summary_reserve_tokens() as u32,
        cancel.clone(),
        options.observer.clone(),
    );
    let result = match options.timeout {
        Some(timeout) => match tokio::time::timeout(timeout, summarize).await {
            Ok(result) => result,
            Err(_) => {
                cancel.cancel();
                tracing::warn!(
                    stage = "compact",
                    status = "summary_timeout",
                    "{}",
                    timeout_reason(timeout)
                );
                Err(SummarizerError::Failed(timeout_reason(timeout)))
            }
        },
        None => summarize.await,
    };

    if options.cancel.is_cancelled() {
        return LlmStage::Cancelled;
    }
    match result {
        Ok(output) if !output.summary.trim().is_empty() => LlmStage::Ready(output.summary),
        Ok(_) => LlmStage::Failed("summarizer returned empty text".into()),
        Err(SummarizerError::Cancelled) => LlmStage::Cancelled,
        Err(SummarizerError::Failed(reason)) => LlmStage::Failed(reason),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn prepare_input(
    request: &SummaryRequest<'_>,
    config: &CompactionConfig,
    serialization: serialize::SerializationOptions,
) -> SummarizerInput {
    let mut input = serialize::prepare_input_with_options(
        request.evicted,
        request.turn_prefix,
        request.prev_state,
        config,
        serialization,
    );
    input.custom_instructions = request
        .custom_instructions
        .filter(|text| !text.trim().is_empty())
        .map(|text| truncate_summary(text, config.summary_max_bytes()));
    merge_file_ops(&mut input.file_ops, &request.file_ops);
    input
}

fn merge_file_ops(target: &mut FileOps, extra: &FileOps) {
    target.read.extend(extra.read.iter().cloned());
    target.written.extend(extra.written.iter().cloned());
    target.edited.extend(extra.edited.iter().cloned());
}

/// Bound the final summary text.
fn finalize(text: String, config: &CompactionConfig) -> String {
    truncate_summary(&text, config.summary_max_bytes())
}

/// Preserve the evicted split-turn prefix alongside an override summary.
fn with_turn_context(mut text: String, turn_prefix: Option<&str>) -> String {
    if let Some(prefix) = turn_prefix.filter(|prefix| !prefix.trim().is_empty()) {
        text.push_str("\n\n---\n\n**Turn Context (split turn):**\n\n");
        text.push_str(prefix);
    }
    text
}

/// Stage token: with a timeout the stage gets a child token so expiry can
/// abort it without cancelling the whole compaction; without one, the caller's
/// token is passed straight through (providers may observe it directly).
fn stage_cancel(options: &SummaryOptions) -> CancellationToken {
    match options.timeout {
        Some(_) => options.cancel.child_token(),
        None => options.cancel.clone(),
    }
}

fn timeout_reason(timeout: Duration) -> String {
    format!(
        "summary stage timed out after {} seconds",
        timeout.as_secs()
    )
}
