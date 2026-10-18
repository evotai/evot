//! Agent run/resume/finish — submitting work to the agent loop.

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::core::Agent;
use super::handle::RunHandle;
use super::queue::PromptQueue;
use crate::context::ContextConfig;
use crate::runner::agent_loop_continue_with_state;
use crate::runner::agent_loop_with_state;
use crate::runner::event_sink::EventSink;
use crate::runner::AgentLoopConfig;
use crate::types::*;

/// What the spawned loop starts from: an explicit prompt or a continue
/// from existing context.
enum RunKind {
    Prompt { messages: Vec<AgentMessage> },
    Continue,
}

impl Agent {
    // -- Submitting --

    pub async fn submit_text(
        &mut self,
        text: impl Into<String>,
    ) -> (RunHandle, mpsc::UnboundedReceiver<AgentEvent>) {
        let msg = AgentMessage::Llm(Message::user(text));
        self.submit(vec![msg]).await
    }

    pub async fn submit(
        &mut self,
        messages: Vec<AgentMessage>,
    ) -> (RunHandle, mpsc::UnboundedReceiver<AgentEvent>) {
        self.finish().await;

        assert!(
            !self.is_streaming,
            "Agent is already streaming. Use steer() or follow_up()."
        );

        self.spawn_run(RunKind::Prompt { messages }).await
    }

    pub async fn resume(&mut self) -> (RunHandle, mpsc::UnboundedReceiver<AgentEvent>) {
        self.finish().await;

        let (tx, rx) = mpsc::unbounded_channel();

        if self.is_streaming {
            tx.send(AgentEvent::Error {
                error: AgentErrorInfo {
                    kind: AgentErrorKind::Runtime,
                    message: "Agent is already streaming, skipping resume".into(),
                },
            })
            .ok();
            return (RunHandle::noop(), rx);
        }
        if self.messages.is_empty() {
            tx.send(AgentEvent::Error {
                error: AgentErrorInfo {
                    kind: AgentErrorKind::Runtime,
                    message: "No messages to resume from, skipping resume".into(),
                },
            })
            .ok();
            return (RunHandle::noop(), rx);
        }

        self.spawn_run(RunKind::Continue).await
    }

    /// Bounded execution stream for hosts that consume while the run executes.
    /// Continue draining after abort so final transcript events can be saved.
    pub async fn submit_bounded(
        &mut self,
        messages: Vec<AgentMessage>,
    ) -> (RunHandle, mpsc::Receiver<AgentEvent>) {
        self.finish().await;
        let cancel = CancellationToken::new();
        let (tx, rx) = EventSink::bounded(cancel.clone());
        let handle = self.spawn_with_sink(RunKind::Prompt { messages }, tx, cancel);
        (handle, rx)
    }

    pub async fn finish(&mut self) {
        if let Some(handle) = self.pending_completion.take() {
            match handle.await {
                Ok((tools, messages, compaction_state)) => {
                    self.tools = tools;
                    self.messages = messages;
                    self.compaction_state = compaction_state;
                }
                Err(e) => {
                    tracing::error!("Agent loop task failed: {}", e);
                }
            }
            self.is_streaming = false;
            self.cancel = None;
            self.last_run_handle = None;
        }
    }

    /// Shared run setup and spawn: cancel token, run handle, loop context,
    /// config, and panic containment. Both `submit` and `resume` funnel here.
    async fn spawn_run(
        &mut self,
        kind: RunKind,
    ) -> (RunHandle, mpsc::UnboundedReceiver<AgentEvent>) {
        let cancel = CancellationToken::new();
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = self.spawn_with_sink(kind, tx.into(), cancel);
        (handle, rx)
    }

