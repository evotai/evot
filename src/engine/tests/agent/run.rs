//! Agent loop integration tests, grouped by concern.

#[path = "run/callbacks.rs"]
mod callbacks;
#[path = "run/common.rs"]
mod common;
#[path = "run/compaction.rs"]
mod compaction;
#[path = "run/content_preservation.rs"]
mod content_preservation;
#[path = "run/core.rs"]
mod core;
#[path = "run/network_recovery.rs"]
mod network_recovery;
#[path = "run/retry.rs"]
mod retry;
#[path = "run/steering.rs"]
mod steering;
#[path = "run/tool_availability.rs"]
mod tool_availability;
#[path = "run/tools.rs"]
mod tools;
