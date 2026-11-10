//! `compute.json` reads and locked read-modify-write.
//!
//! Several evot processes may edit machines at once, so every change re-reads
//! the document under an exclusive lock and writes it back atomically.

use std::path::Path;
use std::path::PathBuf;

use fs2::FileExt;

use super::model::ComputeDocument;
use super::model::ComputeMachine;
use super::model::COMPUTE_SCHEMA_VERSION;
use crate::base::error::EvotError;
use crate::base::error::Result;

pub const COMPUTE_FILE: &str = "compute.json";
const LOCK_FILE: &str = "compute.lock";

pub fn default_path() -> Result<PathBuf> {
    Ok(crate::base::paths::state_root_dir()?.join(COMPUTE_FILE))
}

/// Parse a document, mapping a missing version to legacy v0 and refusing
/// versions this build does not understand.
pub fn parse_document(content: &str) -> Result<ComputeDocument> {
    let mut document: ComputeDocument = serde_json::from_str(content)?;
    if document.version > COMPUTE_SCHEMA_VERSION {
        return Err(EvotError::Store(format!(
            "compute.json uses schema version {}, but this evot understands up to {}; update evot",
            document.version, COMPUTE_SCHEMA_VERSION
        )));
    }
    // v0 (no version field) has the same shape as v1.
    document.version = COMPUTE_SCHEMA_VERSION;
    Ok(document)
}

pub fn read_document(path: &Path) -> Result<ComputeDocument> {
    match std::fs::read_to_string(path) {
        Ok(content) => parse_document(&content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ComputeDocument {
            version: COMPUTE_SCHEMA_VERSION,
            machines: Vec::new(),
        }),
        Err(error) => Err(EvotError::Io(error)),
    }
}

fn with_lock<T>(path: &Path, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let parent = path
        .parent()
        .ok_or_else(|| EvotError::Store("compute path has no parent directory".to_string()))?;
    std::fs::create_dir_all(parent)?;
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join(LOCK_FILE))?;
    FileExt::lock_exclusive(&lock_file)?;
    let outcome = work();
    FileExt::unlock(&lock_file)?;
    outcome
}

/// Apply `edit` to the stored machines under an exclusive lock. The document
/// is written only when `edit` succeeds.
pub fn mutate<T>(
    path: &Path,
    edit: impl FnOnce(&mut Vec<ComputeMachine>) -> Result<T>,
) -> Result<(T, Vec<ComputeMachine>)> {
    with_lock(path, || {
        let mut document = read_document(path)?;
        let value = edit(&mut document.machines)?;
        document.version = COMPUTE_SCHEMA_VERSION;
        let json = serde_json::to_string_pretty(&document)?;
        crate::base::atomic_file::write_private_atomic(path, json.as_bytes())?;
        Ok((value, document.machines))
    })
}
