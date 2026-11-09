//! Stateful Agent struct — wraps the agent loop with state management,
//! steering/follow-up queues, and abort support.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::queue::QueueMode;
use super::PromptQueue;
use super::RunHandle;
use crate::context::ContextConfig;
use crate::context::ExecutionLimits;
use crate::provider::ModelConfig;
use crate::provider::StreamProvider;
use crate::runner::AfterTurnFn;
use crate::runner::BeforeTurnFn;
use crate::spill::FsSpill;
use crate::tools::guard::PathGuard;
use crate::types::*;

/// The main Agent. Owns state, tools, and provider.
pub struct Agent {
    // State
    pub(super) system_prompt: String,
    pub(super) model: String,
    pub(super) api_key: String,
    pub(super) thinking_level: ThinkingLevel,
    pub(super) max_tokens: Option<u32>,
    pub(super) model_config: Option<ModelConfig>,
    pub(super) messages: Vec<AgentMessage>,
    pub(super) tools: Vec<Box<dyn AgentTool>>,
    pub(super) provider: Arc<dyn StreamProvider>,

    // Sandbox
    pub(super) cwd: PathBuf,
    pub(super) path_guard: Arc<PathGuard>,

    // Queues (shared with the loop and run handles)
    pub(super) steering_queue: PromptQueue,
    pub(super) follow_up_queue: PromptQueue,
    pub(super) steering_mode: QueueMode,
    pub(super) follow_up_mode: QueueMode,

    // Context, limits & caching
    pub(super) context_config: Option<ContextConfig>,
    /// Optional dedicated local summary model. Provider-native remote
    /// compaction still uses the active request model.
    pub(super) compaction_context: Option<crate::context::SummarizerContext>,
    pub(super) compaction_fallback_context: Option<crate::context::SummarizerContext>,
    /// Cross-compaction state restored from a persisted session.
    pub(super) compaction_state: Option<crate::context::CompactionState>,
    pub(super) context_management_disabled: bool,
    pub(super) execution_limits: Option<ExecutionLimits>,
    pub(super) cache_config: CacheConfig,
    pub(super) prompt_cache_key: Option<String>,
    pub(super) tool_execution: ToolExecutionStrategy,
    pub(super) retry_policy: crate::retry::RetryPolicy,

    // Lifecycle callbacks
    pub(super) before_turn: Option<BeforeTurnFn>,
    pub(super) after_turn: Option<AfterTurnFn>,

    // Spill: large tool results written to disk
    pub(super) spill: Option<Arc<FsSpill>>,

    // Session-scoped background process notifications.
    pub(super) process_manager: Option<Arc<crate::tools::ProcessManager>>,

    // Control
    pub(super) cancel: Option<CancellationToken>,
    pub(super) is_streaming: bool,

    // Last run handle (for convenience methods on Agent)
    pub(super) last_run_handle: Option<RunHandle>,

    // Pending completion from a spawned agent loop
    #[allow(clippy::type_complexity)]
    pub(super) pending_completion: Option<
        JoinHandle<(
            Vec<Box<dyn AgentTool>>,
            Vec<AgentMessage>,
            Option<crate::context::CompactionState>,
        )>,
    >,
}

impl Agent {
    pub fn new(provider: impl StreamProvider + 'static) -> Self {
        Self {
            system_prompt: String::new(),
            model: String::new(),
            api_key: String::new(),
            thinking_level: ThinkingLevel::default(),
            max_tokens: None,
            model_config: None,
            messages: Vec::new(),
            tools: Vec::new(),
            provider: Arc::new(provider),
            cwd: PathBuf::new(),
            path_guard: Arc::new(PathGuard::open()),
            steering_queue: PromptQueue::new(),
            follow_up_queue: PromptQueue::new(),
            steering_mode: QueueMode::OneAtATime,
            follow_up_mode: QueueMode::OneAtATime,
            context_config: None,
            compaction_context: None,
            compaction_fallback_context: None,
            compaction_state: None,
            context_management_disabled: false,
            execution_limits: Some(ExecutionLimits::default()),
            cache_config: CacheConfig::default(),
            prompt_cache_key: None,
            tool_execution: ToolExecutionStrategy::default(),
            retry_policy: crate::retry::RetryPolicy::default(),
            before_turn: None,
            after_turn: None,
            spill: None,
            process_manager: None,
            cancel: None,
            is_streaming: false,
            last_run_handle: None,
            pending_completion: None,
        }
    }

