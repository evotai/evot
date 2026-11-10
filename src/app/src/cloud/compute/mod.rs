//! Compute: the user's own ssh machines evot may use, each for what the user
//! says it is for.

pub mod alias;
pub mod discover;
mod model;
pub mod probe;
pub mod prompt;
mod service;
pub mod store;
pub mod validate;

pub use model::*;
pub use service::apply_patch;
pub use service::build_machine;
pub use service::discover_in;
pub use service::ComputeService;
