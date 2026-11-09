//! Test harness for the agent loop.
//!
//! Provides `TestHarness` (builder), `MockTool`, and `TestOutput` to reduce
//! boilerplate in agent_loop tests.
//!
//! # Example
//! ```rust,ignore
//! let output = TestHarness::new()
//!     .responses(vec![MockResponse::text("Hello")])
//!     .run("Hi")
//!     .await;
//! assert_eq!(output.messages.len(), 2);
//! ```

use std::sync::Arc;

use evotengine::agent_loop;
use evotengine::agent_loop_continue;
use evotengine::context::ContextConfig;
use evotengine::context::ExecutionLimits;
use evotengine::provider::mock::*;
use evotengine::provider::MockProvider;
use evotengine::provider::ModelConfig;
use evotengine::types::AgentContext;
use evotengine::AgentLoopConfig;
use evotengine::*;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

// ---------------------------------------------------------------------------
// MockTool — generic mock tool replacing inline struct definitions
// ---------------------------------------------------------------------------

/// A configurable mock tool for tests.
pub struct MockTool {
    name: String,
    label: String,
    description: String,
    schema: serde_json::Value,
    result: Result<ToolResult, ToolError>,
    /// Artificial execution delay, to simulate a long-running command.
    delay: Option<std::time::Duration>,
    ends_turn: bool,
}

impl MockTool {
    /// Create a mock tool that returns success with the given text output.
    pub fn ok(name: &str, output: &str) -> Self {
        Self {
            name: name.into(),
            label: name.into(),
            description: format!("Mock {}", name),
            schema: serde_json::json!({"type": "object", "properties": {}}),
            result: Ok(ToolResult {
                content: vec![Content::Text {
                    text: output.into(),
                }],
                details: serde_json::Value::Null,
                retention: Retention::Normal,
            }),
            delay: None,
            ends_turn: false,
        }
    }

    /// Create a mock tool that returns an error.
    pub fn err(name: &str, error: &str) -> Self {
        Self {
            name: name.into(),
            label: name.into(),
            description: format!("Mock {}", name),
            schema: serde_json::json!({"type": "object", "properties": {}}),
            result: Err(ToolError::Failed(error.into())),
            delay: None,
            ends_turn: false,
        }
    }

    /// Mark the tool as run-settling: a successful call ends the run without
    /// a follow-up model response.
    pub fn ends_turn(mut self) -> Self {
        self.ends_turn = true;
        self
    }

    /// Add an artificial execution delay, to simulate a long-running command
    /// (a build, a training run) whose wall-time must be excluded from the
    /// execution duration limit.
    pub fn with_delay(mut self, delay: std::time::Duration) -> Self {
        self.delay = Some(delay);
        self
    }

    /// Override the JSON schema.
    pub fn with_schema(mut self, schema: serde_json::Value) -> Self {
        self.schema = schema;
        self
    }
}

#[async_trait::async_trait]
impl AgentTool for MockTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn label(&self) -> &str {
        &self.label
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters_schema(&self) -> serde_json::Value {
        self.schema.clone()
    }
    fn ends_turn(&self) -> bool {
        self.ends_turn
    }
    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        match &self.result {
            Ok(r) => Ok(r.clone()),
            Err(ToolError::Failed(msg)) => Err(ToolError::Failed(msg.clone())),
            Err(ToolError::NotFound(msg)) => Err(ToolError::NotFound(msg.clone())),
            Err(ToolError::InvalidArgs(msg)) => Err(ToolError::InvalidArgs(msg.clone())),
            Err(ToolError::Cancelled) => Err(ToolError::Cancelled),
        }
    }
}

// ---------------------------------------------------------------------------
// TestHarness — builder for agent loop tests
// ---------------------------------------------------------------------------

