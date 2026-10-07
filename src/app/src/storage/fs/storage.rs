use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use fs2::FileExt;
use tokio::fs;

use crate::error::EvotError;
use crate::error::Result;
use crate::search::SessionWithText;
use crate::storage::Storage;
use crate::types::ListSessions;
use crate::types::ListTranscriptEntries;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::VariableRecord;
use crate::types::VariablesDocument;

pub struct FsStorage {
    root_dir: PathBuf,
}

impl FsStorage {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.root_dir.join("sessions")
    }

    /// Resolve a session's directory, rejecting IDs that are not well-formed.
    ///
    /// This is the single point where an (possibly untrusted) session ID is
    /// joined to a filesystem path, so the validation that prevents path
    /// traversal lives here and covers every read and write path builder.
    fn session_dir(&self, session_id: &str) -> Result<PathBuf> {
        if !crate::types::is_valid_id(session_id) {
            return Err(EvotError::Store(format!(
                "invalid session id: {session_id:?}"
            )));
        }
        Ok(self.sessions_dir().join(session_id))
    }

    fn session_meta_path(&self, session_id: &str) -> Result<PathBuf> {
        Ok(self.session_dir(session_id)?.join("session.json"))
    }

    fn transcript_path(&self, session_id: &str) -> Result<PathBuf> {
        Ok(self.session_dir(session_id)?.join("transcript.jsonl"))
    }

    fn variables_path(&self) -> PathBuf {
        self.root_dir.join("variables.json")
    }

    async fn read_json<T: serde::de::DeserializeOwned>(&self, path: &Path) -> Result<Option<T>> {
        match fs::read_to_string(path).await {
            Ok(content) => Ok(Some(serde_json::from_str(&content)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(EvotError::Io(e)),
        }
    }

    async fn append_transcript_batch(
        &self,
        path: PathBuf,
        expected_seq: Option<u64>,
        entries: Vec<TranscriptEntry>,
    ) -> Result<bool> {
        if entries.is_empty() {
            return Ok(true);
        }
        let mut line = serde_json::to_vec(&entries)?;
        line.push(b'\n');

        tokio::task::spawn_blocking(move || -> Result<bool> {
            use std::io::Write;

            let Some(parent) = path.parent() else {
                return Err(EvotError::Store(
                    "transcript path has no parent directory".to_string(),
                ));
            };
            std::fs::create_dir_all(parent)?;
            let lock_path = parent.join("transcript.lock");
            let lock_file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(lock_path)?;
            lock_file.lock_exclusive()?;

            ensure_current_transcript_format(&path)?;
            truncate_incomplete_tail(&path)?;
            let persisted_seq = read_current_tail_seq(&path)?;

            if let Some(expected) = expected_seq {
                let first_seq = entries.first().map(|entry| entry.seq).unwrap_or(0);
                if persisted_seq != expected || first_seq != expected.saturating_add(1) {
                    FileExt::unlock(&lock_file)?;
                    return Ok(false);
                }
            }

            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            file.write_all(&line)?;
            FileExt::unlock(&lock_file)?;
            Ok(true)
        })
        .await
        .map_err(|error| EvotError::Store(format!("transcript writer task failed: {error}")))?
    }

    async fn read_transcript(&self, path: PathBuf) -> Result<Vec<TranscriptEntry>> {
        tokio::task::spawn_blocking(move || -> Result<Vec<TranscriptEntry>> {
            let Some(parent) = path.parent() else {
                return Err(EvotError::Store(
                    "transcript path has no parent directory".to_string(),
                ));
            };
            std::fs::create_dir_all(parent)?;
            let lock_file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(parent.join("transcript.lock"))?;
            FileExt::lock_exclusive(&lock_file)?;
            ensure_current_transcript_format(&path)?;
            truncate_incomplete_tail(&path)?;
            let content = match std::fs::read(&path) {
                Ok(content) => content,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => return Err(EvotError::Io(error)),
            };
            let entries = parse_current_transcript(&content)?;
            FileExt::unlock(&lock_file)?;
            Ok(entries)
        })
        .await
        .map_err(|error| EvotError::Store(format!("transcript reader task failed: {error}")))?
    }

    async fn read_active_transcript(&self, path: PathBuf) -> Result<Vec<TranscriptEntry>> {
        tokio::task::spawn_blocking(move || -> Result<Vec<TranscriptEntry>> {
            let Some(parent) = path.parent() else {
                return Err(EvotError::Store(
                    "transcript path has no parent directory".to_string(),
                ));
            };
            std::fs::create_dir_all(parent)?;
            let lock_file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(parent.join("transcript.lock"))?;
            FileExt::lock_exclusive(&lock_file)?;

            ensure_current_transcript_format(&path)?;
            truncate_incomplete_tail(&path)?;
            let entries = read_current_active_tail(&path)?;

            FileExt::unlock(&lock_file)?;
            Ok(entries)
        })
        .await
        .map_err(|error| {
            EvotError::Store(format!("active transcript reader task failed: {error}"))
        })?
    }
}

const ACTIVE_TAIL_INITIAL_BYTES: u64 = 64 * 1024;

/// Apply `edit` to the persisted variable set under an exclusive lock.
///
/// Variables are edited by long-lived processes that each hold their own
/// in-memory copy, so writing back a whole snapshot would silently drop keys
/// another process added. Re-reading inside the lock keeps each edit scoped to
/// the key it touches. Returns the edit's own verdict plus the merged set.
fn mutate_variables(
    path: &Path,
    edit: impl FnOnce(&mut Vec<VariableRecord>) -> bool,
) -> Result<(bool, Vec<VariableRecord>)> {
    let parent = path
        .parent()
        .ok_or_else(|| EvotError::Store("variables path has no parent directory".to_string()))?;
    std::fs::create_dir_all(parent)?;

    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join("variables.lock"))?;
    FileExt::lock_exclusive(&lock_file)?;

    let outcome = (|| -> Result<(bool, Vec<VariableRecord>)> {
        let mut records = match std::fs::read_to_string(path) {
            Ok(content) => serde_json::from_str::<VariablesDocument>(&content)?.variables,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(EvotError::Io(error)),
        };

        let changed = edit(&mut records);
        if changed {
            let doc = VariablesDocument {
                version: 1,
                variables: records.clone(),
            };
            let json = serde_json::to_string_pretty(&doc)?;
            crate::atomic_file::write_private_atomic(path, json.as_bytes())?;
        }
        Ok((changed, records))
    })();

    FileExt::unlock(&lock_file)?;
    outcome
}

