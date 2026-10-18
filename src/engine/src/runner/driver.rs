//! The core agent loop: prompt → LLM stream → tool execution → repeat.
//!
//! - `agent_loop()` starts with new prompt messages
//! - `agent_loop_continue()` resumes from existing context
//!
//! Both return a stream of `AgentEvent`s.

use std::sync::Arc;

use tokio::sync::mpsc;

use super::compaction_check::check_compaction;
use super::compaction_check::CompactionCheckInput;
use super::compaction_check::CompactionCheckPhase;
use super::compaction_check::CompactionRequestShape;
use super::config::AgentLoopConfig;
use super::doom_loop::DoomLoopDetector;
use super::event_sink::EventSink;
use super::llm_call::stream_assistant_response;
use super::llm_call::AssistantStreamInput;
use super::thinking_only_guard::ThinkingOnlyGuard;
use super::tool_exec::build_tool_definitions;
use super::tool_exec::execute_tool_calls;
use super::tool_exec::fail_truncated_tool_calls;
use super::tool_exec::skip_tool_call_doom_loop;
use crate::context::now_ms;
use crate::context::ContextTracker;
use crate::context::ExecutionTracker;
use crate::context::{self};
use crate::types::*;

pub(crate) struct AgentLoopOutcome {
    pub(crate) messages: Vec<AgentMessage>,
    pub(crate) compaction_state: Option<crate::context::CompactionState>,
}

/// Start an agent loop with new prompt messages.
pub async fn agent_loop(
    prompts: Vec<AgentMessage>,
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    tx: mpsc::UnboundedSender<AgentEvent>,
    cancel: tokio_util::sync::CancellationToken,
) -> Vec<AgentMessage> {
    agent_loop_with_state(prompts, context, config, tx.into(), cancel)
        .await
        .messages
}

pub(crate) async fn agent_loop_with_state(
    prompts: Vec<AgentMessage>,
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    tx: EventSink,
    cancel: tokio_util::sync::CancellationToken,
) -> AgentLoopOutcome {
    tx.send(AgentEvent::AgentStart).await.ok();
    let mut new_messages = prompts.clone();
    tx.send(AgentEvent::TurnStart).await.ok();

    let compaction_state =
        run_loop(context, &mut new_messages, prompts, config, &tx, &cancel).await;

    tx.send(AgentEvent::AgentEnd {
        messages: new_messages.clone(),
    })
    .await
    .ok();
    AgentLoopOutcome {
        messages: new_messages,
        compaction_state,
    }
}

/// Continue an agent loop from existing context (for retries).
pub async fn agent_loop_continue(
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    tx: mpsc::UnboundedSender<AgentEvent>,
    cancel: tokio_util::sync::CancellationToken,
) -> Vec<AgentMessage> {
    agent_loop_continue_with_state(context, config, tx.into(), cancel)
        .await
        .messages
}

pub(crate) async fn agent_loop_continue_with_state(
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    tx: EventSink,
    cancel: tokio_util::sync::CancellationToken,
) -> AgentLoopOutcome {
    tx.send(AgentEvent::AgentStart).await.ok();

    let invalid_state = if context.messages.is_empty() {
        Some("Cannot continue: no messages in context")
    } else if context
        .messages
        .last()
        .is_some_and(|message| message.role() == "assistant")
    {
        Some("Cannot continue from assistant message")
    } else {
        None
    };
    if let Some(message) = invalid_state {
        tx.send(AgentEvent::Error {
            error: AgentErrorInfo {
                kind: AgentErrorKind::Runtime,
                message: message.into(),
            },
        })
        .await
        .ok();
        tx.send(AgentEvent::AgentEnd { messages: vec![] })
            .await
            .ok();
        return AgentLoopOutcome {
            messages: vec![],
            compaction_state: config.initial_compaction_state.clone(),
        };
    }

    let mut new_messages = Vec::new();
    tx.send(AgentEvent::TurnStart).await.ok();

    let compaction_state =
        run_loop(context, &mut new_messages, Vec::new(), config, &tx, &cancel).await;

    tx.send(AgentEvent::AgentEnd {
        messages: new_messages.clone(),
    })
    .await
    .ok();
    AgentLoopOutcome {
        messages: new_messages,
        compaction_state,
    }
}

