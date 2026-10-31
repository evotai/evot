//! Privacy masking without a model.
//!
//! LLM requests: secrets and personal data become placeholders before the
//! provider sees them and are put back in the reply ([`wrap`]). Uploads
//! (share links, cloud sync): the same values are scrubbed for good
//! ([`scrub_upload`]). Both record what they found, never the values, for
//! `/privacy` ([`summary`]). Tool calls: each is checked before it runs, and
//! one that would send a secret where the user has not trusted is refused
//! ([`GuardedTool`]). Settings live in `~/.evotai/privacy/`.
//!
//! Every rule, word list, exclusion, source and structural field is data:
//! the packs in `rules/data/*.json` and the user's `~/.evotai/privacy/rules`.
//! The Rust here is the engine that runs them.
mod delivery;
mod masker;
mod notice;
mod policy;
mod provider;
mod record;
mod request;
mod rules;
mod scan;
mod scrub;
mod service;
mod stream;
mod vault;
#[cfg(test)]
#[path = "../../tests/privacy/worker_test.rs"]
mod worker_tests;

pub use delivery::ScrubbingSink;
pub use masker::Masker;
pub use masker::Report;
pub use notice::blocked_message;
pub use notice::unavailable_message;
pub use policy::Action;
pub use policy::PrivacySettings;
pub use policy::SETTINGS_SCHEMA_VERSION;
pub use provider::wrap;
pub use provider::MaskingProvider;
pub use record::session_tags as session_record_tags;
pub use record::summarize as summarize_records;
pub use record::Event;
pub use record::KindStats;
pub use record::LiveNotice;
pub use record::OriginRecord;
pub use record::Record;
pub use record::RuleCount;
pub use record::Summary;
pub use record::Target;
pub use record::TargetStats;
pub use record::ValueRecord;
pub use record::RECORD_SCHEMA_VERSION;
pub use rules::Category;
pub use rules::Confidence;
pub use rules::KindInfo;
pub use rules::Pack;
pub use rules::PackInfo;
pub use rules::CUT;
pub use rules::PACK_SCHEMA_VERSION;
pub use scan::Finder;
pub use scrub::UploadContext;
pub use service::live_notices;
pub use service::remember_secrets;
pub use service::rules_status;
pub use service::save_settings;
pub use service::scrub_upload;
pub use service::scrub_upload_with;
pub use service::session_tags;
pub use service::settings;
pub use service::summary;
pub use service::upload_context;
pub use stream::StreamRestorer;