    // -- Builder-style setters --

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = prompt.into();
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = key.into();
        self
    }

    pub fn with_thinking(mut self, level: ThinkingLevel) -> Self {
        self.thinking_level = level;
        self
    }

    pub fn with_tools(mut self, tools: Vec<Box<dyn AgentTool>>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = cwd.into();
        self
    }

    pub fn with_path_guard(mut self, guard: Arc<PathGuard>) -> Self {
        self.path_guard = guard;
        self
    }

    /// Use caller-owned queues so control handles remain valid while an app
    /// runtime swaps engine instances between turns.
    pub fn with_prompt_queues(mut self, steering: PromptQueue, follow_up: PromptQueue) -> Self {
        self.steering_queue = steering;
        self.follow_up_queue = follow_up;
        self
    }

    pub fn with_model_config(mut self, config: ModelConfig) -> Self {
        self.model_config = Some(config);
        self
    }

    pub fn with_max_tokens(mut self, max: u32) -> Self {
        self.max_tokens = Some(max);
        self
    }

    pub fn with_context_config(mut self, config: ContextConfig) -> Self {
        self.context_config = Some(config);
        self
    }

    /// Use an independent model for local compaction summaries. Remote
    /// compaction remains bound to the active model because its state is
    /// provider-native and replayed on later active-model requests.
    pub fn with_compaction_contexts(
        mut self,
        primary: Option<crate::context::SummarizerContext>,
        fallback: Option<crate::context::SummarizerContext>,
    ) -> Self {
        self.compaction_context = primary;
        self.compaction_fallback_context = fallback;
        self
    }

    /// Seed cross-compaction state (previous summary, cumulative file ops)
    /// restored from a persisted session.
    pub fn with_compaction_state_opt(
        mut self,
        state: Option<crate::context::CompactionState>,
    ) -> Self {
        self.compaction_state = state;
        self
    }

    pub fn with_prompt_cache_key_opt(mut self, key: Option<String>) -> Self {
        self.prompt_cache_key = key;
        self
    }

    /// Set or clear execution limits. `None` runs the loop with no turn, token,
    /// or duration ceiling — it stops only on error, abort, or when there is no
    /// more work (interactive parity with pi).
    pub fn with_execution_limits_opt(mut self, limits: Option<ExecutionLimits>) -> Self {
        self.execution_limits = limits;
        self
    }

    pub fn with_messages(mut self, msgs: Vec<AgentMessage>) -> Self {
        self.messages = msgs;
        self
    }

    /// Set spill from an optional value.
    pub fn with_spill_opt(mut self, spill: Option<Arc<FsSpill>>) -> Self {
        self.spill = spill;
        self
    }

    pub fn with_process_manager(
        mut self,
        process_manager: Arc<crate::tools::ProcessManager>,
    ) -> Self {
        self.process_manager = Some(process_manager);
        self
    }

    // -- State access --

    pub fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn thinking_level(&self) -> ThinkingLevel {
        self.thinking_level
    }

    pub fn max_tokens(&self) -> Option<u32> {
        self.max_tokens
    }

    pub fn messages(&self) -> &[AgentMessage] {
        &self.messages
    }

    pub fn is_streaming(&self) -> bool {
        self.is_streaming
    }

    pub fn append_message(&mut self, msg: AgentMessage) {
        self.messages.push(msg);
    }

    pub fn save_messages(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(&self.messages)
    }

    pub fn restore_messages(&mut self, json: &str) -> Result<(), serde_json::Error> {
        let mut messages: Vec<AgentMessage> = serde_json::from_str(json)?;
        crate::types::migrate_legacy_responses_tool_ids(&mut messages);
        self.messages = messages;
        Ok(())
    }

    // -- Queue management --

    /// Queue a steering message (delegates to last run handle).
    pub fn steer(&self, msg: AgentMessage) {
        if let Some(ref h) = self.last_run_handle {
            h.steer(msg);
        } else {
            self.steering_queue.enqueue(msg);
        }
    }

    /// Queue a follow-up message (delegates to last run handle).
    pub fn follow_up(&self, msg: AgentMessage) {
        if let Some(ref h) = self.last_run_handle {
            h.follow_up(msg);
        } else {
            self.follow_up_queue.enqueue(msg);
        }
    }

    pub fn clear_steering_queue(&self) {
        self.steering_queue.clear();
        if let Some(ref h) = self.last_run_handle {
            h.clear_steering();
        }
    }

    pub fn clear_follow_up_queue(&self) {
        self.follow_up_queue.clear();
        if let Some(ref h) = self.last_run_handle {
            h.clear_follow_up();
        }
    }

    pub fn clear_all_queues(&self) {
        self.clear_steering_queue();
        self.clear_follow_up_queue();
    }

    /// Get the last run handle (if any).
    pub fn run_handle(&self) -> Option<&RunHandle> {
        self.last_run_handle.as_ref()
    }

    // -- Control --

    pub fn abort(&self) {
        if let Some(ref h) = self.last_run_handle {
            h.abort();
        } else if let Some(ref cancel) = self.cancel {
            cancel.cancel();
        }
    }

    pub async fn reset(&mut self) {
        // Cancel cooperatively first, then await to recover tools
        if let Some(ref h) = self.last_run_handle {
            h.abort();
        } else if let Some(ref cancel) = self.cancel {
            cancel.cancel();
        }
        if let Some(handle) = self.pending_completion.take() {
            // Await the cancelled task to recover tools; ignore panic
            if let Ok((tools, _messages, _compaction_state)) = handle.await {
                self.tools = tools;
            }
        }
        self.messages.clear();
        self.compaction_state = None;
        self.clear_all_queues();
        self.is_streaming = false;
        self.cancel = None;
        self.last_run_handle = None;
    }
}