fn unsupported_transcript(error: impl std::fmt::Display) -> EvotError {
    EvotError::Store(format!(
        "unsupported transcript format (expected JSON array batches): {error}"
    ))
}

fn ensure_current_transcript_format(path: &Path) -> Result<()> {
    use std::io::Read;

    let mut file = match std::fs::OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(EvotError::Io(error)),
    };
    let mut buffer = [0_u8; 4096];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        if let Some(first) = buffer[..read]
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace())
        {
            if first == b'[' {
                return Ok(());
            }
            drop(file);
            let content = std::fs::read(path)?;
            super::migrate::migrate_if_needed(path, content)?;
            return Ok(());
        }
    }
}

/// Remove a final partial batch left by an interrupted append. Current writers
/// always terminate complete batches with a newline, so non-newline data after
/// the last newline is unambiguously incomplete.
fn truncate_incomplete_tail(path: &Path) -> Result<()> {
    use std::io::Read;
    use std::io::Seek;
    use std::io::SeekFrom;

    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(EvotError::Io(error)),
    };
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0_u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        return Ok(());
    }

    let mut end = file_len;
    let mut buffer = vec![0_u8; ACTIVE_TAIL_INITIAL_BYTES as usize];
    loop {
        let start = end.saturating_sub(buffer.len() as u64);
        let len = usize::try_from(end - start).map_err(|_| {
            EvotError::Store("transcript tail is too large for this platform".to_string())
        })?;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer[..len])?;
        if let Some(index) = buffer[..len].iter().rposition(|byte| *byte == b'\n') {
            file.set_len(start + index as u64 + 1)?;
            return Ok(());
        }
        if start == 0 {
            file.set_len(0)?;
            return Ok(());
        }
        end = start;
    }
}