/// Main response loop shared by `agent_loop` and `agent_loop_continue`.
///
/// Tool calls, steering, retries, and follow-ups all continue this loop. The
/// compaction check runs only after those sources are drained.
async fn run_loop(
    context: &mut AgentContext,
    new_messages: &mut Vec<AgentMessage>,
    initial_prompts: Vec<AgentMessage>,
    config: &AgentLoopConfig,
    tx: &EventSink,
    cancel: &tokio_util::sync::CancellationToken,
) -> Option<crate::context::CompactionState> {
    let mut first_turn = true;
    let mut turn_number: usize = 0;
    let mut tracker = config
        .execution_limits
        .as_ref()
        .map(|limits| ExecutionTracker::new(limits.clone()));
    let mut doom_detector = DoomLoopDetector::new(3);

    let mut thinking_only_guard = ThinkingOnlyGuard::new();
    let mut context_tracker = ContextTracker::new();
    if let Some(timestamp) = config
        .initial_compaction_state
        .as_ref()
        .map(|state| state.timestamp)
        .filter(|timestamp| *timestamp > 0)
    {
        context_tracker.record_compaction_done(timestamp);
    }
    let mut compaction_controller = config.context_config.as_ref().map(|ctx_cfg| {
        let phase_tx = tx.clone();
        let observer: crate::context::CompactionObserver = Arc::new(move |update| {
            phase_tx.progress(AgentEvent::ContextCompactionPhase {
                phase: update.phase,
                activity: update.activity,
            });
        });
        let mut controller = crate::context::CompactionController::new(
            crate::context::CompactionConfig::from_context_config(ctx_cfg),
        )
        .with_observer(observer);
        if let Some(judge) = config.judge.clone() {
            controller = controller.with_judge(judge);
        }
        if let Some(ledger) = config.prune_ledger.clone() {
            controller = controller.with_prune_ledger(ledger);
        }
        match config.initial_compaction_state.clone() {
            Some(state) => controller.with_state(state),
            None => controller,
        }
    });

    // Match pi's prompt-time compaction check: inspect the previous assistant
    // before the new explicit prompt enters context. This runs once per agent
    // prompt, not before every provider call in the tool/retry loop.
    if !initial_prompts.is_empty() {
        let previous_assistant = context
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                AgentMessage::Llm(message @ Message::Assistant { .. }) => Some(message.clone()),
                _ => None,
            });
        if let Some(previous_assistant) = previous_assistant {
            let tool_defs = build_tool_definitions(context, &config.model);
            check_compaction(
                &mut compaction_controller,
                &mut context_tracker,
                &mut context.messages,
                CompactionCheckInput {
                    assistant_message: &previous_assistant,
                    config,
                    request_shape: CompactionRequestShape {
                        system_prompt: &context.system_prompt,
                        tools: &tool_defs,
                        prompt_cache_key: context.prompt_cache_key.as_deref(),
                    },
                    phase: CompactionCheckPhase::BeforePrompt,
                },
                cancel.clone(),
                tx,
            )
            .await;
        }

        for prompt in initial_prompts {
            if matches!(prompt, AgentMessage::Llm(Message::User { .. })) {
                if let Some(controller) = compaction_controller.as_mut() {
                    controller.on_user_message();
                }
            }
            tx.send(AgentEvent::MessageStart {
                message: prompt.clone(),
            })
            .await
            .ok();
            tx.send(AgentEvent::MessageEnd {
                message: prompt.clone(),
            })
            .await
            .ok();
            context.messages.push(prompt);
        }
    }

    // A resumed session reaches its first run with a ledger the judge has
    // never seen. This boundary costs the same as a run end (the cache is
    // cold, the prompt is new), so the judge gets its first look here rather
    // than after the first response has already overflowed.
    if let Some(controller) = compaction_controller.as_ref() {
        if controller.prune_pending_first_ask().await {
            prune_after_run(
                &mut compaction_controller,
                &context_tracker,
                &mut context.messages,
                cancel.clone(),
                tx,
            )
            .await;
        }
    }

    // Tool calls the judge has not reviewed yet; reviewed in windows.
    let mut review_queue: Vec<crate::judge::relevance::ProposedCall> = Vec::new();

    // Check for steering messages at start
    let mut pending: Vec<AgentMessage> = config
        .get_steering_messages
        .as_ref()
        .map(|f| f())
        .unwrap_or_default();

    // Process provider turns until tools, steering, and follow-ups are drained.
    loop {
        if cancel.is_cancelled() {
            break;
        }

        let mut steering_after_tools: Option<Vec<AgentMessage>> = None;
        let mut turn_settled = false;

        if !first_turn {
            tx.send(AgentEvent::TurnStart).await.ok();
        } else {
            first_turn = false;
        }

        // Inject pending messages (steering / follow-up / initial prompt)
        let injected_count = pending.len();
        if !pending.is_empty() {
            for msg in pending.drain(..) {
                if matches!(msg, AgentMessage::Llm(Message::User { .. })) {
                    if let Some(controller) = compaction_controller.as_mut() {
                        controller.on_user_message();
                    }
                }
                tx.send(AgentEvent::MessageStart {
                    message: msg.clone(),
                })
                .await
                .ok();
                tx.send(AgentEvent::MessageEnd {
                    message: msg.clone(),
                })
                .await
                .ok();
                context.messages.push(msg.clone());
                new_messages.push(msg);
            }
        }

        // Check execution limits
        if let Some(ref tracker) = tracker {
            if let Some(reason) = tracker.check_limits() {
                let limit_msg = AgentMessage::Llm(Message::User {
                    provenance: Some(crate::InputProvenance::runtime(1, "execution_limit", None)),
                    content: vec![Content::Text {
                        text: format!("[Agent stopped: {}]", reason),
                    }],
                    timestamp: now_ms(),
                });
                tx.send(AgentEvent::MessageStart {
                    message: limit_msg.clone(),
                })
                .await
                .ok();
                tx.send(AgentEvent::MessageEnd {
                    message: limit_msg.clone(),
                })
                .await
                .ok();
                context.messages.push(limit_msg.clone());
                new_messages.push(limit_msg);
                break;
            }
        }

        // before_turn callback — abort if it returns false
        if let Some(ref before_turn) = config.before_turn {
            if !before_turn(&context.messages, turn_number) {
                break;
            }
        }
        turn_number += 1;

        let tool_defs = build_tool_definitions(context, &config.model);
        context_tracker.record_request_overhead(&context.system_prompt, &tool_defs);

        // Build budget snapshot for observability. Compaction itself follows
        // pi's response-driven policy and does not run before every tool or
        // retry call.
        let budget_snapshot = context_tracker.budget_snapshot(
            &context.messages,
            config.context_config.as_ref(),
            config.model_config.as_ref().map(|model| model.provider()),
            Some(&config.model),
        );

        // Stream assistant response
        let assistant_result =
            stream_assistant_response(context, config, tx, cancel, AssistantStreamInput {
                turn: turn_number,
                injected_count,
                budget: budget_snapshot,
                idle_clock: tracker.as_ref().map(ExecutionTracker::idle_clock),
            })
            .await;
        let message = assistant_result.message;

        // Preserve provider text so finalization cannot erase streamed content.
        let agent_msg: AgentMessage = message.clone().into();
        context.messages.push(agent_msg.clone());
        new_messages.push(agent_msg.clone());

        // Tool calls are extracted before compaction. A tool-use assistant
        // message must stay adjacent to its tool results; compacting before
        // results are appended creates orphaned pairs that provider APIs
        // reject.
        let tool_calls: Vec<_> = match &message {
            Message::Assistant { content, .. } => content
                .iter()
                .filter_map(|c| match c {
                    Content::ToolCall {
                        id,
                        name,
                        arguments,
                        ..
                    } => Some((id.clone(), name.clone(), arguments.clone())),
                    _ => None,
                })
                .collect(),
            _ => vec![],
        };

        let has_tool_calls = !tool_calls.is_empty();

        // Assistant responses always complete before run-end compaction is
        // evaluated, matching pi's agent_end-driven lifecycle. Overflow
        // recovery may remove the failed response from active context, but
        // the completed event remains available for transcript persistence.
        tx.send(AgentEvent::MessageEnd {
            message: agent_msg.clone(),
        })
        .await
        .ok();

        // Match pi's message_end lifecycle: every non-error assistant response
        // clears a prior overflow-recovery attempt before run-end compaction.
        if !matches!(message, Message::Assistant {
            stop_reason: StopReason::Error,
            ..
        }) {
            if let Some(controller) = compaction_controller.as_mut() {
                controller.on_non_error_response();
            }
        }

        // Check for error/abort
        if let Message::Assistant {
            ref stop_reason,
            ref error_message,
            ref usage,
            ..
        } = message
        {
            if *stop_reason == StopReason::Error || *stop_reason == StopReason::Aborted {
                // Emit unified Error event for provider errors (but not cancellations)
                if *stop_reason == StopReason::Error && !cancel.is_cancelled() {
                    let err_str = error_message
                        .as_deref()
                        .unwrap_or("Unknown error")
                        .to_string();
                    tx.send(AgentEvent::Error {
                        error: AgentErrorInfo {
                            kind: AgentErrorKind::Provider,
                            message: err_str,
                        },
                    })
                    .await
                    .ok();
                }
                // Call after_turn even on error/abort so callers tracking usage don't miss this turn
                if let Some(ref after_turn) = config.after_turn {
                    after_turn(&context.messages, usage);
                }
                tx.send(AgentEvent::TurnEnd {
                    message: agent_msg,
                    tool_results: vec![],
                })
                .await
                .ok();

                let should_retry = check_compaction(
                    &mut compaction_controller,
                    &mut context_tracker,
                    &mut context.messages,
                    CompactionCheckInput {
                        assistant_message: &message,
                        config,
                        request_shape: CompactionRequestShape {
                            system_prompt: &context.system_prompt,
                            tools: &tool_defs,
                            prompt_cache_key: context.prompt_cache_key.as_deref(),
                        },
                        phase: CompactionCheckPhase::RunEnd,
                    },
                    cancel.clone(),
                    tx,
                )
                .await;
                if should_retry {
                    // The failed assistant remains in emitted transcript
                    // events, but not in active context or this run's result.
                    new_messages.pop();
                    continue;
                }
                break;
            }
        }

        // Doom-loop detection: if the same tool batch repeats >= threshold
        // times, skip execution and inject a steering message instead.
        if has_tool_calls {
            if let Some(intervention) = doom_detector.check(&tool_calls) {
                let mut tool_results = Vec::new();
                for (id, name, args) in &tool_calls {
                    let result = skip_tool_call_doom_loop(id, name, args, tx).await;
                    let am: AgentMessage = result.clone().into();
                    context.messages.push(am.clone());
                    new_messages.push(am);
                    tool_results.push(result);
                }
                pending.push(intervention.steering_message);

                // Track turn + emit TurnEnd, then continue inner loop.
                if let Some(ref mut tracker) = tracker {
                    let turn_tokens = match &message {
                        Message::Assistant { usage, .. } => usage.context_tokens() as usize,
                        _ => context::message_tokens(&agent_msg),
                    };
                    tracker.record_turn(turn_tokens);
                }
                if let Some(ref after_turn) = config.after_turn {
                    let usage = match &message {
                        Message::Assistant { usage, .. } => usage.clone(),
                        _ => Usage::default(),
                    };
                    after_turn(&context.messages, &usage);
                }
                tx.send(AgentEvent::TurnEnd {
                    message: agent_msg,
                    tool_results,
                })
                .await
                .ok();
                continue;
            }
        }

        let mut tool_results = Vec::new();
        if has_tool_calls {
            if matches!(message, Message::Assistant {
                stop_reason: StopReason::Length,
                ..
            }) {
                // A length-limited response can contain arguments salvaged by
                // provider JSON repair. They may parse successfully while
                // still being incomplete, so fail the whole batch and let the
                // model re-issue it rather than executing corrupted input.
                tool_results = fail_truncated_tool_calls(&tool_calls, tx).await;
            } else {
                // Every REVIEW_WINDOW calls the judge reviews that window in
                // the background: one request, independent of the main model,
                // nothing waits for it. The UI speaks up only when the window
                // looks off-task.
                if let Some(judge) = config.judge.clone() {
                    review_queue.extend(tool_calls.iter().cloned());
                    while review_queue.len() >= crate::judge::relevance::REVIEW_WINDOW {
                        let window: Vec<_> = review_queue
                            .drain(..crate::judge::relevance::REVIEW_WINDOW)
                            .collect();
                        let state = crate::judge::relevance::relevance_state(&context.messages);
                        let (judge, review_tx, review_cancel) =
                            (judge.clone(), tx.clone(), cancel.clone());
                        tokio::spawn(async move {
                            if let Some(calls) = crate::judge::relevance::review_window(
                                judge,
                                state,
                                window,
                                review_cancel,
                            )
                            .await
                            {
                                review_tx
                                    .send(AgentEvent::ToolCallsReviewed { calls })
                                    .await
                                    .ok();
                            }
                        });
                    }
                }
                let idle_clock = tracker.as_ref().map(|t| t.idle_clock());
                let execution = execute_tool_calls(
                    &context.tools,
                    &tool_calls,
                    tx,
                    cancel,
                    config.get_steering_messages.as_ref(),
                    &config.tool_execution,
                    &context.cwd,
                    &context.path_guard,
                    &config.spill,
                    idle_clock.as_ref(),
                    config
                        .model_config
                        .as_ref()
                        .map(|m| m.supports_image())
                        .unwrap_or(true),
                )
                .await;

                tool_results = execution.tool_results;
                steering_after_tools = execution.steering_messages;
            }

            turn_settled = settles_run(&context.tools, &tool_calls, &tool_results);

            for result in &tool_results {
                let am: AgentMessage = result.clone().into();
                context.messages.push(am.clone());
                new_messages.push(am);
            }

            if steering_after_tools.is_none() {
                let steering = config
                    .get_steering_messages
                    .as_ref()
                    .map(|f| f())
                    .unwrap_or_default();
                if !steering.is_empty() {
                    steering_after_tools = Some(steering);
                }
            }
        }

        // Track turn for execution limits
        if let Some(ref mut tracker) = tracker {
            let turn_tokens = match &message {
                Message::Assistant { usage, .. } => usage.context_tokens() as usize,
                _ => context::message_tokens(&agent_msg),
            };
            tracker.record_turn(turn_tokens);
        }

        // after_turn callback
        if let Some(ref after_turn) = config.after_turn {
            let usage = match &message {
                Message::Assistant { usage, .. } => usage.clone(),
                _ => Usage::default(),
            };
            after_turn(&context.messages, &usage);
        }

        tx.send(AgentEvent::TurnEnd {
            message: agent_msg,
            tool_results,
        })
        .await
        .ok();

        // A tool turn that has grown the active context to the summary
        // threshold compacts here, before the next provider call, instead of
        // waiting for run end or a provider overflow. Threshold compaction
        // never asks for a retry; the fresh tool results stay in context.
        // Below the line the controller only sees the usage, which re-arms
        // threshold compaction after a previous one.
        if has_tool_calls && !cancel.is_cancelled() {
            if super::compaction_check::tool_turn_needs_compaction_check(
                &compaction_controller,
                &context_tracker,
                &context.messages,
            ) {
                check_compaction(
                    &mut compaction_controller,
                    &mut context_tracker,
                    &mut context.messages,
                    CompactionCheckInput {
                        assistant_message: &message,
                        config,
                        request_shape: CompactionRequestShape {
                            system_prompt: &context.system_prompt,
                            tools: &tool_defs,
                            prompt_cache_key: context.prompt_cache_key.as_deref(),
                        },
                        phase: CompactionCheckPhase::ToolTurn,
                    },
                    cancel.clone(),
                    tx,
                )
                .await;
            } else {
                super::compaction_check::note_tool_turn_usage(
                    &mut compaction_controller,
                    config,
                    &message,
                );
            }
        }

        // Continue the current run while tool work or steering remains.
        if let Some(steering) = steering_after_tools.take() {
            if !steering.is_empty() {
                pending = steering;
                continue;
            }
        }
        if !pending.is_empty() {
            continue;
        }
        pending = config
            .get_steering_messages
            .as_ref()
            .map(|f| f())
            .unwrap_or_default();
        if !pending.is_empty() || (has_tool_calls && !turn_settled) {
            continue;
        }

        // A thinking-only response gets one internal nudge before the run
        // is considered settled.
        if let Some(nudge) = thinking_only_guard.check(&message, false) {
            pending = vec![nudge];
            continue;
        }

        // Follow-ups are part of the same run and must drain before the
        // final assistant response is considered for compaction.
        let follow_ups = config
            .get_follow_up_messages
            .as_ref()
            .map(|f| f())
            .unwrap_or_default();
        if !follow_ups.is_empty() {
            pending = follow_ups;
            continue;
        }

        let should_retry = check_compaction(
            &mut compaction_controller,
            &mut context_tracker,
            &mut context.messages,
            CompactionCheckInput {
                assistant_message: &message,
                config,
                request_shape: CompactionRequestShape {
                    system_prompt: &context.system_prompt,
                    tools: &tool_defs,
                    prompt_cache_key: context.prompt_cache_key.as_deref(),
                },
                phase: CompactionCheckPhase::RunEnd,
            },
            cancel.clone(),
            tx,
        )
        .await;
        if should_retry {
            // Keep the completed failed response in transcript events, but
            // retry from the compacted active context.
            new_messages.pop();
            continue;
        }
        prune_after_run(
            &mut compaction_controller,
            &context_tracker,
            &mut context.messages,
            cancel.clone(),
            tx,
        )
        .await;
        break;
    }

    compaction_controller
        .map(|controller| controller.state().clone())
        .or_else(|| config.initial_compaction_state.clone())
}

