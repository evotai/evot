//! Stream an assistant response from the LLM, with retry and SSE forwarding.

use tokio::sync::mpsc;

use super::config::AgentLoopConfig;
use super::event_sink::EventSink;
use super::tool_exec::build_tool_definitions;
use crate::event::AgentEvent;
use crate::event::LlmCallRequest;
use crate::event::StreamDelta;
use crate::provider::ApiProtocol;
use crate::provider::ProviderError;
use crate::provider::StreamConfig;
use crate::provider::StreamEvent;
use crate::time::now_ms;
use crate::types::*;

/// Quota recovery is controlled locally so every provider follows the same
/// predictable, cancellable probe cadence.
const QUOTA_PROBE_INITIAL: std::time::Duration = std::time::Duration::from_secs(5);
const QUOTA_PROBE_MAX: std::time::Duration = std::time::Duration::from_secs(60);

/// Probe cadence once the bounded retry budget is exhausted but the error is
/// still retryable (sustained upstream/gateway outage). Like quota waits, the
/// probes are cancellable and run indefinitely — an outage is a wait state,
/// not a reason to discard the run.
const OUTAGE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(60);

/// Network recovery must not wait behind a minute-long service-outage backoff.
/// Keep reconnect probes frequent even after the bounded retry budget runs out;
/// explicit quota and server failures retain their calmer existing cadence.
const NETWORK_RETRY_MAX_DELAY: std::time::Duration = std::time::Duration::from_secs(10);

/// A missing protocol terminal event can be a one-off upstream generation
/// failure, but identical replays often reproduce it (for example malformed
/// tool arguments). Keep recovery quick and bounded instead of treating it as
/// a sustained network outage.
const PROTOCOL_INCOMPLETE_MAX_RETRIES: usize = 2;

