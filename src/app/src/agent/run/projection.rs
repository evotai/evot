//! Engine-to-application event projection. No session I/O, provider construction,
//! channel ownership or lifecycle decisions belong here. Projection order is
//! significant: persistence signals precede their corresponding public events.

use crate::observability::ContextCompactionStartedStats;
use crate::observability::LlmCallCompletedStats;
use crate::observability::LlmCallRetryStats;
use crate::observability::LlmCallStartedStats;
use crate::observability::ToolDef;
use crate::observability::ToolFinishedStats;
use crate::observability::TranscriptStats;
use crate::session::conversation::convert::assistant_blocks_from_content;
use crate::session::conversation::convert::extract_content_text;
use crate::session::conversation::convert::from_agent_messages;
use crate::session::conversation::convert::total_usage;
use crate::session::conversation::convert::transcript_from_agent_message;
use crate::session::conversation::run_event::AssistantContentType;
use crate::session::conversation::run_event::LlmMessageStats;
use crate::session::conversation::run_event::LlmToolCallSummary;
use crate::session::conversation::run_event::RunEventPayload;
use crate::session::conversation::run_event::ToolCallStreamPhase;
use crate::types::LlmCallMetrics;
use crate::types::TranscriptItem;
use crate::types::UsageSummary;

// ---------------------------------------------------------------------------
// RuntimeEvent — private orchestration signal
// ---------------------------------------------------------------------------

pub enum RuntimeEvent {
    Public(RunEventPayload),
    Transcript(TranscriptItem),
    TurnStarted,
    TurnEnded,
    EngineCompleted {
        last_text: String,
        usage: UsageSummary,
        transcript_count: usize,
    },
    CompactionCompleted {
        reason: crate::types::CompactReason,
        result: crate::observability::CompactionResult,
        summary: Option<String>,
        messages: Vec<evot_engine::AgentMessage>,
        state: evot_engine::CompactionState,
        context_window: usize,
        will_retry: bool,
    },
}