/// Read the sequence number from the final complete batch only.
fn read_current_tail_seq(path: &Path) -> Result<u64> {
    use std::io::Read;
    use std::io::Seek;
    use std::io::SeekFrom;

    let mut file = match std::fs::OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(EvotError::Io(error)),
    };
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(0);
    }

    let mut window = ACTIVE_TAIL_INITIAL_BYTES.min(file_len);
    loop {
        let start = file_len - window;
        let len = usize::try_from(window).map_err(|_| {
            EvotError::Store("transcript tail is too large for this platform".to_string())
        })?;
        let mut content = vec![0_u8; len];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut content)?;
        let end = content
            .iter()
            .rposition(|byte| !byte.is_ascii_whitespace())
            .map(|index| index + 1)
            .unwrap_or(0);
        if end == 0 {
            if start == 0 {
                return Ok(0);
            }
        } else {
            let line_start = content[..end]
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map(|index| index + 1);
            if let Some(line_start) = line_start.or((start == 0).then_some(0)) {
                let batch: Vec<TranscriptEntry> = serde_json::from_slice(&content[line_start..end])
                    .map_err(unsupported_transcript)?;
                validate_stored_batch(&batch)?;
                return Ok(batch.last().map(|entry| entry.seq).unwrap_or(0));
            }
        }
        if start == 0 {
            return Ok(0);
        }
        window = window.saturating_mul(2).min(file_len);
    }
}

/// Read backwards in geometrically growing windows until the latest control
/// point is found. A compact snapshot makes every earlier byte irrelevant to
/// session resume, so a large append-only transcript normally needs only its
/// final few lines decoded.
fn read_current_active_tail(path: &Path) -> Result<Vec<TranscriptEntry>> {
    use std::io::Read;
    use std::io::Seek;
    use std::io::SeekFrom;

    let mut file = match std::fs::OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(EvotError::Io(error)),
    };
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(Vec::new());
    }

    let mut window = ACTIVE_TAIL_INITIAL_BYTES.min(file_len);
    loop {
        let offset = file_len.saturating_sub(window);
        // Include the preceding byte so an offset exactly at a line boundary
        // does not cause that complete line to be discarded as partial.
        let read_start = offset.saturating_sub(1);
        let read_len = usize::try_from(file_len.saturating_sub(read_start)).map_err(|_| {
            EvotError::Store("transcript tail is too large for this platform".to_string())
        })?;
        let mut content = vec![0_u8; read_len];
        file.seek(SeekFrom::Start(read_start))?;
        file.read_exact(&mut content)?;

        let complete_start = if read_start == 0 {
            0
        } else if content.first() == Some(&b'\n') {
            1
        } else {
            content
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(content.len())
        };

        let mut entries = Vec::new();
        for line in content[complete_start..].split(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let batch: Vec<TranscriptEntry> =
                serde_json::from_slice(line).map_err(unsupported_transcript)?;
            validate_stored_batch(&batch)?;
            entries.extend(batch);
        }
        validate_stored_sequence(&entries)?;

        if let Some(control_index) = entries.iter().rposition(|entry| {
            matches!(
                entry.item,
                crate::types::TranscriptItem::Compact { .. }
                    | crate::types::TranscriptItem::Marker { .. }
            )
        }) {
            return Ok(entries.split_off(control_index));
        }
        if offset == 0 {
            return Ok(entries);
        }
        window = window.saturating_mul(2).min(file_len);
    }
}

fn parse_current_transcript(content: &[u8]) -> Result<Vec<TranscriptEntry>> {
    let mut entries = Vec::new();
    for line in content.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let batch: Vec<TranscriptEntry> =
            serde_json::from_slice(line).map_err(unsupported_transcript)?;
        validate_stored_batch(&batch)?;
        entries.extend(batch);
    }
    validate_stored_sequence(&entries)?;
    Ok(entries)
}

fn validate_stored_batch(entries: &[TranscriptEntry]) -> Result<()> {
    if entries.is_empty() {
        return Err(unsupported_transcript("empty transcript batch"));
    }
    let session_id = &entries[0].session_id;
    validate_transcript_batch(entries, session_id)
}