/// Builder for agent loop tests. Encapsulates config, context, channel, cancel.
pub struct TestHarness {
    responses: Vec<MockResponse>,
    tools: Vec<Box<dyn AgentTool>>,
    system_prompt: String,
    prior_messages: Vec<AgentMessage>,
    steering_messages: Vec<AgentMessage>,
    follow_up_messages: Vec<AgentMessage>,
    context_config: Option<ContextConfig>,
    execution_limits: Option<ExecutionLimits>,
    retry_policy: RetryPolicy,
    cache_config: CacheConfig,
    tool_execution: ToolExecutionStrategy,
    model_config: Option<ModelConfig>,
}

impl TestHarness {
    pub fn new() -> Self {
        Self {
            responses: vec![],
            tools: vec![],
            system_prompt: "test".into(),
            prior_messages: vec![],
            steering_messages: vec![],
            follow_up_messages: vec![],
            context_config: None,
            execution_limits: None,
            retry_policy: RetryPolicy::disabled(),
            cache_config: CacheConfig::default(),
            tool_execution: ToolExecutionStrategy::default(),
            model_config: None,
        }
    }

    /// Set mock LLM responses (consumed in order).
    pub fn responses(mut self, responses: Vec<MockResponse>) -> Self {
        self.responses = responses;
        self
    }

    /// Add a single mock tool.
    pub fn tool(mut self, tool: MockTool) -> Self {
        self.tools.push(Box::new(tool));
        self
    }

    /// Add a real AgentTool implementation (for custom tools in tests).
    pub fn tool_boxed(mut self, tool: Box<dyn AgentTool>) -> Self {
        self.tools.push(tool);
        self
    }

