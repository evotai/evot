//! Manual `/compact` orchestrator.
//!
//! Thin app-layer frontend over the engine's shared compaction pipeline:
//! plan via `plan_compaction`, summarize via the engine summary chain
//! (remote → LLM → deterministic emergency), then persist a
//! `TranscriptItem::Compact` for the session.

use std::sync::Arc;

use evot_engine::context::compaction::summary;
use evot_engine::context::compaction::summary::LlmPolicy;
use evot_engine::context::compaction::summary::SummaryOutcome;
use tokio_util::sync::CancellationToken;

use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::LlmConfig;
use crate::session::conversation::context_view::compact_summary_item;
use crate::session::conversation::convert;
use crate::session::Session;
use crate::types::CompactDetails;
use crate::types::CompactReason;
use crate::types::CompactionMethod;
use crate::types::TranscriptItem;

#[derive(Debug, Clone)]
pub struct CompactSettings {
    /// Token ceiling for the retained tail. The engine further constrains it
    /// to the shared post-compaction envelope.
    pub keep_recent_tokens: usize,
    /// The active model's request-input limit. It bounds the shared
    /// post-compaction envelope; `0` means unknown.
    pub context_window: usize,
}

impl Default for CompactSettings {
    fn default() -> Self {
        Self {
            keep_recent_tokens: evot_engine::context::DEFAULT_KEEP_RECENT_TOKENS,
            context_window: 0,
        }
    }
}

pub use evot_engine::CompactionPhase as ManualCompactionPhase;
pub type ManualCompactionObserver = evot_engine::CompactionObserver;

#[derive(Clone)]
pub struct ManualCompactRequest {
    pub reason: CompactReason,
    pub custom_instructions: Option<String>,
    pub summary_override: Option<String>,
    pub summarizer: Option<CompactSummarizer>,
    pub settings: CompactSettings,
    pub observer: Option<ManualCompactionObserver>,
}

