//! Run orchestration — drive the engine, persist projected events, and clean up.
//!
//! `projection` translates engine events; `engine` constructs execution state;
//! `outbox` owns bounded live delivery. This module orders those effects.
//!
//! A single `Run` comprises one engine turn. Consumers see one `RunStarted`
//! and one aggregated `RunFinished`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;

use super::control::RunControl;
use super::engine::build_engine;
use super::engine::EngineOptions;
use super::event::RunEventContext;
use super::event::RunEventPayload;
use super::outbox::event_channel;
use super::outbox::EventSender;
use super::projection::map_agent_event;
use super::projection::RuntimeEvent;
use super::run::Run;
use crate::conversation::convert::from_agent_messages;
use crate::error::Result;
use crate::observability::CompactRecord;
use crate::observability::ContextCompactionCompletedStats;
use crate::observability::RunFinishedStats;
use crate::observability::TranscriptStats;
use crate::observability::UsageSummary;
use crate::sessions::Session;
use crate::types::TranscriptItem;

// ---------------------------------------------------------------------------
// TurnInput — prepared by agent, executed by runtime
// ---------------------------------------------------------------------------

pub struct TurnInput {
    pub options: EngineOptions,
    pub history: Vec<evot_engine::AgentMessage>,
    pub input: Vec<evot_engine::Content>,
    pub session: Arc<Session>,
    /// Persisted transcript generation used to build `history`.
    pub transcript_seq: u64,
}

// ---------------------------------------------------------------------------
// TurnFactory — caller-provided builder of per-turn engine state
// ---------------------------------------------------------------------------

/// Rebuilds the engine input for the next internal turn.
///
/// The runtime calls this once per turn. The factory captures whatever
/// the agent layer needs (config, sandbox, tools, system prompt) and
/// resolves the latest history at call time.
#[async_trait]
pub(in crate::agent) trait TurnFactory: Send + Sync + 'static {
    /// Build the engine options + history + initial user input for this turn.
    async fn build(&self, input: Vec<evot_engine::Content>) -> Result<TurnInput>;
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

    if !control.is_cancelled() {
        let outcome = match factory.build(initial_input).await {
            // A stale notification wake has no input left to process.
            Ok(turn) if turn.input.is_empty() => None,
            Ok(turn) => {
                Some(drive_one_turn(turn, &tx, &control, &run_id, &session_id, started_at).await)
            }
            Err(e) => {
                tracing::error!(
                    stage = "run",
                    status = "build_turn_failed",
                    run_id = %run_id,
                    session_id = %session_id,
                    error = %e,
                );
                // Surface the failure to the caller instead of ending the run
                // silently — e.g. a missing API key must be visible in the UI.
                let _ = tx.send(RunEventContext::new(&run_id, &session_id, 0).event(
                    RunEventPayload::Error {
                        message: e.to_string(),
                    },
                ));
                None
            }
        };

        if let Some(outcome) = outcome {
            let TurnOutcome {
                turn_count,
                usage,
                transcript_count,
                last_text: turn_last_text,
                compact_records: turn_compacts,
            } = outcome;

            total_turns = total_turns.saturating_add(turn_count);
            total_usage.input = total_usage.input.saturating_add(usage.input);
            total_usage.output = total_usage.output.saturating_add(usage.output);
            total_usage.cache_read = total_usage.cache_read.saturating_add(usage.cache_read);
            total_usage.cache_write = total_usage.cache_write.saturating_add(usage.cache_write);
            total_transcripts = total_transcripts.saturating_add(transcript_count);
            if !turn_last_text.is_empty() {
                last_text = turn_last_text;
            }
            compact_records.extend(turn_compacts);
        }
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
// drive_one_turn — single engine submit: forward events, persist transcripts
// ---------------------------------------------------------------------------

struct TurnOutcome {
    turn_count: u32,
    usage: UsageSummary,
    transcript_count: usize,
    last_text: String,
    /// Compact records produced during this engine turn, in order.
    compact_records: Vec<CompactRecord>,
}

async fn drive_one_turn(
    turn: TurnInput,
    tx: &EventSender,
    control: &RunControl,
    run_id: &str,
    session_id: &str,
    _started_at: Instant,
) -> TurnOutcome {
    let TurnInput {
        options,
        history,
        input,
        session,
        transcript_seq,
    } = turn;

    let mut engine = build_engine(options, history)
        .with_prompt_queues(control.queues().steering(), control.queues().follow_up());
    let user_msg = evot_engine::AgentMessage::Llm(evot_engine::Message::User {
        content: input.clone(),
        timestamp: evot_engine::now_ms(),
    });
    let (engine_handle, mut engine_rx) = engine.submit_bounded(vec![user_msg]).await;
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
    let mut turn_count: u32 = 0;
    let mut outcome = TurnOutcome {
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
                crate::sessions::TurnAppend {
                    next_seq: current_expected,
                    interleaved_context_items: 0,
                }
            } else {
                session.write_items_at(new_items, current_expected).await?
            };
            Ok::<(usize, crate::sessions::TurnAppend), crate::error::EvotError>((batch_len, append))
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
                        let mut new_context = from_agent_messages(&messages);
                        if let Some(summary) = summary.as_deref() {
                            for (index, message) in messages.iter().enumerate() {
                                if evot_engine::context::compaction::remote::is_replacement_message(
                                    message,
                                ) && index < new_context.len()
                                {
                                    new_context[index] =
                                        crate::compact::context_view::compact_summary_item(summary);
                                }
                            }
                        }
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
                outcome.turn_count = turn_count;
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
    if outcome.turn_count == 0 {
        outcome.turn_count = turn_count;
    }
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
        remote_blob_bytes: match result {
            crate::observability::CompactionResult::Compacted {
                remote_blob_bytes, ..
            } => *remote_blob_bytes,
            crate::observability::CompactionResult::NoOp => None,
        },
        fallback_reason: match result {
            crate::observability::CompactionResult::Compacted {
                fallback_reason, ..
            } => fallback_reason.clone(),
            crate::observability::CompactionResult::NoOp => None,
        },
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
    error: &crate::error::EvotError,
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