    /// Set system prompt.
    pub fn system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = prompt.into();
        self
    }

    /// Set prior messages (for continue scenarios or pre-populated context).
    pub fn prior_messages(mut self, msgs: Vec<AgentMessage>) -> Self {
        self.prior_messages = msgs;
        self
    }

    /// Set context config (enables compaction).
    pub fn context_config(mut self, config: ContextConfig) -> Self {
        self.context_config = Some(config);
        self
    }

    /// Set execution limits.
    pub fn execution_limits(mut self, limits: ExecutionLimits) -> Self {
        self.execution_limits = Some(limits);
        self
    }

    /// Set retry policy.
    pub fn retry_policy(mut self, policy: RetryPolicy) -> Self {
        self.retry_policy = policy;
        self
    }

    /// Set tool execution strategy.
    pub fn tool_execution(mut self, strategy: ToolExecutionStrategy) -> Self {
        self.tool_execution = strategy;
        self
    }

    /// Set model config.
    pub fn model_config(mut self, model_config: ModelConfig) -> Self {
        self.model_config = Some(model_config);
        self
    }

    /// Set steering messages to be injected during the run.
    pub fn steering(mut self, messages: Vec<AgentMessage>) -> Self {
        self.steering_messages = messages;
        self
    }

    /// Set follow-up messages, drained once the model stops calling tools.
    ///
    /// This is the path background-task completion notices travel: the engine
    /// appends them to whatever the follow-up queue returns, so a notice keeps
    /// the current run going instead of waiting for a new one.
    pub fn follow_up(mut self, messages: Vec<AgentMessage>) -> Self {
        self.follow_up_messages = messages;
        self
    }

    /// Run agent_loop with a text prompt. Returns TestOutput.
    pub async fn run(self, prompt: &str) -> TestOutput {
        let provider = MockProvider::new(self.responses);
        let steering = Arc::new(parking_lot::Mutex::new(self.steering_messages));
        let get_steering: Option<evotengine::GetMessagesFn> = {
            let q = steering.clone();
            Some(Box::new(move || q.lock().drain(..).collect()))
        };
        // Drains once, like the real queue: a hook that kept returning the same
        // message would spin the run forever rather than deliver it.
        let follow_ups = Arc::new(parking_lot::Mutex::new(self.follow_up_messages));
        let get_follow_up: Option<evotengine::GetMessagesFn> = {
            let q = follow_ups.clone();
            Some(Box::new(move || q.lock().drain(..).collect()))
        };
        let config = AgentLoopConfig {
            provider: Arc::new(provider),
            model: "mock".into(),
            api_key: "test".into(),
            thinking_level: ThinkingLevel::Off,
            max_tokens: None,
            model_config: self.model_config,
            convert_to_llm: None,
            transform_context: None,
            get_steering_messages: get_steering,
            get_follow_up_messages: get_follow_up,
            context_config: self.context_config,
            compaction_context: None,
            compaction_fallback_context: None,
            initial_compaction_state: None,
            execution_limits: self.execution_limits,
            cache_config: self.cache_config,
            tool_execution: self.tool_execution,
            retry_policy: self.retry_policy,
            before_turn: None,
            after_turn: None,
            spill: None,
        };

        let mut context = AgentContext {
            system_prompt: self.system_prompt,
            messages: self.prior_messages,
            tools: self.tools,
            cwd: std::path::PathBuf::new(),
            path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
            prompt_cache_key: None,
        };

        let prompt_msg = AgentMessage::Llm(Message::user(prompt));
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();

        let messages = agent_loop(vec![prompt_msg], &mut context, &config, tx, cancel).await;
        let events = collect_events(rx);

        TestOutput {
            messages,
            events,
            context_messages: context.messages,
        }
    }

    /// Run agent_loop_continue from prior_messages. Returns TestOutput.
    pub async fn run_continue(self) -> TestOutput {
        let provider = MockProvider::new(self.responses);
        let config = AgentLoopConfig {
            provider: Arc::new(provider),
            model: "mock".into(),
            api_key: "test".into(),
            thinking_level: ThinkingLevel::Off,
            max_tokens: None,
            model_config: self.model_config,
            convert_to_llm: None,
            transform_context: None,
            get_steering_messages: None,
            get_follow_up_messages: None,
            context_config: self.context_config,
            compaction_context: None,
            compaction_fallback_context: None,
            initial_compaction_state: None,
            execution_limits: self.execution_limits,
            cache_config: self.cache_config,
            tool_execution: self.tool_execution,
            retry_policy: self.retry_policy,
            before_turn: None,
            after_turn: None,
            spill: None,
        };

        let mut context = AgentContext {
            system_prompt: self.system_prompt,
            messages: self.prior_messages,
            tools: self.tools,
            cwd: std::path::PathBuf::new(),
            path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
            prompt_cache_key: None,
        };

        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();

        let messages = agent_loop_continue(&mut context, &config, tx, cancel).await;
        let events = collect_events(rx);

        TestOutput {
            messages,
            events,
            context_messages: context.messages,
        }
    }
}

// ---------------------------------------------------------------------------
// TestOutput — result container with convenience methods
// ---------------------------------------------------------------------------

/// Collected output from a test run.
pub struct TestOutput {
    /// New messages produced by the agent loop.
    pub messages: Vec<AgentMessage>,
    /// All events emitted during the run.
    pub events: Vec<AgentEvent>,
    /// Full context messages after the run (includes prior + new).
    pub context_messages: Vec<AgentMessage>,
}

impl TestOutput {
    /// Get event type names as strings.
    pub fn event_types(&self) -> Vec<&str> {
        self.events
            .iter()
            .map(|e| match e {
                AgentEvent::AgentStart => "AgentStart",
                AgentEvent::AgentEnd { .. } => "AgentEnd",
                AgentEvent::TurnStart => "TurnStart",
                AgentEvent::TurnEnd { .. } => "TurnEnd",
                AgentEvent::MessageStart { .. } => "MessageStart",
                AgentEvent::MessageEnd { .. } => "MessageEnd",
                AgentEvent::MessageUpdate { .. } => "MessageUpdate",
                AgentEvent::ToolExecutionStart { .. } => "ToolExecStart",
                AgentEvent::ToolExecutionUpdate { .. } => "ToolExecUpdate",
                AgentEvent::ToolExecutionEnd { .. } => "ToolExecEnd",
                AgentEvent::ProgressMessage { .. } => "ProgressMessage",
                AgentEvent::Error { .. } => "Error",
                AgentEvent::LlmCallStart { .. } => "LlmCallStart",
                AgentEvent::QuotaWait { .. } => "QuotaWait",
                AgentEvent::OutageWait { .. } => "OutageWait",
                AgentEvent::LlmCallRetry { .. } => "LlmCallRetry",
                AgentEvent::LlmCallEnd { .. } => "LlmCallEnd",
                AgentEvent::ContextCompactionStarted { .. } => "CompactionStart",
                AgentEvent::ContextCompactionPhase { .. } => "CompactionPhase",
                AgentEvent::ContextCompactionEnd { .. } => "CompactionEnd",
            })
            .collect()
    }

