//! Curated metadata for models Evot actively supports.
//!
//! Provider specifications are authoritative for capacity. External agent
//! registries only inform agent-specific policy such as compaction thresholds.

mod anthropic;
mod deepseek;
mod glm;
mod google;
mod kimi;
mod lookup;
mod openai;
mod profile;
mod xai;

pub(super) use lookup::normalize_model_id;
pub(super) use lookup::resolve;
pub(super) use profile::protocol_fallback;