/// Map a single `AgentEvent` to zero or more `RuntimeEvent`s.
pub fn map_agent_event(event: &evot_engine::AgentEvent) -> Vec<RuntimeEvent> {
    match event {
        evot_engine::AgentEvent::AgentStart => vec![],

        evot_engine::AgentEvent::QuotaWait { delay_ms, error } => {
            vec![RuntimeEvent::Public(RunEventPayload::QuotaWaiting {
                delay_ms: *delay_ms,
                error: error.clone(),
            })]
        }

        evot_engine::AgentEvent::OutageWait { delay_ms, error } => {
            vec![RuntimeEvent::Public(RunEventPayload::OutageWaiting {
                delay_ms: *delay_ms,
                error: error.clone(),
            })]
        }

        evot_engine::AgentEvent::AgentEnd { messages } => {
            let transcripts = from_agent_messages(messages);
            let usage = total_usage(messages);
            let transcript_count = messages.len();

            let last_text = transcripts
                .iter()
                .rev()
                .find_map(|t| {
                    if let TranscriptItem::Assistant { content, .. } = t {
                        let text = crate::types::assistant_text(content);
                        if !text.is_empty() {
                            return Some(text);
                        }
                    }
                    None
                })
                .unwrap_or_default();

            vec![RuntimeEvent::EngineCompleted {
                last_text,
                usage,
                transcript_count,
            }]
        }

        evot_engine::AgentEvent::TurnStart => {
            vec![
                RuntimeEvent::TurnStarted,
                RuntimeEvent::Public(RunEventPayload::TurnStarted {}),
            ]
        }

        evot_engine::AgentEvent::TurnEnd { .. } => {
            vec![RuntimeEvent::TurnEnded]
        }

        evot_engine::AgentEvent::MessageStart { .. } => vec![],

        evot_engine::AgentEvent::MessageUpdate {
            delta:
                evot_engine::StreamDelta::Text {
                    content_index,
                    delta,
                },
            ..
        } => vec![RuntimeEvent::Public(RunEventPayload::AssistantDelta {
            content_index: *content_index,
            content_type: AssistantContentType::Text,
            delta: delta.clone(),
        })],

        evot_engine::AgentEvent::MessageUpdate {
            delta:
                evot_engine::StreamDelta::Thinking {
                    content_index,
                    delta,
                },
            ..
        } => vec![RuntimeEvent::Public(RunEventPayload::AssistantDelta {
            content_index: *content_index,
            content_type: AssistantContentType::Thinking,
            delta: delta.clone(),
        })],

        evot_engine::AgentEvent::MessageUpdate {
            delta:
                evot_engine::StreamDelta::ToolCallStart {
                    content_index,
                    id,
                    name,
                },
            ..
        } => vec![RuntimeEvent::Public(RunEventPayload::AssistantToolCall {
            content_index: *content_index,
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            phase: ToolCallStreamPhase::Start,
            delta: None,
            args: None,
        })],

        evot_engine::AgentEvent::MessageUpdate {
            delta:
                evot_engine::StreamDelta::ToolCallDelta {
                    content_index,
                    id,
                    name,
                    delta,
                },
            ..
        } => vec![RuntimeEvent::Public(RunEventPayload::AssistantToolCall {
            content_index: *content_index,
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            phase: ToolCallStreamPhase::Delta,
            delta: Some(delta.clone()),
            args: None,
        })],

        evot_engine::AgentEvent::MessageUpdate {
            delta:
                evot_engine::StreamDelta::ToolCallEnd {
                    content_index,
                    id,
                    name,
                    arguments,
                },
            ..
        } => vec![RuntimeEvent::Public(RunEventPayload::AssistantToolCall {
            content_index: *content_index,
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            phase: ToolCallStreamPhase::End,
            delta: None,
            args: Some(arguments.clone()),
        })],

        evot_engine::AgentEvent::MessageEnd { message } => {
            if let evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
                content,
                usage,
                stop_reason,
                error_message,
                ..
            }) = message
            {
                let blocks = assistant_blocks_from_content(content);
                let usage_summary = UsageSummary {
                    input: usage.input,
                    output: usage.output,
                    cache_read: usage.cache_read,
                    cache_write: usage.cache_write,
                };
                let transcript_item = transcript_from_agent_message(message);

                vec![
                    RuntimeEvent::Transcript(transcript_item),
                    RuntimeEvent::Public(RunEventPayload::AssistantCompleted {
                        content: blocks,
                        usage: Some(usage_summary),
                        stop_reason: stop_reason.to_string(),
                        error_message: error_message.clone(),
                    }),
                ]
            } else if matches!(
                message,
                evot_engine::AgentMessage::Llm(evot_engine::Message::User { .. })
            ) {
                // Initial prompts and admitted steering/follow-up messages share
                // this boundary. Persist all of them in engine order, once.
                vec![RuntimeEvent::Transcript(transcript_from_agent_message(
                    message,
                ))]
            } else {
                vec![]
            }
        }

        evot_engine::AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
            preview_command,
        } => vec![RuntimeEvent::Public(RunEventPayload::ToolStarted {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            args: args.clone(),
            preview_command: preview_command.clone(),
        })],

        evot_engine::AgentEvent::ToolExecutionUpdate {
            tool_call_id,
            tool_name,
            partial_result,
        } => {
            let text = extract_content_text(&partial_result.content);
            vec![RuntimeEvent::Public(RunEventPayload::ToolProgress {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                text,
                details: partial_result.details.clone(),
            })]
        }

        evot_engine::AgentEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
            result_tokens,
            duration_ms,
        } => {
            let content = extract_content_text(&result.content);
            vec![
                RuntimeEvent::Transcript(TranscriptItem::ToolResult {
                    tool_call_id: tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    content: content.clone(),
                    is_error: *is_error,
                    details: result.details.clone(),
                }),
                RuntimeEvent::Transcript(
                    TranscriptStats::ToolFinished(ToolFinishedStats {
                        tool_call_id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        result_tokens: *result_tokens,
                        duration_ms: *duration_ms,
                        is_error: *is_error,
                    })
                    .to_item(),
                ),
                RuntimeEvent::Public(RunEventPayload::ToolFinished {
                    tool_call_id: tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    content,
                    is_error: *is_error,
                    details: result.details.clone(),
                    result_tokens: *result_tokens,
                    duration_ms: *duration_ms,
                }),
            ]
        }

        evot_engine::AgentEvent::ProgressMessage {
            tool_call_id,
            tool_name,
            text,
        } => vec![RuntimeEvent::Public(RunEventPayload::ToolProgress {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            text: text.clone(),
            details: serde_json::Value::Null,
        })],

        evot_engine::AgentEvent::Error { error } => {
            vec![RuntimeEvent::Public(RunEventPayload::Error {
                message: error.message.clone(),
            })]
        }

        evot_engine::AgentEvent::LlmCallStart {
            turn,
            attempt,
            injected_count,
            request,
            stats,
            budget,
        } => {
            let message_count = request.messages.len();
            let tool_count = request.tools.len();

            // Compute message_bytes for transcript (still needs serialization)
            let message_bytes: usize = request
                .messages
                .iter()
                .map(|msg| serialize_or_placeholder(msg, "message").to_string().len())
                .sum();

            let message_stats = Some(LlmMessageStats::from(stats.clone()));

            vec![
                RuntimeEvent::Transcript(
                    TranscriptStats::LlmCallStarted(LlmCallStartedStats {
                        turn: *turn,
                        attempt: *attempt,
                        injected_count: *injected_count,
                        model: request.model.clone(),
                        thinking_level: request.thinking_level.as_str().into(),
                        message_count,
                        message_bytes,
                        system_prompt_tokens: budget.system_prompt_tokens,
                        tool_definition_tokens: budget.tool_definition_tokens,
                        system_prompt: request.system_prompt.clone(),
                        tool_definitions: request
                            .tools
                            .iter()
                            .map(|t| ToolDef {
                                name: t.name.clone(),
                                description: t.description.clone(),
                                parameters: t.parameters.clone(),
                            })
                            .collect(),
                    })
                    .to_item(),
                ),
                RuntimeEvent::Public(RunEventPayload::LlmCallStarted {
                    turn: *turn,
                    attempt: *attempt,
                    injected_count: *injected_count,
                    model: request.model.clone(),
                    message_count,
                    message_bytes,
                    estimated_context_tokens: budget.estimated_tokens,
                    system_prompt_tokens: budget.system_prompt_tokens,
                    tool_definition_tokens: budget.tool_definition_tokens,
                    tool_count,
                    message_stats,
                    budget_tokens: budget.budget_tokens,
                    context_window: budget.context_window,
                }),
            ]
        }

        evot_engine::AgentEvent::LlmCallRetry {
            turn,
            attempt,
            max_retries,
            delay_ms,
            error,
        } => {
            vec![
                RuntimeEvent::Transcript(
                    TranscriptStats::LlmCallRetry(LlmCallRetryStats {
                        turn: *turn,
                        attempt: *attempt,
                        max_retries: *max_retries,
                        delay_ms: *delay_ms,
                        error: error.clone(),
                    })
                    .to_item(),
                ),
                RuntimeEvent::Public(RunEventPayload::LlmCallRetry {
                    turn: *turn,
                    attempt: *attempt,
                    max_retries: *max_retries,
                    delay_ms: *delay_ms,
                    error: error.clone(),
                }),
            ]
        }

        evot_engine::AgentEvent::LlmCallEnd {
            turn,
            attempt,
            usage,
            error,
            metrics,
            context_window,
            stop_reason,
            content,
            response_model,
            response_id: _,
        } => {
            let usage_summary = UsageSummary {
                input: usage.input,
                output: usage.output,
                cache_read: usage.cache_read,
                cache_write: usage.cache_write,
            };
            let llm_metrics = LlmCallMetrics {
                duration_ms: metrics.duration_ms,
                ttfb_ms: metrics.ttfb_ms,
                ttft_ms: metrics.ttft_ms,
                streaming_ms: metrics.streaming_ms,
                chunk_count: metrics.chunk_count,
            };
            // Extract tool call summaries for the public event
            let tool_calls: Vec<LlmToolCallSummary> = content
                .iter()
                .filter_map(|c| match c {
                    evot_engine::Content::ToolCall {
                        id,
                        name,
                        arguments,
                        ..
                    } => Some(LlmToolCallSummary {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    }),
                    _ => None,
                })
                .collect();
            vec![
                RuntimeEvent::Transcript(
                    TranscriptStats::LlmCallCompleted(LlmCallCompletedStats {
                        turn: *turn,
                        attempt: *attempt,
                        usage: usage_summary.clone(),
                        metrics: Some(llm_metrics.clone()),
                        error: error.clone(),
                        context_window: *context_window,
                        stop_reason: stop_reason.to_string(),
                    })
                    .to_item(),
                ),
                RuntimeEvent::Public(RunEventPayload::LlmCallCompleted {
                    turn: *turn,
                    attempt: *attempt,
                    usage: usage_summary.clone(),
                    cache_read: usage_summary.cache_read,
                    cache_write: usage_summary.cache_write,
                    error: error.clone(),
                    metrics: Some(llm_metrics),
                    context_window: *context_window,
                    stop_reason: stop_reason.to_string(),
                    tool_calls: if tool_calls.is_empty() {
                        None
                    } else {
                        Some(tool_calls)
                    },
                    response_model: response_model.clone(),
                }),
            ]
        }

        evot_engine::AgentEvent::ContextCompactionStarted {
            reason,
            estimated_tokens,
            context_window,
            reserve_tokens,
            trigger_threshold,
            will_retry,
        } => {
            let reason = map_compact_reason(*reason);
            vec![
                RuntimeEvent::Transcript(
                    TranscriptStats::ContextCompactionStarted(ContextCompactionStartedStats {
                        reason: reason.clone(),
                        message_count: 0,
                        estimated_tokens: *estimated_tokens,
                        budget_tokens: context_window.saturating_sub(*reserve_tokens),
                        reserve_tokens: *reserve_tokens,
                        trigger_threshold: *trigger_threshold,
                        system_prompt_tokens: 0,
                        tool_definition_tokens: 0,
                        context_window: *context_window,
                        will_retry: *will_retry,
                    })
                    .to_item(),
                ),
                RuntimeEvent::Public(RunEventPayload::ContextCompactionStarted {
                    reason,
                    message_count: 0,
                    estimated_tokens: *estimated_tokens,
                    budget_tokens: context_window.saturating_sub(*reserve_tokens),
                    reserve_tokens: *reserve_tokens,
                    trigger_threshold: *trigger_threshold,
                    system_prompt_tokens: 0,
                    tool_definition_tokens: 0,
                    context_window: *context_window,
                    will_retry: *will_retry,
                    message_stats: None,
                }),
            ]
        }

        evot_engine::AgentEvent::ContextCompactionPhase { phase, activity } => {
            vec![RuntimeEvent::Public(
                RunEventPayload::ContextCompactionPhase {
                    phase: *phase,
                    activity: *activity,
                },
            )]
        }

        evot_engine::AgentEvent::ContextCompactionEnd {
            reason,
            stats,
            messages,
            state,
            summary,
            context_window,
            will_retry,
        } => {
            let result = if stats.messages_evicted > 0 || stats.current_run_reclaimed > 0 {
                crate::observability::CompactionResult::Compacted {
                    before_message_count: stats.before_message_count,
                    after_message_count: stats.after_message_count,
                    before_tokens: stats.before_tokens,
                    after_tokens: stats.after_tokens,
                    messages_evicted: stats.messages_evicted,
                    current_run_reclaimed: stats.current_run_reclaimed,
                    method: stats.method,
                    remote_blob_bytes: None,
                    fallback_reason: None,
                }
            } else {
                crate::observability::CompactionResult::NoOp
            };

            let reason = map_compact_reason(*reason);
            vec![
                RuntimeEvent::CompactionCompleted {
                    reason: reason.clone(),
                    result: result.clone(),
                    summary: summary.clone(),
                    messages: messages.clone(),
                    state: state.clone(),
                    context_window: *context_window,
                    will_retry: *will_retry,
                },
                RuntimeEvent::Public(RunEventPayload::ContextCompactionCompleted {
                    reason,
                    result,
                    summary: summary.clone(),
                    context_window: *context_window,
                    will_retry: *will_retry,
                }),
            ]
        }
    }
}

fn map_compact_reason(reason: evot_engine::CompactReason) -> crate::types::CompactReason {
    match reason {
        evot_engine::CompactReason::Threshold => crate::types::CompactReason::Threshold,
        evot_engine::CompactReason::Overflow => crate::types::CompactReason::Overflow,
        evot_engine::CompactReason::Manual => crate::types::CompactReason::Manual,
        evot_engine::CompactReason::Refusal => crate::types::CompactReason::Refusal,
    }
}

fn serialize_or_placeholder<T: serde::Serialize>(value: &T, kind: &str) -> serde_json::Value {
    match serde_json::to_value(value) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("failed to serialize {kind}: {e}");
            serde_json::json!({
                "type": "serialization_error",
                "kind": kind,
                "message": e.to_string(),
            })
        }
    }
}
