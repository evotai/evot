//! Agent Client Protocol (ACP) v1 endpoint.
//!
//! Exposes the application agent as an ACP agent over newline-delimited
//! JSON-RPC, so editors and embedding tools can drive evot without the
//! terminal UI. Only protocol adaptation lives here; the agent loop, session
//! storage, tool execution, and cancellation stay in the application layer.

mod connection;
mod options;
mod permission;
mod projection;
mod prompt;
mod server;

pub use options::ask_permission;
pub use options::tool_mode;
pub use options::AcpOptions;
pub use server::serve;
pub use server::serve_stdio;
