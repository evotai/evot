//! Read-only code exploration tools: `grep` (content search) and `glob`
//! (file-name search).
//!
//! Both run in-process on the `ignore` + `globset` + `regex` crates — the same
//! libraries ripgrep and fd are built on — so traversal is gitignore-aware
//! without spawning an external binary or parsing its output. Tree traversal
//! is parallelized via `ignore`'s `build_parallel` (the same machinery that
//! makes ripgrep fast), so large repositories scan across all cores.
//!
//! Results are returned as structured text the model can act on directly:
//! grep emits `path:line: text`, glob emits paths sorted by recency. This is
//! the key difference from shelling out to `bash grep` — the agent trusts and
//! reuses the line-numbered output instead of re-reading files to locate code.

mod glob;
mod grep;
mod search;
mod walk;

pub use glob::GlobTool;
pub use grep::GrepTool;
pub use search::SearchTool;
pub(crate) use walk::cap_output;
pub(crate) use walk::finalize_output;
pub(crate) use walk::parallel_collect;