/// Default convert_to_llm: keep only user/assistant/toolResult messages.
fn default_convert_to_llm(messages: &[AgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .filter_map(|m| m.as_llm().cloned())
        .collect()
}

pub(super) struct AssistantStreamResult {
    pub message: Message,
}

impl AssistantStreamResult {
    fn complete(message: Message) -> Self {
        Self { message }
    }
}

pub(super) struct AssistantStreamInput {
    pub turn: usize,
    pub injected_count: usize,
    pub budget: crate::context::ContextBudgetSnapshot,
    pub idle_clock: Option<crate::context::IdleClock>,
}

/// Stream an assistant response from the LLM.
pub(super) async fn stream_assistant_response(
    context: &AgentContext,
    config: &AgentLoopConfig,
    tx: &EventSink,
    cancel: &tokio_util::sync::CancellationToken,
    input: AssistantStreamInput,
) -> AssistantStreamResult {
    let AssistantStreamInput {
        turn,
        injected_count,
        budget,
        idle_clock,
    } = input;
    // Apply context transform
    let messages = if let Some(transform) = &config.transform_context {
        transform(context.messages.clone())
    } else {
        context.messages.clone()
    };

    // Convert to LLM messages
    let convert = config.convert_to_llm.as_ref();
    let llm_messages = match convert {
        Some(f) => f(&messages),
        None => default_convert_to_llm(&messages),
    };
    // Normalize tool exchanges after custom conversion, then provider-opaque
    // history at the LLM boundary. Replayable
    // thinking survives only for the exact provider/model/protocol that emitted
    // it; foreign thinking is retained as ordinary text context.
    let (target_provider, target_model, target_api) = target_model(config);
    let mut llm_messages = crate::context::transform_messages_for_model(
        llm_messages,
        &target_provider,
        &target_model,
        target_api,
    );

    // Build tool definitions
    let tool_defs = build_tool_definitions(context, &config.model);
    if let Some(reminder) =
        crate::context::tool_availability_reminder(&llm_messages, &context.tools)
    {
        llm_messages.push(reminder);
    }

    // Retry loop for transient provider errors
    let retry = &config.retry_policy;
    let mut attempt = 0;
    // Set once the call enters a cancellable long-wait (quota or outage).
    // Re-probes remain part of the same logical call: no further
    // LlmCallStart events are emitted until the call resolves.
    let mut long_wait_started = false;
    let mut quota_probe_delay = QUOTA_PROBE_INITIAL;
    let shared_metrics = std::sync::Arc::new(std::sync::Mutex::new(LlmCallMetrics::default()));
    let result = loop {
        let thinking_level = crate::provider::effective_thinking_level(
            config.thinking_level,
            config.model_config.as_ref(),
        );

        let stream_config = StreamConfig {
            model: config.model.clone(),
            system_prompt: context.system_prompt.clone(),
            messages: llm_messages.clone(),
            tools: tool_defs.clone(),
            thinking_level,
            api_key: config.api_key.clone(),
            max_tokens: config.max_tokens,
            model_config: config.model_config.clone(),
            cache_config: config.cache_config.clone(),
            prompt_cache_key: context.prompt_cache_key.clone(),
            client: None,
        };

        // Emit one logical call start. Long-wait re-probes (quota/outage)
        // remain part of this call so they do not churn observability or the
        // TUI status line.
        if !long_wait_started {
            let llm_stats = crate::context::compute_call_stats(&llm_messages);
            tx.send(AgentEvent::LlmCallStart {
                turn,
                attempt,
                injected_count,
                request: LlmCallRequest {
                    model: config.model.clone(),
                    thinking_level,
                    system_prompt: context.system_prompt.clone(),
                    messages: llm_messages.clone(),
                    tools: tool_defs.clone(),
                    max_tokens: config.max_tokens,
                },
                stats: llm_stats,
                budget: budget.clone(),
            })
            .await
            .ok();
        }

        let call_start = std::time::Instant::now();
        let (stream_tx, mut stream_rx) = mpsc::channel(64);
        let provider_cancel = cancel.clone();

        // Reset metrics for this attempt.
        if let Ok(mut m) = shared_metrics.lock() {
            *m = LlmCallMetrics::default();
        }
        let metrics_handle = shared_metrics.clone();

        // Spawn a task to forward events in real-time as the provider streams
        let event_tx = tx.clone();
        let model_for_events = config.model.clone();
        let forward_handle = tokio::spawn(async move {
            let mut partial_message: Option<AgentMessage> = None;
            let mut first_delta_seen = false;
            let mut chunk_count: u64 = 0;
            while let Some(event) = stream_rx.recv().await {
                match &event {
                    StreamEvent::Start => {
                        if let Ok(mut m) = metrics_handle.lock() {
                            m.ttfb_ms = call_start.elapsed().as_millis() as u64;
                        }
                        let placeholder = AgentMessage::Llm(Message::Assistant {
                            content: Vec::new(),
                            stop_reason: StopReason::Stop,
                            model: model_for_events.clone(),
                            provider: String::new(),
                            usage: Usage::default(),
                            timestamp: now_ms(),
                            error_message: None,
                            response_id: None,
                        });
                        partial_message = Some(placeholder.clone());
                        event_tx
                            .send(AgentEvent::MessageStart {
                                message: placeholder,
                            })
                            .await
                            .ok();
                    }
                    StreamEvent::TextDelta {
                        content_index,
                        delta,
                    } => {
                        if !first_delta_seen {
                            first_delta_seen = true;
                            if let Ok(mut m) = metrics_handle.lock() {
                                m.ttft_ms = call_start.elapsed().as_millis() as u64;
                            }
                        }
                        chunk_count += 1;
                        if let Some(ref msg) = partial_message {
                            event_tx
                                .send(AgentEvent::MessageUpdate {
                                    message: msg.clone(),
                                    delta: StreamDelta::Text {
                                        content_index: *content_index,
                                        delta: delta.clone(),
                                    },
                                })
                                .await
                                .ok();
                        }
                    }
                    StreamEvent::ThinkingDelta {
                        content_index,
                        delta,
                    } => {
                        if !first_delta_seen {
                            first_delta_seen = true;
                            if let Ok(mut m) = metrics_handle.lock() {
                                m.ttft_ms = call_start.elapsed().as_millis() as u64;
                            }
                        }
                        chunk_count += 1;
                        if let Some(ref msg) = partial_message {
                            event_tx
                                .send(AgentEvent::MessageUpdate {
                                    message: msg.clone(),
                                    delta: StreamDelta::Thinking {
                                        content_index: *content_index,
                                        delta: delta.clone(),
                                    },
                                })
                                .await
                                .ok();
                        }
                    }
                    StreamEvent::ToolCallStart {
                        content_index,
                        id,
                        name,
                    } => {
                        chunk_count += 1;
                        if let Some(ref msg) = partial_message {
                            event_tx
                                .send(AgentEvent::MessageUpdate {
                                    message: msg.clone(),
                                    delta: StreamDelta::ToolCallStart {
                                        content_index: *content_index,
                                        id: id.clone(),
                                        name: name.clone(),
                                    },
                                })
                                .await
                                .ok();
                        }
                    }
                    StreamEvent::ToolCallDelta {
                        content_index,
                        id,
                        name,
                        delta,
                    } => {
                        chunk_count += 1;
                        if let Some(ref msg) = partial_message {
                            event_tx
                                .send(AgentEvent::MessageUpdate {
                                    message: msg.clone(),
                                    delta: StreamDelta::ToolCallDelta {
                                        content_index: *content_index,
                                        id: id.clone(),
                                        name: name.clone(),
                                        delta: delta.clone(),
                                    },
                                })
                                .await
                                .ok();
                        }
                    }
                    StreamEvent::ToolCallEnd {
                        content_index,
                        id,
                        name,
                        arguments,
                    } => {
                        chunk_count += 1;
                        if let Some(ref msg) = partial_message {
                            event_tx
                                .send(AgentEvent::MessageUpdate {
                                    message: msg.clone(),
                                    delta: StreamDelta::ToolCallEnd {
                                        content_index: *content_index,
                                        id: id.clone(),
                                        name: name.clone(),
                                        arguments: arguments.clone(),
                                    },
                                })
                                .await
                                .ok();
                        }
                    }
                    StreamEvent::Done { message } => {
                        let elapsed = call_start.elapsed().as_millis() as u64;
                        if let Ok(mut m) = metrics_handle.lock() {
                            m.duration_ms = elapsed;
                            if first_delta_seen {
                                m.streaming_ms = elapsed.saturating_sub(m.ttft_ms);
                            }
                            m.chunk_count = chunk_count;
                        }
                        if partial_message.is_none() {
                            let am: AgentMessage = message.clone().into();
                            event_tx
                                .send(AgentEvent::MessageStart { message: am })
                                .await
                                .ok();
                        }
                    }
                    StreamEvent::Error { message } => {
                        if let Ok(mut m) = metrics_handle.lock() {
                            m.duration_ms = call_start.elapsed().as_millis() as u64;
                            if first_delta_seen {
                                m.streaming_ms = m.duration_ms.saturating_sub(m.ttft_ms);
                            }
                            m.chunk_count = chunk_count;
                        }
                        if partial_message.is_none() {
                            let am: AgentMessage = message.clone().into();
                            event_tx
                                .send(AgentEvent::MessageStart { message: am })
                                .await
                                .ok();
                        }
                    }
                }
            }
        });

        // Provider streams concurrently — events are forwarded in real-time
        // When provider returns, stream_tx is dropped, ending the forwarder
        // Enforce cancellation at the caller boundary as well: HTTP setup,
        // error/JSON bodies and custom providers may not observe the token.
        let stream = config
            .provider
            .stream_bounded(stream_config, stream_tx, provider_cancel);
        tokio::pin!(stream);
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // Let a cooperative provider observe cancellation once so it
                // can clean up; never wait for one that ignores its token.
                match futures::poll!(&mut stream) {
                    std::task::Poll::Ready(result) => result,
                    std::task::Poll::Pending => Err(ProviderError::Cancelled),
                }
            }
            result = &mut stream => result,
        };

        // Promote empty Ok(Message) to a retryable error so the retry loop
        // handles it uniformly instead of terminating the agent loop.
        let result = match result {
            Ok(ref outcome) => {
                let msg = outcome.message();
                let is_empty = match msg {
                    Message::Assistant {
                        content,
                        stop_reason,
                        ..
                    } => {
                        !content.iter().any(|block| match block {
                            Content::Text { text } => !text.trim().is_empty(),
                            Content::Thinking { thinking, .. } => !thinking.trim().is_empty(),
                            Content::Image { .. } | Content::ToolCall { .. } => true,
                        }) && stop_reason != &StopReason::Error
                    }
                    _ => false,
                };
                if is_empty {
                    Err(ProviderError::Network(
                        "Empty response from provider (no content)".into(),
                    ))
                } else {
                    result
                }
            }
            err => err,
        };

        if let Err(error) = &result {
            if error.is_quota_limited() && !cancel.is_cancelled() {
                // Quota exhaustion is one idempotent wait state, not a series
                // of bounded retries. Recovery follows a provider-independent
                // local cadence: probe quickly, then settle at one minute.
                // Wait for the failed attempt's forwarder to stop before the
                // wait event is visible, otherwise late deltas can cross the
                // retry boundary.
                forward_handle.abort();
                let _ = forward_handle.await;
                let delay = quota_probe_delay;
                tx.send(AgentEvent::QuotaWait {
                    delay_ms: delay.as_millis() as u64,
                    error: error.to_string(),
                })
                .await
                .ok();
                long_wait_started = true;
                quota_probe_delay = quota_probe_delay.saturating_mul(2).min(QUOTA_PROBE_MAX);
                let _idle_pause = idle_clock.as_ref().map(crate::context::IdleClock::pause);
                tokio::select! {
                    _ = cancel.cancelled() => break Err(ProviderError::Cancelled),
                    _ = tokio::time::sleep(delay) => {}
                }
                continue;
            }
        }

        let bounded_retry_limit = match &result {
            Err(ProviderError::ProtocolIncomplete(_)) => {
                retry.max_retries().min(PROTOCOL_INCOMPLETE_MAX_RETRIES)
            }
            _ => retry.max_retries(),
        };

        match &result {
            Err(e)
                if crate::retry::should_retry(e)
                    && attempt < bounded_retry_limit
                    && !long_wait_started
                    && !cancel.is_cancelled() =>
            {
                // Abort forwarder to prevent forwarding events from failed attempt
                forward_handle.abort();
                let _ = forward_handle.await;
                let mut error_metrics =
                    shared_metrics.lock().map(|m| m.clone()).unwrap_or_default();
                if error_metrics.duration_ms == 0 {
                    error_metrics.duration_ms = call_start.elapsed().as_millis() as u64;
                }
                // Emit LlmCallEnd for the failed attempt
                tx.send(AgentEvent::LlmCallEnd {
                    turn,
                    attempt,
                    usage: Usage::default(),
                    error: Some(e.to_string()),
                    metrics: error_metrics,
                    context_window: budget.context_window,
                    stop_reason: StopReason::Error,
                    content: vec![],
                    response_model: None,
                    response_id: None,
                })
                .await
                .ok();
                attempt += 1;
                let delay = retry.delay_for_attempt(attempt);
                let delay = if matches!(e, ProviderError::Network(_)) {
                    delay.min(NETWORK_RETRY_MAX_DELAY)
                } else {
                    delay
                };
                tx.send(AgentEvent::LlmCallRetry {
                    turn,
                    attempt,
                    max_retries: bounded_retry_limit,
                    delay_ms: delay.as_millis() as u64,
                    error: e.to_string(),
                })
                .await
                .ok();
                tokio::select! {
                    _ = cancel.cancelled() => break Err(ProviderError::Cancelled),
                    _ = tokio::time::sleep(delay) => {}
                }
                continue;
            }
            Err(e)
                if crate::retry::should_retry(e)
                    && !matches!(e, ProviderError::ProtocolIncomplete(_))
                    && retry.max_retries() > 0
                    && !cancel.is_cancelled() =>
            {
                // The bounded retry budget is exhausted (or a long wait is
                // already underway) but the error is still retryable — a
                // sustained upstream/gateway outage, not a fatal request.
                // Failing here would discard the run's progress, so switch to
                // the same cancellable long-wait used for quota exhaustion and
                // probe at a calm cadence until the gateway recovers. The
                // decision keys off the semantic classification
                // (`should_retry`), never gateway-specific error wording, so it
                // holds for any upstream. `RetryPolicy::disabled()` keeps its
                // fail-fast contract and never enters this state.
                forward_handle.abort();
                let _ = forward_handle.await;
                let delay = if matches!(e, ProviderError::Network(_)) {
                    NETWORK_RETRY_MAX_DELAY
                } else {
                    OUTAGE_RETRY_DELAY
                };
                tx.send(AgentEvent::OutageWait {
                    delay_ms: delay.as_millis() as u64,
                    error: e.to_string(),
                })
                .await
                .ok();
                long_wait_started = true;
                let _idle_pause = idle_clock.as_ref().map(crate::context::IdleClock::pause);
                tokio::select! {
                    _ = cancel.cancelled() => break Err(ProviderError::Cancelled),
                    _ = tokio::time::sleep(delay) => {}
                }
                continue;
            }
            _ => {
                // Final attempt — wait for forwarder to finish processing remaining events
                let mut forward_handle = forward_handle;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        forward_handle.abort();
                        let _ = forward_handle.await;
                        break Err(ProviderError::Cancelled);
                    }
                    _ = &mut forward_handle => {}
                }
                if let Ok(mut m) = shared_metrics.lock() {
                    if m.duration_ms == 0 {
                        m.duration_ms = call_start.elapsed().as_millis() as u64;
                    }
                }
                break result;
            }
        }
    };

    let collected_metrics: LlmCallMetrics =
        shared_metrics.lock().map(|m| m.clone()).unwrap_or_default();

    match result {
        Ok(outcome) => {
            let response_model = outcome.served_model().map(str::to_string);
            let msg = outcome.message();
            let (usage, stop_reason, content, response_id) = match msg {
                Message::Assistant {
                    usage,
                    stop_reason,
                    content,
                    response_id,
                    ..
                } => (
                    usage.clone(),
                    stop_reason.clone(),
                    content.clone(),
                    response_id.clone(),
                ),
                _ => (Usage::default(), StopReason::Stop, vec![], None),
            };

            tx.send(AgentEvent::LlmCallEnd {
                turn,
                attempt,
                usage,
                error: None,
                metrics: collected_metrics,
                context_window: budget.context_window,
                stop_reason,
                content,
                response_model,
                response_id,
            })
            .await
            .ok();
            AssistantStreamResult::complete(outcome.into_message())
        }
        Err(e) => {
            if matches!(e, ProviderError::Cancelled) && cancel.is_cancelled() {
                return AssistantStreamResult::complete(Message::Assistant {
                    content: vec![],
                    stop_reason: StopReason::Aborted,
                    model: config.model.clone(),
                    provider: target_provider,
                    usage: Usage::default(),
                    timestamp: now_ms(),
                    error_message: None,
                    response_id: None,
                });
            }
            tx.send(AgentEvent::LlmCallEnd {
                turn,
                attempt,
                usage: Usage::default(),
                error: Some(e.to_string()),
                metrics: collected_metrics,
                context_window: budget.context_window,
                stop_reason: StopReason::Error,
                content: vec![],
                response_model: None,
                response_id: None,
            })
            .await
            .ok();
            AssistantStreamResult::complete(Message::Assistant {
                content: vec![Content::Text {
                    text: String::new(),
                }],
                stop_reason: StopReason::Error,
                model: config.model.clone(),
                provider: target_provider,
                usage: Usage::default(),
                timestamp: now_ms(),
                error_message: Some(e.to_string()),
                response_id: None,
            })
        }
    }
}

fn target_model(config: &AgentLoopConfig) -> (String, String, ApiProtocol) {
    match &config.model_config {
        Some(model) => (
            model.provider().to_string(),
            model.id().to_string(),
            model.protocol(),
        ),
        None => (
            "openai".into(),
            config.model.clone(),
            ApiProtocol::OpenAiCompletions,
        ),
    }
}
