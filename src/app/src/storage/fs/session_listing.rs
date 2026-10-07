use std::path::Path;

use tokio_util::sync::CancellationToken;

use crate::error::EvotError;
use crate::error::Result;
use crate::types::ListSessions;
use crate::types::SessionMeta;

/// Keep one scan on a blocking worker instead of dispatching every small read
/// and metadata lookup separately. Entered through `crate::blocking::blocking_io`,
/// which cancels the token when the caller drops the listing future.
pub(super) fn scan(
    sessions_dir: &Path,
    params: ListSessions,
    cancel: &CancellationToken,
) -> Result<Vec<SessionMeta>> {
    check_cancelled(cancel)?;
    let entries = match std::fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(EvotError::Io(error)),
    };

    let mut sessions = Vec::new();
    let mut entries = entries;
    loop {
        check_cancelled(cancel)?;
        let Some(entry) = entries.next() else {
            break;
        };
        let entry = entry?;
        // Skip non-directory entries (e.g. .DS_Store), including symlinks.
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {}
            Ok(_) => continue,
            Err(error) => {
                tracing::warn!(path = ?entry.path(), "skipping session entry: {error}");
                continue;
            }
        }
        check_cancelled(cancel)?;
        let session_dir = entry.path();
        let path = session_dir.join("session.json");
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::warn!(path = ?path, "skipping malformed session.json: {error}");
                continue;
            }
        };
        check_cancelled(cancel)?;
        let mut session: SessionMeta = match serde_json::from_str(&content) {
            Ok(session) => session,
            Err(error) => {
                tracing::warn!(path = ?path, "skipping malformed session.json: {error}");
                continue;
            }
        };
        check_cancelled(cancel)?;
        // Transcript activity remains authoritative during a run, before its
        // final metadata save. Listing never writes this adjustment to disk.
        if let Ok(metadata) = std::fs::metadata(session_dir.join("transcript.jsonl")) {
            if let Ok(modified) = metadata.modified() {
                let modified = chrono::DateTime::<chrono::Utc>::from(modified);
                let saved = chrono::DateTime::parse_from_rfc3339(&session.updated_at)
                    .ok()
                    .map(|value| value.with_timezone(&chrono::Utc));
                if saved.is_none_or(|value| modified > value) {
                    session.updated_at = modified.to_rfc3339();
                }
            }
        }
        sessions.push(session);
    }

    check_cancelled(cancel)?;
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    check_cancelled(cancel)?;
    Ok(sessions
        .into_iter()
        .skip(params.offset)
        .take(if params.limit == 0 {
            usize::MAX
        } else {
            params.limit
        })
        .collect())
}

fn check_cancelled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(crate::blocking::cancelled("session listing"));
    }
    Ok(())
}
