//! The rule engine and its packs. Rules, word lists, exclusions, sources
//! and structural fields are data (`data/*.json`, `~/.evotai/privacy/rules`);
//! this module only compiles and runs them.
mod checksum;
mod decode;
mod egress;
mod engine;
mod load;
mod pack;

pub(in crate::privacy) use egress::host_matches;
pub(in crate::privacy) use engine::Engine;
pub use engine::KindInfo;
pub use engine::PackInfo;
pub(in crate::privacy) use engine::Source;
pub(in crate::privacy) use engine::HIDDEN_CODE;
pub(in crate::privacy) use engine::SECRET_ENV;
pub(in crate::privacy) use engine::SECRET_FILE;
pub(in crate::privacy) use engine::TERM;
pub(in crate::privacy) use load::builtin_packs;
pub(in crate::privacy) use load::file_stamp;
pub(in crate::privacy) use load::read_user_packs;
pub(in crate::privacy) use load::user_stamp;
pub(in crate::privacy) use load::FileStamp;
pub(in crate::privacy) use load::UserStamp;
pub use load::CUT;
pub use pack::Category;
pub use pack::Confidence;
pub use pack::Pack;
pub use pack::PACK_SCHEMA_VERSION;
