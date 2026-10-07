//! File operation tools — edit, read, write — and their shared infrastructure.

pub mod diff;
pub mod edit;
pub mod hint;
pub mod mutex;
pub mod read;
pub mod snippet;
pub mod write;

pub use edit::EditFileTool;
pub use read::ReadFileTool;
pub use read::FILE_UNCHANGED_STUB;
pub use write::WriteFileTool;
