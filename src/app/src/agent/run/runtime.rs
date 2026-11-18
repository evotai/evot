//! Run orchestration — drive the engine, persist projected events, and clean up.
//!
//! `projection` translates engine events; `engine` constructs execution state;
//! `outbox` owns bounded live delivery. This module orders those effects.
//!
//! A run can span multiple model segments. Consumers see one `RunStarted`
//! and one aggregated `RunFinished`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use evot_engine::context::SharedExecutionTracker;

use super::control::RunControl;
use super::engine::build_engine;
use super::engine::execution_tracker;
use super::engine::EngineOptions;
use super::outbox::event_channel;
use super::outbox::EventSender;
use super::projection::map_agent_event;
use super::projection::RuntimeEvent;
use super::run::Run;
use crate::agent::model_handoff::ModelHandoff;
use crate::agent::model_handoff::MAX_HANDOFFS;
use crate::base::error::Result;
use crate::conf::LlmConfig;
use crate::observability::ContextCompactionCompletedStats;
use crate::observability::RunFinishedStats;
use crate::observability::TranscriptStats;
use crate::session::conversation::convert::from_agent_messages;
use crate::session::conversation::run_event::RunEventContext;
use crate::session::conversation::run_event::RunEventPayload;
use crate::session::Session;
use crate::types::CompactRecord;
use crate::types::TranscriptItem;
use crate::types::UsageSummary;

// ---------------------------------------------------------------------------
// TurnInput — prepared by agent, executed by runtime
// ---------------------------------------------------------------------------

pub struct TurnInput {
    pub options: EngineOptions,
    pub history: Vec<evot_engine::AgentMessage>,
    pub input: Vec<evot_engine::Content>,
    pub provenance: Option<evot_engine::InputProvenance>,
    pub(crate) resume: bool,
    pub session: Arc<Session>,
    /// Persisted transcript generation used to build `history`.
    pub transcript_seq: u64,
}

// ---------------------------------------------------------------------------
// TurnFactory — caller-provided builder of per-turn engine state
// ---------------------------------------------------------------------------

pub(in crate::agent) enum SegmentStart {
    Prompt(Vec<evot_engine::Content>),
    Resume(Box<ModelTransition>),
}

pub(in crate::agent) struct ModelTransition {
    pub llm: LlmConfig,
    pub previous_llm: LlmConfig,
}

pub(in crate::agent) struct Segment {
    pub turn: TurnInput,
    pub llm: LlmConfig,
    pub handoff: Option<Arc<ModelHandoff>>,
}

/// Resolve engine options, tools, and persisted session history for a segment.
#[async_trait]
pub(in crate::agent) trait TurnFactory: Send + Sync + 'static {
    async fn build(&self, start: SegmentStart, allow_handoff: bool) -> Result<Segment>;
}

// ---------------------------------------------------------------------------
// execute_run — public entry point: schedule a Run asynchronously
// ---------------------------------------------------------------------------

