#[path = "tools/background_process.rs"]
mod background_process;
#[path = "tools/bash.rs"]
mod bash;
#[path = "tools/explore.rs"]
mod explore;
#[path = "tools/file/mod.rs"]
mod file;
#[path = "tools/host_tool.rs"]
mod host_tool;
#[path = "tools/naming.rs"]
mod naming;
#[path = "tools/schema_order.rs"]
mod schema_order;
#[path = "tools/spawn_session.rs"]
mod spawn_session;
#[path = "tools/spill.rs"]
mod spill;
#[path = "tools/tool_sets.rs"]
mod tool_sets;
#[path = "tools/validation.rs"]
mod validation;
#[path = "tools/web_fetch.rs"]
mod web_fetch;

use std::sync::Arc;

use evotengine::types::*;
use tokio_util::sync::CancellationToken;

/// Helper to build a ToolContext for tests.
pub fn ctx(name: &str) -> ToolContext {
    ToolContext {
        tool_call_id: "t1".into(),
        tool_name: name.into(),
        cancel: CancellationToken::new(),
        on_update: None,
        on_progress: None,
        cwd: std::path::PathBuf::new(),
        path_guard: Arc::new(evotengine::PathGuard::open()),
        spill: None,
        supports_image: true,
    }
}

pub fn ctx_with_cancel(name: &str, cancel: CancellationToken) -> ToolContext {
    ToolContext {
        tool_call_id: "t1".into(),
        tool_name: name.into(),
        cancel,
        on_update: None,
        on_progress: None,
        cwd: std::path::PathBuf::new(),
        path_guard: Arc::new(evotengine::PathGuard::open()),
        spill: None,
        supports_image: true,
    }
}
