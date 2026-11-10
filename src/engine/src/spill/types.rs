use std::path::PathBuf;

/// Maximum bytes for a single tool result text block.
/// Prevents oversized outputs from blowing up the context window.
///
/// Claude Code uses `MAX_TOOL_RESULT_TOKENS = 100_000` (~400KB) for spill
/// and `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000` for per-tool truncation.
/// We use 100KB as a reasonable middle ground — large enough that typical
/// `gh pr diff` output (~50KB) stays inline, small enough to protect
/// context on smaller models.
pub const MAX_TOOL_RESULT_BYTES: usize = 100_000;

/// Spill request: a key (used as filename) and the text to spill.
pub struct SpillRequest {
    pub key: String,
    pub text: String,
}

/// Reference to a spilled file.
pub struct SpillRef {
    pub path: PathBuf,
    pub size_bytes: usize,
    pub preview: String,
}

/// Spill error.
#[derive(Debug)]
pub enum SpillError {
    Io(std::io::Error),
}

impl std::fmt::Display for SpillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "spill io: {e}"),
        }
    }
}

impl std::error::Error for SpillError {}

impl From<std::io::Error> for SpillError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