pub(in crate::agent) struct ExecuteRunArgs {
    pub run_id: String,
    pub session_id: String,
    pub session: Arc<Session>,
    pub initial_input: Vec<evot_engine::Content>,
    pub factory: Arc<dyn TurnFactory>,
    pub on_complete: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub(in crate::agent) fn execute_run(args: ExecuteRunArgs) -> Run {
    let control = RunControl::new();
    let (tx, rx) = event_channel(control.clone());
    let run = Run::new(
        args.run_id.clone(),
        args.session_id.clone(),
        rx,
        control.clone(),
    );
    tokio::spawn(run_loop(args, tx, control));
    run
}

// ---------------------------------------------------------------------------
// run_loop — outer loop: drive engine turns
// ---------------------------------------------------------------------------

async fn run_loop(args: ExecuteRunArgs, tx: EventSender, control: RunControl) {
    let ExecuteRunArgs {
        run_id,
        session_id,
        session,
        initial_input,
        factory,
        on_complete,
    } = args;

    let started_at = Instant::now();
    let _ = tx.send(RunEventContext::new(&run_id, &session_id, 0).started());

    let mut total_usage = UsageSummary::default();
    let mut total_turns: u32 = 0;
    let mut total_transcripts: usize = 0;
    let mut last_text = String::new();
    let mut compact_records: Vec<CompactRecord> = Vec::new();

    let mut start = SegmentStart::Prompt(initial_input);
    let mut tracker = None;
    for index in 0..=MAX_HANDOFFS {
        if control.is_cancelled() {
            break;
        }
        let Segment { turn, llm, handoff } = match factory.build(start, index < MAX_HANDOFFS).await
        {
            Ok(segment) => segment,
            Err(error) => {
                tracing::error!(stage = "run", status = "build_segment_failed", %run_id, %session_id, %error);
                let _ = tx.send(
                    RunEventContext::new(&run_id, &session_id, total_turns).event(
                        RunEventPayload::Error {
                            message: error.to_string(),
                        },
                    ),
                );
                break;
            }
        };
        // A stale notification wake has no input left to process.
        if control.is_cancelled() || (!turn.resume && turn.input.is_empty()) {
            break;
        }
        if !turn.resume {
            tracker = execution_tracker(turn.options.limits.as_ref());
        }
        let outcome = drive_segment(
            turn,
            tracker.clone(),
            &tx,
            &control,
            &run_id,
            &session_id,
            total_turns,
        )
        .await;

        total_turns = total_turns.saturating_add(outcome.turn_count);
        total_usage.input = total_usage.input.saturating_add(outcome.usage.input);
        total_usage.output = total_usage.output.saturating_add(outcome.usage.output);
        total_usage.cache_read = total_usage
            .cache_read
            .saturating_add(outcome.usage.cache_read);
        total_usage.cache_write = total_usage
            .cache_write
            .saturating_add(outcome.usage.cache_write);
        total_transcripts = total_transcripts.saturating_add(outcome.transcript_count);
        if !outcome.last_text.is_empty() {
            last_text = outcome.last_text;
        }
        compact_records.extend(outcome.compact_records);

        if !outcome.completed || control.is_cancelled() {
            break;
        }
        let Some(next) = handoff.and_then(|handoff| handoff.take()) else {
            break;
        };
        if let Some(reason) = tracker
            .as_ref()
            .and_then(|tracker| tracker.lock().check_limits())
        {
            let _ = tx.send(
                RunEventContext::new(&run_id, &session_id, total_turns).event(
                    RunEventPayload::Error {
                        message: format!("Model handoff stopped: {reason}"),
                    },
                ),
            );
            break;
        }
        start = SegmentStart::Resume(Box::new(ModelTransition {
            llm: next,
            previous_llm: llm,
        }));
    }

    // Emit the aggregated run-finished event and a single transcript stats
    // record so consumers see one Run, not N internal turns.
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let stats = TranscriptStats::RunFinished(RunFinishedStats {
        usage: total_usage.clone(),
        turn_count: total_turns,
        duration_ms,
        transcript_count: total_transcripts,
    });
    if let Err(e) = session.write_items(vec![stats.to_item()]).await {
        tracing::warn!(
            stage = "run",
            status = "stats_persist_failed",
            run_id = %run_id,
            session_id = %session_id,
            error = %e,
        );
    }
    session
        .add_usage(total_usage.input, total_usage.output)
        .await;
    let _ = session.save().await;

    let finished = RunEventContext::new(&run_id, &session_id, total_turns).finished(
        last_text,
        total_usage,
        total_turns,
        duration_ms,
        total_transcripts,
        compact_records,
    );
    let _ = tx.send(finished);
    drop(tx);

    tracing::info!(
        stage = "run",
        status = "finished",
        run_id = %run_id,
        session_id = %session_id,
        elapsed_ms = duration_ms,
        turn = total_turns,
    );

    if let Some(f) = on_complete {
        f();
    }
}

// ---------------------------------------------------------------------------
// drive_segment — forward events and persist transcripts for one model
// ---------------------------------------------------------------------------

struct SegmentOutcome {
    completed: bool,
    turn_count: u32,
    usage: UsageSummary,
    transcript_count: usize,
    last_text: String,
    /// Compact records produced during this engine segment, in order.
    compact_records: Vec<CompactRecord>,
}

async fn drive_segment(
    turn: TurnInput,
    tracker: Option<SharedExecutionTracker>,
    tx: &EventSender,
    control: &RunControl,
    run_id: &str,
    session_id: &str,
    turn_offset: u32,
) -> SegmentOutcome {
    let TurnInput {
        options,
        history,
        input,
        provenance,
        resume,
        session,
        transcript_seq,
    } = turn;

    let cwd = options.cwd.to_string_lossy().into_owned();
    let mut privacy_seen = session.privacy_card_tags().await;
    let mut engine = build_engine(options, history)
        .with_run_progress(turn_offset as usize, tracker)
        .with_prompt_queues(control.queues().steering(), control.queues().follow_up());
    let (engine_handle, mut engine_rx) = if resume {
        engine.resume_bounded(control.segment_cancellation()).await
    } else {
        let user_msg = evot_engine::AgentMessage::Llm(evot_engine::Message::User {
            provenance,
            content: input,
            timestamp: evot_engine::now_ms(),
        });
        engine.submit_bounded(vec![user_msg]).await
    };
    control.install_engine(engine_handle);
    // Map one engine event at a time in the consumer. No forwarding task or
    // second unbounded queue is needed; only this event's expansion is buffered.
    let mut pending_events = VecDeque::new();
    let mut consumer_closed = false;

    // MessageEnd is the single persistence boundary for admitted user inputs,
    // including the initial prompt. Do not pre-insert it ahead of a possible
    // pre-prompt compaction, or duplicate it when its engine event arrives.
    let mut turn_transcripts: Vec<TranscriptItem> = Vec::new();
    let mut saved_count: usize = 0;
    let mut expected_seq = transcript_seq;
    // Set once another writer lands *conversation* content the engine never
    // saw (e.g. a second client's user message). A compaction planned from
    // the engine's context would silently drop it, so persistence is skipped.
    // Stats/notice writes advance the sequence too, but carry no context, so
    // they must not block compaction — a 39-minute run with one background
    // task notice used to summarize 500k tokens and then throw the result away.
    let mut context_rebased = false;
    let mut persistence_failed = false;
    let mut turn_count = turn_offset;
    let mut outcome = SegmentOutcome {
        completed: false,
        turn_count: 0,
        usage: UsageSummary::default(),
        transcript_count: 0,
        last_text: String::new(),
        compact_records: Vec::new(),
    };

    let flush = |session: &Arc<Session>,
                 items: &[TranscriptItem],
                 saved: &mut usize,
                 expected: &mut u64| {
        let new_items = items[*saved..].to_vec();
        let session = Arc::clone(session);
        let batch_len = new_items.len();
        let current_expected = *expected;
        async move {
            let append = if new_items.is_empty() {
                crate::session::TurnAppend {
                    next_seq: current_expected,
                    interleaved_context_items: 0,
                }
            } else {
                session.write_items_at(new_items, current_expected).await?
            };
            Ok::<(usize, crate::session::TurnAppend), crate::base::error::EvotError>((
                batch_len, append,
            ))
        }
    };

    loop {
        let event = match pending_events.pop_front() {
            Some(event) => event,
            None => {
                // Backpressure: a slow but live consumer pauses the engine read
                // instead of cancelling the run. A closed consumer returns at once.
                if !consumer_closed && tx.over_budget() {
                    tx.wait_for_capacity().await;
                }
                let event = tokio::select! {
                    _ = tx.closed(), if !consumer_closed => {
                        consumer_closed = true;
                        control.abort();
                        continue;
                    }
                    event = engine_rx.recv() => event,
                };
                let Some(event) = event else { break };
                pending_events.extend(map_agent_event(&event));
                continue;
            }
        };
        match event {
            RuntimeEvent::TurnStarted => {
                turn_count = turn_count.saturating_add(1);
                session.increment_turn().await;
            }
            RuntimeEvent::Transcript(item) => {
                turn_transcripts.push(item);
            }
            RuntimeEvent::PrivacyFindings(mut findings) => {
                findings.retain(|finding| privacy_seen.insert(finding.tag.clone()));
                if findings.is_empty() {
                    continue;
                }
                let card = crate::privacy::SavedCard {
                    schema_version: 1,
                    cwd: cwd.clone(),
                    findings,
                };
                let Ok(card) = serde_json::to_value(card) else {
                    continue;
                };
                turn_transcripts.push(TranscriptItem::Stats {
                    kind: crate::privacy::CARD_KIND.into(),
                    data: card.clone(),
                });
                match flush(
                    &session,
                    &turn_transcripts,
                    &mut saved_count,
                    &mut expected_seq,
                )
                .await
                {
                    Ok((written, append)) => {
                        context_rebased |= append.interleaved_context_items > 0;
                        saved_count += written;
                        expected_seq = append.next_seq;
                    }
                    Err(error) => {
                        emit_persistence_error(tx, run_id, session_id, turn_count, &error);
                        control.abort();
                        persistence_failed = true;
                        break;
                    }
                }
                let event = RunEventContext::new(run_id, session_id, turn_count)
                    .event(RunEventPayload::PrivacyCard { card });
                if !consumer_closed && tx.send(event).is_err() {
                    consumer_closed = true;
                    control.abort();
                }
            }
            RuntimeEvent::CompactionCompleted {
                reason,
                result,
                summary,
                messages,
                state,
                context_window,
                will_retry,
            } => {
                if let Some(record) = compact_record_from_result(&result) {
                    outcome.compact_records.push(record);
                }

                if matches!(
                    result,
                    crate::observability::CompactionResult::Compacted { .. }
                ) {
                    match flush(
                        &session,
                        &turn_transcripts,
                        &mut saved_count,
                        &mut expected_seq,
                    )
                    .await
                    {
                        Ok((written, append)) => {
                            context_rebased |= append.interleaved_context_items > 0;
                            saved_count = saved_count.saturating_add(written);
                            expected_seq = append.next_seq;
                        }
                        Err(error) => {
                            emit_persistence_error(tx, run_id, session_id, turn_count, &error);
                            control.abort();
                            persistence_failed = true;
                            break;
                        }
                    }

                    if context_rebased {
                        tracing::warn!(
                            stage = "run",
                            status = "compaction_skipped_after_rebase",
                            run_id,
                            session_id,
                            "skipping stale automatic compaction: another writer added context items during this run"
                        );
                    } else {
                        let new_context = from_agent_messages(&messages);
                        let item = automatic_compact_item(
                            reason.clone(),
                            &result,
                            summary.clone(),
                            new_context.clone(),
                            messages,
                            state,
                        );
                        if let Err(error) =
                            session.write_compact(item, new_context, expected_seq).await
                        {
                            emit_persistence_error(tx, run_id, session_id, turn_count, &error);
                            control.abort();
                            persistence_failed = true;
                            break;
                        }
                        expected_seq = expected_seq.saturating_add(1);
                    }
                }

                turn_transcripts.push(
                    TranscriptStats::ContextCompactionCompleted(ContextCompactionCompletedStats {
                        reason,
                        result,
                        context_window,
                        will_retry,
                    })
                    .to_item(),
                );
            }
            RuntimeEvent::TurnEnded => {
                match flush(
                    &session,
                    &turn_transcripts,
                    &mut saved_count,
                    &mut expected_seq,
                )
                .await
                {
                    Ok((written, append)) => {
                        context_rebased |= append.interleaved_context_items > 0;
                        saved_count = saved_count.saturating_add(written);
                        expected_seq = append.next_seq;
                    }
                    Err(error) => {
                        emit_persistence_error(tx, run_id, session_id, turn_count, &error);
                        control.abort();
                        persistence_failed = true;
                        break;
                    }
                }
            }
            RuntimeEvent::EngineCompleted {
                last_text,
                usage,
                transcript_count,
            } => {
                outcome.completed = transcript_count > 0;
                outcome.usage = usage;
                outcome.transcript_count = transcript_count;
                outcome.last_text = last_text;
                break;
            }
            RuntimeEvent::Public(payload) => {
                let event = RunEventContext::new(run_id, session_id, turn_count).event(payload);
                if !consumer_closed && tx.send(event).is_err() {
                    consumer_closed = true;
                    control.abort();
                    // The UI is gone. Continue consuming cancellation/final
                    // events so transcript and usage persistence finish.
                }
            }
        }
    }

    // Final flush in case engine ended without a TurnEnded event. A failed
    // strict write must not be retried against stale state.
    if !persistence_failed {
        if let Err(error) = flush(
            &session,
            &turn_transcripts,
            &mut saved_count,
            &mut expected_seq,
        )
        .await
        {
            emit_persistence_error(tx, run_id, session_id, turn_count, &error);
            control.abort();
        }
    }

    control.detach_engine();
    outcome.turn_count = turn_count.saturating_sub(turn_offset);
    outcome
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn automatic_compact_item(
    reason: crate::types::CompactReason,
    result: &crate::observability::CompactionResult,
    summary: Option<String>,
    messages: Vec<TranscriptItem>,
    engine_messages: Vec<evot_engine::AgentMessage>,
    state: evot_engine::CompactionState,
) -> TranscriptItem {
    let (messages_before, messages_after, tokens_before, tokens_after) = match result {
        crate::observability::CompactionResult::Compacted {
            before_message_count,
            after_message_count,
            before_tokens,
            after_tokens,
            ..
        } => (
            *before_message_count,
            *after_message_count,
            *before_tokens,
            *after_tokens,
        ),
        crate::observability::CompactionResult::NoOp => (0, 0, 0, 0),
    };
    let details = crate::types::CompactDetails {
        read_files: state.file_ops.read_only().into_iter().cloned().collect(),
        modified_files: state.file_ops.modified().into_iter().cloned().collect(),
        method: match result {
            crate::observability::CompactionResult::Compacted { method, .. } => *method,
            crate::observability::CompactionResult::NoOp => None,
        },
        ..Default::default()
    };
    TranscriptItem::Compact {
        id: crate::types::new_id(),
        created_at: evot_engine::now_ms(),
        reason,
        summary: summary
            .or_else(|| state.last_summary.clone())
            .unwrap_or_default(),
        tokens_before,
        tokens_after,
        messages_before,
        messages_after,
        messages,
        engine_messages,
        state: Box::new(state),
        details,
    }
}

fn emit_persistence_error(
    tx: &EventSender,
    run_id: &str,
    session_id: &str,
    turn: u32,
    error: &crate::base::error::EvotError,
) {
    tracing::error!(
        stage = "run",
        status = "persistence_failed",
        run_id,
        session_id,
        error = %error,
    );
    let _ = tx.send(
        RunEventContext::new(run_id, session_id, turn).event(RunEventPayload::Error {
            message: format!("session persistence failed: {error}"),
        }),
    );
}

fn compact_record_from_result(
    result: &crate::observability::CompactionResult,
) -> Option<CompactRecord> {
    crate::agent::run::observability::compact_record_from_result(result)
}
