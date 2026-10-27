//! Where packs come from: the built-in JSON files (compiled in) and the
//! user's `~/.evotai/privacy/rules/*.json`.
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::SystemTime;

use tokio_util::sync::CancellationToken;

use super::pack::Pack;
use crate::error::EvotError;
use crate::error::Result;

/// In merge order: `core` defines the kinds, sources and structure the
/// others build on.
const BUILTIN: &[(&str, &str)] = &[
    ("core.json", include_str!("data/core.json")),
    ("secrets.json", include_str!("data/secrets.json")),
    ("cn-cloud.json", include_str!("data/cn-cloud.json")),
    ("betterleaks.json", include_str!("data/betterleaks.json")),
    ("personal.json", include_str!("data/personal.json")),
];

/// Dropped from a pack's text before parsing. Example values are shaped
/// exactly like real keys, which trips secret scanners on the way into
/// the repository; `<cut>` inside one keeps it from matching at rest.
pub const CUT: &str = "<cut>";

fn parse(name: &str, text: &str) -> Result<Pack> {
    let text = text.replace(CUT, "");
    serde_json::from_str(&text)
        .map_err(|e| EvotError::Conf(format!("privacy rule pack {name} is invalid: {e}")))
}

pub(in crate::privacy) fn builtin_packs() -> Result<&'static [Pack]> {
    static PACKS: OnceLock<std::result::Result<Vec<Pack>, String>> = OnceLock::new();
    let packs = PACKS.get_or_init(|| {
        BUILTIN
            .iter()
            .map(|(name, text)| parse(name, text).map_err(|e| e.to_string()))
            .collect()
    });
    match packs {
        Ok(packs) => Ok(packs),
        Err(e) => Err(EvotError::Conf(e.clone())),
    }
}

/// Metadata identity detects atomic replacements as well as edits. No file
/// contents or user secrets are retained in the cache key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::privacy) struct FileStamp {
    modified: SystemTime,
    len: u64,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

pub(in crate::privacy) fn file_stamp(path: &Path) -> Result<Option<FileStamp>> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(Some(FileStamp {
        modified: metadata.modified()?,
        len: metadata.len(),
        #[cfg(unix)]
        identity: (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ),
    }))
}

pub(in crate::privacy) type UserStamp = Vec<(PathBuf, Option<FileStamp>)>;

fn user_files(dir: &Path, cancel: &CancellationToken) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut files = Vec::new();
    for entry in entries {
        if cancel.is_cancelled() {
            return Err(crate::blocking::cancelled("privacy rules"));
        }
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

/// The user's packs, in file-name order. One that does not parse fails
/// them all: a pack the user wrote is a rule they expect to hold.
pub(in crate::privacy) fn read_user_packs(
    files: &UserStamp,
    cancel: &CancellationToken,
) -> Result<Vec<Pack>> {
    let mut packs = Vec::new();
    for (path, _) in files {
        if cancel.is_cancelled() {
            return Err(crate::blocking::cancelled("privacy rules"));
        }
        packs.push(parse(
            &path.display().to_string(),
            &std::fs::read_to_string(path)?,
        )?);
    }
    Ok(packs)
}

/// What changes when a user pack is added, edited or removed. Errors must
/// not masquerade as an empty directory and reuse an unrelated cache entry.
pub(in crate::privacy) fn user_stamp(dir: &Path, cancel: &CancellationToken) -> Result<UserStamp> {
    if cancel.is_cancelled() {
        return Err(crate::blocking::cancelled("privacy rules"));
    }
    let mut stamp = Vec::new();
    for path in user_files(dir, cancel)? {
        if cancel.is_cancelled() {
            return Err(crate::blocking::cancelled("privacy rules"));
        }
        let modified = file_stamp(&path)?;
        stamp.push((path, modified));
    }
    Ok(stamp)
}