fn validate_stored_sequence(entries: &[TranscriptEntry]) -> Result<()> {
    if entries
        .windows(2)
        .any(|pair| pair[1].seq != pair[0].seq.saturating_add(1))
    {
        return Err(unsupported_transcript(
            "transcript sequence numbers are not contiguous",
        ));
    }
    Ok(())
}

fn validate_transcript_batch(entries: &[TranscriptEntry], session_id: &str) -> Result<()> {
    if entries.iter().any(|entry| entry.session_id != session_id) {
        return Err(EvotError::Store(
            "transcript batch contains multiple session ids".to_string(),
        ));
    }
    if entries
        .windows(2)
        .any(|pair| pair[1].seq != pair[0].seq.saturating_add(1))
    {
        return Err(EvotError::Store(
            "transcript batch sequence numbers are not contiguous".to_string(),
        ));
    }
    Ok(())
}

#[async_trait]
impl Storage for FsStorage {
    async fn save_session(&self, session: SessionMeta) -> Result<()> {
        let path = self.session_meta_path(&session.session_id)?;
        tokio::task::spawn_blocking(move || {
            super::session_meta::update(&path, super::session_meta::Edit::Save(Box::new(session)))
        })
        .await
        .map_err(|e| EvotError::Store(e.to_string()))??;
        Ok(())
    }

    async fn rename_session(&self, session_id: &str, title: &str) -> Result<SessionMeta> {
        let path = self.session_meta_path(session_id)?;
        let title = crate::storage::session_title::validate(title)?;
        tokio::task::spawn_blocking(move || {
            super::session_meta::update(&path, super::session_meta::Edit::Rename(title))
        })
        .await
        .map_err(|e| EvotError::Store(e.to_string()))?
    }

    async fn set_session_cloud(
        &self,
        session_id: &str,
        cloud: Option<crate::types::CloudSync>,
    ) -> Result<SessionMeta> {
        let path = self.session_meta_path(session_id)?;
        tokio::task::spawn_blocking(move || {
            super::session_meta::update(&path, super::session_meta::Edit::Cloud(cloud))
        })
        .await
        .map_err(|e| EvotError::Store(e.to_string()))?
    }

    async fn get_session(&self, session_id: &str) -> Result<Option<SessionMeta>> {
        self.read_json(&self.session_meta_path(session_id)?).await
    }

    async fn session_has_entries(&self, session_id: &str) -> Result<bool> {
        let path = self.transcript_path(session_id)?;
        match fs::metadata(path).await {
            Ok(metadata) => Ok(metadata.len() > 0),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(EvotError::Io(error)),
        }
    }

    async fn list_sessions(&self, params: ListSessions) -> Result<Vec<SessionMeta>> {
        let sessions_dir = self.sessions_dir();
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        tokio::task::spawn_blocking(move || {
            super::session_listing::scan(&sessions_dir, params, &cancel)
        })
        .await
        .map_err(|error| EvotError::Store(format!("session listing task failed: {error}")))?
    }

