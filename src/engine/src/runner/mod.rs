mod compaction_check;
mod config;
mod driver;
pub(crate) mod event_sink;

pub(crate) mod doom_loop;
mod llm_call;
mod thinking_only_guard;
mod tool_exec;

pub use config::AfterTurnFn;
pub use config::AgentLoopConfig;
pub use config::BeforeTurnFn;
pub use config::ConvertToLlmFn;
pub use config::GetMessagesFn;
pub use config::TransformContextFn;
pub use doom_loop::DoomLoopDetector;
pub use driver::agent_loop;
pub use driver::agent_loop_continue;
pub(crate) use driver::agent_loop_continue_with_state;
pub(crate) use driver::agent_loop_with_state;
pub(crate) use driver::LoopProgress;
pub use thinking_only_guard::ThinkingOnlyGuard;
