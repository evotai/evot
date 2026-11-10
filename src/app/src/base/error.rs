use std::io;

#[derive(Debug, thiserror::Error)]
pub enum EvotError {
    #[error("conf error: {0}")]
    Conf(String),

    #[error("session error: {0}")]
    Session(String),

    #[error("run error: {0}")]
    Run(String),

    #[error("store error: {0}")]
    Store(String),

    #[error("io error: {0}")]
    Io(#[from] io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("agent error: {0}")]
    Agent(String),

    #[error("cli error: {0}")]
    Cli(String),

    /// Privacy stopped it: a blocked kind, or masking that could not run.
    /// Shown as written; the CLI reads it back to show the privacy card.
    #[error("{0}")]
    Privacy(String),
}

pub type Result<T> = std::result::Result<T, EvotError>;