    fn spawn_with_sink(
        &mut self,
        kind: RunKind,
        tx: EventSink,
        cancel: CancellationToken,
    ) -> RunHandle {
        self.cancel = Some(cancel.clone());
        self.is_streaming = true;

        // Share the stable queues with the run handle. Entries can now be
        // inspected or edited while the loop is active; no drain/copy handoff.
        let steering_queue = self.steering_queue.clone();
        let follow_up_queue = self.follow_up_queue.clone();
        let run_handle = RunHandle {
            steering_queue: steering_queue.clone(),
            follow_up_queue: follow_up_queue.clone(),
            cancel: cancel.clone(),
        };
        self.last_run_handle = Some(run_handle.clone());

        let mut context = AgentContext {
            system_prompt: self.system_prompt.clone(),
            messages: self.messages.clone(),
            tools: std::mem::take(&mut self.tools),
            cwd: self.cwd.clone(),
            path_guard: self.path_guard.clone(),
            prompt_cache_key: self.prompt_cache_key.clone(),
        };

        let config = self.build_config_with_queues(steering_queue, follow_up_queue);

        let handle = tokio::spawn(async move {
            let mut compaction_state = config.initial_compaction_state.clone();
            let result = std::panic::AssertUnwindSafe(async {
                let outcome = match kind {
                    RunKind::Prompt { messages } => {
                        agent_loop_with_state(messages, &mut context, &config, tx.clone(), cancel)
                            .await
                    }
                    RunKind::Continue => {
                        agent_loop_continue_with_state(&mut context, &config, tx.clone(), cancel)
                            .await
                    }
                };
                compaction_state = outcome.compaction_state;
            });
            if let Err(e) = futures::FutureExt::catch_unwind(result).await {
                let msg = match e.downcast_ref::<&str>() {
                    Some(s) => s.to_string(),
                    None => match e.downcast_ref::<String>() {
                        Some(s) => s.clone(),
                        None => "unknown panic".into(),
                    },
                };
                tx.send(AgentEvent::Error {
                    error: AgentErrorInfo {
                        kind: AgentErrorKind::Runtime,
                        message: format!("Agent loop panicked: {msg}"),
                    },
                })
                .await
                .ok();
                tx.send(AgentEvent::AgentEnd { messages: vec![] })
                    .await
                    .ok();
            }
            (context.tools, context.messages, compaction_state)
        });

        self.pending_completion = Some(handle);
        run_handle
    }

    fn build_config_with_queues(
        &self,
        steering_queue: PromptQueue,
        follow_up_queue: PromptQueue,
    ) -> AgentLoopConfig {
        let steering_mode = self.steering_mode;
        let follow_up_mode = self.follow_up_mode;

        AgentLoopConfig {
            provider: self.provider.clone(),
            model: self.model.clone(),
            api_key: self.api_key.clone(),
            thinking_level: self.thinking_level,
            max_tokens: self.max_tokens,
            model_config: self.model_config.clone(),
            convert_to_llm: None,
            transform_context: None,
            get_steering_messages: Some(Box::new(move || {
                steering_queue.drain_messages(steering_mode)
            })),
            context_config: if self.context_management_disabled {
                None
            } else {
                Some(self.context_config.clone().unwrap_or_else(|| {
                    self.model_config
                        .as_ref()
                        .map(|model| ContextConfig::from_model(model, self.thinking_level))
                        .unwrap_or_default()
                }))
            },
            compaction_context: self.compaction_context.clone(),
            compaction_fallback_context: self.compaction_fallback_context.clone(),
            judge: self.judge.clone(),
            prune_ledger: self.prune_ledger.clone(),
            initial_compaction_state: self.compaction_state.clone(),
            execution_limits: self.execution_limits.clone(),
            cache_config: self.cache_config.clone(),
            tool_execution: self.tool_execution.clone(),
            retry_policy: self.retry_policy.clone(),
            get_follow_up_messages: {
                let process_manager = self.process_manager.clone();
                Some(Box::new(move || {
                    let mut messages = follow_up_queue.drain_messages(follow_up_mode);
                    if let Some(manager) = &process_manager {
                        messages.extend(manager.take_notifications().into_iter().map(|text| {
                            AgentMessage::Llm(Message::runtime_user(text, "background_task", None))
                        }));
                    }
                    messages
                }))
            },
            before_turn: self.before_turn.clone(),
            after_turn: self.after_turn.clone(),
            spill: self.spill.clone(),
        }
    }
}