    /// Check if a specific event type was emitted.
    pub fn has_event(&self, name: &str) -> bool {
        self.event_types().contains(&name)
    }

    /// Count occurrences of a specific event type.
    pub fn event_count(&self, name: &str) -> usize {
        self.event_types().iter().filter(|&&t| t == name).count()
    }

    /// Get tool execution errors.
    pub fn tool_errors(&self) -> Vec<&AgentEvent> {
        self.events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolExecutionEnd { is_error: true, .. }))
            .collect()
    }

    /// Get Error events.
    pub fn errors(&self) -> Vec<&AgentErrorInfo> {
        self.events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Error { error } => Some(error),
                _ => None,
            })
            .collect()
    }

    /// Get LlmCallEnd events that have errors.
    pub fn llm_call_errors(&self) -> Vec<String> {
        self.events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::LlmCallEnd {
                    error: Some(err), ..
                } => Some(err.clone()),
                _ => None,
            })
            .collect()
    }

    /// Get steered_count values from LlmCallStart events.
    pub fn injected_counts(&self) -> Vec<usize> {
        self.events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::LlmCallStart { injected_count, .. } => Some(*injected_count),
                _ => None,
            })
            .collect()
    }

    /// Get the role of the last new message.
    pub fn last_role(&self) -> Option<&str> {
        self.messages.last().map(|m| m.role())
    }

    /// Assert the agent loop completed (AgentStart + AgentEnd both present).
    pub fn assert_completed(&self) {
        assert!(self.has_event("AgentStart"), "Missing AgentStart event");
        assert!(self.has_event("AgentEnd"), "Missing AgentEnd event");
    }

    /// Assert no Error events were emitted.
    pub fn assert_no_errors(&self) {
        let errors = self.errors();
        assert!(errors.is_empty(), "Expected no errors, got: {:?}", errors);
    }

    /// Assert the number of new messages.
    pub fn assert_message_count(&self, expected: usize) {
        assert_eq!(
            self.messages.len(),
            expected,
            "Expected {} messages, got {}",
            expected,
            self.messages.len()
        );
    }

    /// Assert the last message has the given role.
    pub fn assert_last_role(&self, role: &str) {
        assert_eq!(
            self.last_role(),
            Some(role),
            "Expected last role '{}', got {:?}",
            role,
            self.last_role()
        );
    }
}

// ---------------------------------------------------------------------------
// Public helpers for manual tests
// ---------------------------------------------------------------------------

pub fn collect_events(mut rx: mpsc::UnboundedReceiver<AgentEvent>) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    events
}

pub fn make_config(provider: MockProvider) -> AgentLoopConfig {
    AgentLoopConfig {
        provider: std::sync::Arc::new(provider),
        model: "mock".into(),
        api_key: "test".into(),
        thinking_level: ThinkingLevel::Off,
        max_tokens: None,
        model_config: None,
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_context: None,
        compaction_fallback_context: None,
        initial_compaction_state: None,
        execution_limits: None,
        cache_config: CacheConfig::default(),
        tool_execution: ToolExecutionStrategy::default(),
        retry_policy: evotengine::RetryPolicy::default(),
        before_turn: None,
        after_turn: None,
        spill: None,
    }
}