#[derive(Clone)]
pub struct CompactSummarizer {
    pub provider: std::sync::Arc<dyn evot_engine::provider::StreamProvider>,
    pub llm: LlmConfig,
    /// Maximum summary output. Split-turn prefix summaries use half this value.
    pub reserve_tokens: u32,
    /// Optional wall-clock bound per summary stage for explicit callers.
    /// Interactive compaction has no deadline: it waits for completion unless
    /// the user cancels. Explicit expiry may use the deterministic fallback.
    pub timeout: Option<std::time::Duration>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ManualCompactionOutcome {
    Compacted {
        summary: String,
        tokens_before: usize,
        tokens_after: usize,
        messages_before: usize,
        messages_after: usize,
        context_window: usize,
        messages_evicted: usize,
        current_run_reclaimed: usize,
        /// Deprecated wire field, always 3; compaction has no levels anymore.
        compaction_level: usize,
        used_fallback: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<CompactionMethod>,
        #[serde(skip_serializing_if = "Option::is_none")]
        remote_blob_bytes: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback_reason: Option<String>,
    },
    NothingToCompact,
    Cancelled,
}

impl ManualCompactionOutcome {
    pub fn describe(&self) -> String {
        match self {
            ManualCompactionOutcome::Compacted {
                tokens_before,
                tokens_after,
                messages_before,
                messages_after,
                context_window,
                used_fallback,
                method,
                remote_blob_bytes,
                fallback_reason,
                ..
            } => {
                let mut line = format!(
                    "Session compacted: {tokens_before} → {tokens_after} tokens, {messages_before} → {messages_after} messages."
                );
                if *used_fallback {
                    line.push_str(
                        "\nNote: the LLM summary was unavailable; a deterministic fallback summary was used.",
                    );
                }
                match method {
                    Some(evot_engine::CompactionMethod::Remote) => {
                        line.push_str("\nProvider-native remote compaction was used.");
                        if let Some(bytes) = remote_blob_bytes {
                            line.push_str(&format!(" Native blob: {bytes} bytes."));
                        }
                    }
                    Some(evot_engine::CompactionMethod::RemoteFailedLocal) => {
                        line.push_str(
                            "\nProvider-native remote compaction failed; local summarization was used.",
                        );
                        if let Some(reason) = fallback_reason {
                            line.push_str(&format!(" Reason: {reason}"));
                        }
                    }
                    Some(evot_engine::CompactionMethod::Local) if fallback_reason.is_some() => {
                        if let Some(reason) = fallback_reason {
                            line.push_str(&format!(
                                "\nProvider-native remote compaction was unavailable; local summarization was used. Reason: {reason}"
                            ));
                        }
                    }
                    _ => {}
                }
                if *context_window > 0 && tokens_after >= context_window {
                    line.push_str(&format!(
                        "\nWarning: context is still {tokens_after} tokens, above this model's {context_window}-token window. \
                         Switch to a larger-context model or start a new session to continue."
                    ));
                }
                line
            }
            ManualCompactionOutcome::NothingToCompact => "Nothing to compact.".into(),
            ManualCompactionOutcome::Cancelled => "Compaction cancelled.".into(),
        }
    }
}

/// Result from the compaction orchestrator. `status` distinguishes cancellation
/// from an ordinary no-op so callers never report Esc as "Nothing to compact".
#[derive(Debug, PartialEq, Eq)]
pub enum CompactSessionStatus {
    Compacted,
    NothingToCompact,
    Cancelled,
}

#[derive(Debug)]
pub struct CompactSessionOutcome {
    pub status: CompactSessionStatus,
    pub item: Option<TranscriptItem>,
    pub used_fallback: bool,
}

pub async fn compact_session(
    session: &Arc<Session>,
    request: ManualCompactRequest,
    cancel: CancellationToken,
) -> Result<Option<TranscriptItem>> {
    Ok(compact_session_with_status(session, request, cancel)
        .await?
        .item)
}

pub async fn compact_session_with_status(
    session: &Arc<Session>,
    mut request: ManualCompactRequest,
    cancel: CancellationToken,
) -> Result<CompactSessionOutcome> {
    if cancel.is_cancelled() {
        return Ok(cancelled());
    }

    let observer = request.observer.clone();
    notify_phase(&observer, ManualCompactionPhase::Planning);

    // Snapshot the session context. A resumed context already contains the
    // previous summary as a user message; remove the exact recorded copy so
    // the summarizer receives it once via `previous_summary`.
    let (mut app_context, mut engine_context, previous_state, expected_seq) =
        session.compaction_snapshot().await;
    if let Some(summary_message) = previous_state
        .as_ref()
        .and_then(|state| state.context_summary_message.as_deref())
    {
        if let Some(index) = engine_context
            .iter()
            .position(|message| is_exact_user_text(message, summary_message))
        {
            engine_context.remove(index);
            if index < app_context.len() {
                app_context.remove(index);
            }
        }
    }

    let compact_entries = engine_context
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, message)| evot_engine::CompactEntry {
            seq: index.saturating_add(1) as u64,
            message,
        })
        .collect::<Vec<_>>();

    let config = chain_config(&request);
    let retained_tail = request
        .settings
        .keep_recent_tokens
        .min(config.retained_tail_budget(0));
    let plan = match evot_engine::plan_compaction(&compact_entries, None, retained_tail) {
        Some(plan) => plan,
        None => {
            return Ok(CompactSessionOutcome {
                status: CompactSessionStatus::NothingToCompact,
                item: None,
                used_fallback: false,
            })
        }
    };
    if cancel.is_cancelled() {
        return Ok(cancelled());
    }

    // Run the shared summary chain.
    let has_summarizer = request.summarizer.is_some();
    let summary_override = request
        .summary_override
        .take()
        .filter(|s| !s.trim().is_empty());
    let deterministic_only = !has_summarizer && summary_override.is_none();
    let ctx = request.summarizer.as_ref().map(summarizer_context);
    let evicted = slice_messages(&compact_entries, plan.summarize.clone());
    let turn_prefix = plan
        .turn_prefix
        .as_ref()
        .map(|range| slice_messages(&compact_entries, range.clone()));

    let result = match summary::summarize(
        summary::SummaryRequest {
            evicted: &evicted,
            turn_prefix: turn_prefix.as_deref(),
            prev_state: previous_state.as_ref(),
            custom_instructions: request.custom_instructions.as_deref(),
            file_ops: plan.file_ops.clone(),
            override_text: summary_override,
        },
        summary::SummaryContexts::same(ctx.as_ref()),
        &config,
        summary::SummaryOptions {
            llm_policy: LlmPolicy::PreferLlm,
            timeout: request.summarizer.as_ref().and_then(|s| s.timeout),
            observer: observer.clone(),
            cancel: cancel.clone(),
        },
    )
    .await
    {
        SummaryOutcome::Ready(result) => result,
        SummaryOutcome::Cancelled => return Ok(cancelled()),
        // `PreferLlm` never aborts; guard against future policy changes.
        SummaryOutcome::Aborted => {
            return Err(EvotError::Run(
                "compaction summary chain aborted unexpectedly".into(),
            ))
        }
    };
    let summary::SummaryResult {
        text: summary,
        remote,
        method,
        fallback_reason,
        used_fallback: llm_fell_back,
    } = result;
    let used_fallback = llm_fell_back || deterministic_only;

    // Assemble the compact item: summary message + retained tail.
    let summary_item = compact_summary_item(&summary);
    let remote_blob_bytes = remote.as_ref().map(|compaction| compaction.encrypted_bytes);
    let is_remote = remote.is_some();
    let summary_message = match (remote, ctx.as_ref()) {
        (Some(compaction), Some(ctx)) => {
            evot_engine::context::compaction::remote::replacement_message(
                ctx,
                compaction,
                summary.clone(),
            )
        }
        _ => convert::agent_message_from_transcript(&summary_item),
    };

    let mut new_context = vec![summary_item];
    new_context.extend(app_context[plan.first_kept..].iter().cloned());
    let mut new_engine_context = vec![summary_message];
    new_engine_context.extend(engine_context[plan.first_kept..].iter().cloned());
    let messages_after = new_context.len();
    let tokens_after = evot_engine::context::total_tokens(&new_engine_context);

    let details = build_details(
        &previous_state,
        &plan,
        method,
        fallback_reason,
        remote_blob_bytes,
    );

    // Cross-compaction state: accumulate file ops, chain the new summary.
    let mut state = previous_state.unwrap_or_default();
    state
        .file_ops
        .read
        .extend(plan.file_ops.read.iter().cloned());
    state
        .file_ops
        .written
        .extend(plan.file_ops.written.iter().cloned());
    state
        .file_ops
        .edited
        .extend(plan.file_ops.edited.iter().cloned());
    state.timestamp = evot_engine::now_ms();
    state.generation = state.generation.saturating_add(1);
    state.last_summary = Some(summary.clone());
    // Remote state has no text message in context to dedupe next time.
    state.context_summary_message = if is_remote {
        None
    } else {
        new_engine_context.first().and_then(exact_user_text)
    };

    let mut item = TranscriptItem::Compact {
        id: crate::types::new_id(),
        created_at: state.timestamp,
        reason: request.reason,
        summary,
        tokens_before: plan.tokens_before,
        tokens_after,
        messages_before: plan.messages_before,
        messages_after,
        messages: new_context.clone(),
        engine_messages: new_engine_context,
        state: Box::new(state),
        details,
    };
    crate::session::conversation::context_view::normalize_compact_item(&mut item, &mut new_context);

    if cancel.is_cancelled() {
        return Ok(cancelled());
    }
    session
        .write_compact(item.clone(), new_context, expected_seq)
        .await?;
    notify_phase(&observer, ManualCompactionPhase::Complete);
    Ok(CompactSessionOutcome {
        status: CompactSessionStatus::Compacted,
        item: Some(item),
        used_fallback,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn cancelled() -> CompactSessionOutcome {
    CompactSessionOutcome {
        status: CompactSessionStatus::Cancelled,
        item: None,
        used_fallback: false,
    }
}

/// Merge previous cumulative file ops with this plan's into user-facing details.
fn build_details(
    previous_state: &Option<evot_engine::CompactionState>,
    plan: &evot_engine::CompactionPlan,
    method: CompactionMethod,
    fallback_reason: Option<String>,
    remote_blob_bytes: Option<usize>,
) -> CompactDetails {
    let mut details = CompactDetails::default();
    if let Some(previous) = previous_state.as_ref() {
        details.read_files = previous.file_ops.read.iter().cloned().collect();
        details.modified_files = previous.file_ops.modified().into_iter().cloned().collect();
    }
    for file in plan.file_ops.read_only() {
        if !details.read_files.contains(file) {
            details.read_files.push(file.to_string());
        }
    }
    for file in plan.file_ops.modified() {
        if !details.modified_files.contains(file) {
            details.modified_files.push(file.to_string());
        }
    }
    details.read_files.sort();
    details.read_files.dedup();
    details.modified_files.sort();
    details.modified_files.dedup();
    details.method = Some(method);
    details.remote_blob_bytes = remote_blob_bytes;
    details.fallback_reason = fallback_reason;
    details
}

/// Shared planner and summary budgets. The active model controls the retained
/// context envelope; its summarizer model controls output only.
fn chain_config(request: &ManualCompactRequest) -> evot_engine::context::CompactionConfig {
    let fallback_window = request
        .summarizer
        .as_ref()
        .map(|summarizer| summarizer.llm.model_config.context_window() as usize)
        .unwrap_or(0);
    let window = if request.settings.context_window > 0 {
        request.settings.context_window
    } else {
        fallback_window
    };
    let mut config = evot_engine::context::CompactionConfig::from_context_window(window);
    if let Some(summarizer) = request.summarizer.as_ref() {
        config.summarizer_mode = evot_engine::SummarizerMode::Llm {
            reserve_tokens: summarizer.reserve_tokens,
        };
    }
    config
}

fn slice_messages(
    entries: &[evot_engine::CompactEntry],
    range: std::ops::Range<usize>,
) -> Vec<evot_engine::AgentMessage> {
    entries[range]
        .iter()
        .map(|entry| entry.message.clone())
        .collect()
}

fn notify_phase(observer: &Option<ManualCompactionObserver>, phase: ManualCompactionPhase) {
    evot_engine::context::compaction::types::notify_compaction_phase(observer, phase);
}

fn is_exact_user_text(message: &evot_engine::AgentMessage, expected: &str) -> bool {
    exact_user_text(message).is_some_and(|text| text == expected)
}

fn exact_user_text(message: &evot_engine::AgentMessage) -> Option<String> {
    let evot_engine::AgentMessage::Llm(evot_engine::Message::User { content, .. }) = message else {
        return None;
    };
    match content.as_slice() {
        [evot_engine::Content::Text { text }] => Some(text.clone()),
        _ => None,
    }
}

fn summarizer_context(summarizer: &CompactSummarizer) -> evot_engine::SummarizerContext {
    evot_engine::SummarizerContext {
        provider: summarizer.provider.clone(),
        model: summarizer.llm.model.clone(),
        api_key: summarizer.llm.api_key.clone(),
        thinking_level: summarizer.llm.thinking_level,
        system_prompt: String::new(),
        tools: vec![],
        max_tokens: Some(summarizer.reserve_tokens),
        cache_config: evot_engine::CacheConfig::default(),
        prompt_cache_key: None,
        model_config: Some(summarizer.llm.model_config.clone()),
    }
}