    async fn delete_session(&self, session_id: &str) -> Result<bool> {
        let dir = self.session_dir(session_id)?;
        match fs::remove_dir_all(&dir).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(EvotError::Io(e)),
        }
    }

    async fn append_entries(&self, entries: Vec<TranscriptEntry>) -> Result<()> {
        let Some(first) = entries.first() else {
            return Ok(());
        };
        validate_transcript_batch(&entries, &first.session_id)?;
        let expected_seq = first.seq.saturating_sub(1);
        if !self
            .append_transcript_batch(
                self.transcript_path(&first.session_id)?,
                Some(expected_seq),
                entries,
            )
            .await?
        {
            return Err(EvotError::Store(format!(
                "transcript sequence conflict: expected seq {expected_seq}"
            )));
        }
        Ok(())
    }

    async fn compare_and_append_entries(
        &self,
        expected_seq: u64,
        entries: Vec<TranscriptEntry>,
    ) -> Result<bool> {
        let Some(first) = entries.first() else {
            return Ok(true);
        };
        validate_transcript_batch(&entries, &first.session_id)?;
        self.append_transcript_batch(
            self.transcript_path(&first.session_id)?,
            Some(expected_seq),
            entries,
        )
        .await
    }

    async fn list_entries(&self, params: ListTranscriptEntries) -> Result<Vec<TranscriptEntry>> {
        let mut entries = self
            .read_transcript(self.transcript_path(&params.session_id)?)
            .await?;

        if let Some(run_id) = &params.run_id {
            entries.retain(|entry| entry.run_id.as_ref() == Some(run_id));
        }
        if let Some(after_seq) = params.after_seq {
            entries.retain(|entry| entry.seq > after_seq);
        }
        if let Some(limit) = params.limit {
            entries.truncate(limit);
        }

        Ok(entries)
    }

    async fn load_active_entries(&self, session_id: &str) -> Result<Vec<TranscriptEntry>> {
        self.read_active_transcript(self.transcript_path(session_id)?)
            .await
    }

    async fn load_variables(&self) -> Result<Vec<VariableRecord>> {
        match self
            .read_json::<VariablesDocument>(&self.variables_path())
            .await?
        {
            Some(doc) => Ok(doc.variables),
            None => Ok(Vec::new()),
        }
    }

    async fn upsert_variable(&self, record: VariableRecord) -> Result<Vec<VariableRecord>> {
        let path = self.variables_path();
        tokio::task::spawn_blocking(move || {
            mutate_variables(&path, |records| {
                match records.iter_mut().find(|item| item.key == record.key) {
                    Some(existing) => {
                        existing.value = record.value;
                        existing.updated_at = record.updated_at;
                    }
                    None => records.push(record),
                }
                true
            })
        })
        .await
        .map_err(|error| EvotError::Store(format!("variables writer task failed: {error}")))?
        .map(|(_, records)| records)
    }

    async fn remove_variable(&self, key: String) -> Result<(bool, Vec<VariableRecord>)> {
        let path = self.variables_path();
        tokio::task::spawn_blocking(move || {
            mutate_variables(&path, |records| {
                let before = records.len();
                records.retain(|item| item.key != key);
                records.len() < before
            })
        })
        .await
        .map_err(|error| EvotError::Store(format!("variables writer task failed: {error}")))?
    }

    async fn list_sessions_with_text(&self, limit: usize) -> Result<Vec<SessionWithText>> {
        // Filter drafts before applying the caller's limit. Otherwise recent
        // abandoned drafts can consume the whole page and hide real sessions.
        let sessions = self
            .list_sessions(ListSessions {
                limit: 0,
                offset: 0,
            })
            .await?;
        let mut result = Vec::new();

        for session in sessions {
            if session.turns == 0
                && session.title.is_none()
                && !self.session_has_entries(&session.session_id).await?
            {
                continue;
            }
            let entries = self.session_entries_for_text(&session.session_id).await;
            result.push(SessionWithText::extract(session, &entries));
            if limit > 0 && result.len() == limit {
                break;
            }
        }

        Ok(result)
    }

    async fn session_with_text(&self, session_id: &str) -> Result<Option<SessionWithText>> {
        let Some(session) = self.get_session(session_id).await? else {
            return Ok(None);
        };
        let entries = self.session_entries_for_text(session_id).await;
        Ok(Some(SessionWithText::extract(session, &entries)))
    }
}

impl FsStorage {
    /// Transcript entries for text extraction, or an empty list when the file
    /// is unreadable. A single corrupt transcript must not fail the listing it
    /// appears in, so the session is kept with whatever metadata it has.
    async fn session_entries_for_text(&self, session_id: &str) -> Vec<TranscriptEntry> {
        match self.transcript_path(session_id) {
            Ok(path) => match self.read_transcript(path).await {
                Ok(entries) => entries,
                Err(error) => {
                    tracing::warn!(session_id = %session_id, "skipping transcript: {error}");
                    Vec::new()
                }
            },
            Err(error) => {
                tracing::warn!(session_id = %session_id, "skipping session with invalid id: {error}");
                Vec::new()
            }
        }
    }
}
