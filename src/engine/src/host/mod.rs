//! Host delegation: the engine's boundary to an out-of-core host process.
//!
//! The engine core is domain-agnostic. Capabilities like `ask_user` and any
//! future domain tool are owned by the host (the TypeScript CLI). This
//! module defines the single, reusable contract for that boundary:
//!
//! - [`HostToolSpec`] — how the host describes a tool it owns.
//! - [`HostBridge`] — how the engine calls back into the host.
//! - [`HostTool`] — the [`crate::types::AgentTool`] that bridges the two.

mod bridge;
mod protocol;
mod tool;

pub use bridge::HostBridge;
pub use bridge::HostError;
pub use bridge::HostFuture;
pub use bridge::SharedHost;
pub use protocol::HostToolCall;
pub use protocol::HostToolResponse;
pub use protocol::HostToolSpec;
pub use tool::HostTool;
