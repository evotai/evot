//! Infrastructure every other module may depend on; depends on nothing above it.

pub(crate) mod atomic_file;
pub mod blocking;
pub mod error;
pub(crate) mod http;
pub mod paths;