/// A tool turn settles the run when every call went to an `ends_turn` tool
/// and none of them failed. The results are recorded but the model is not
/// asked for a follow-up: there is nothing new for it to act on, and some
/// providers answer that prompt with an empty completion.
fn settles_run(
    tools: &[Box<dyn AgentTool>],
    tool_calls: &[(String, String, serde_json::Value)],
    tool_results: &[Message],
) -> bool {
    if tool_calls.is_empty() {
        return false;
    }
    let all_end_turn = tool_calls.iter().all(|(_, name, _)| {
        tools
            .iter()
            .find(|t| t.matches_call_name(name))
            .is_some_and(|t| t.ends_turn())
    });
    all_end_turn
        && tool_results
            .iter()
            .all(|r| !matches!(r, Message::ToolResult { is_error: true, .. }))
}

/// The judge-driven prune branch at run end: the run is over and the next
/// request is a fresh user prompt, so pending edits land here at the latest.
async fn prune_after_run(
    controller: &mut Option<crate::context::CompactionController>,
    tracker: &ContextTracker,
    messages: &mut Vec<AgentMessage>,
    cancel: tokio_util::sync::CancellationToken,
    tx: &EventSink,
) {
    let Some(controller) = controller.as_mut().filter(|c| c.has_judge()) else {
        return;
    };
    let context_tokens = crate::context::tokens::total_tokens(messages)
        .saturating_add(tracker.system_tool_overhead_tokens());
    let outcome = controller
        .prune_step(
            messages,
            context_tokens,
            crate::context::compaction::ApplyTrigger::RunEnd,
            crate::context::now_ms(),
            cancel,
        )
        .await;
    emit_context_pruned(controller, messages, outcome, tx).await;
}

/// The `ContextPruned` event for one prune step, when it did anything.
pub(crate) async fn emit_context_pruned(
    controller: &crate::context::CompactionController,
    messages: &[AgentMessage],
    outcome: crate::context::compaction::PruneOutcome,
    tx: &EventSink,
) {
    if outcome.decided.is_none() && outcome.applied.is_none() {
        return;
    }
    tx.send(AgentEvent::ContextPruned {
        decided: outcome.decided,
        applied: outcome.applied,
        messages: messages.to_vec(),
        state: controller.state().clone(),
        context_window: controller.config().displayed_window(),
    })
    .await
    .ok();
}
