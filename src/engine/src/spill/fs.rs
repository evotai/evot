use std::path::PathBuf;

use super::types::SpillError;
use super::types::SpillRef;
use super::types::SpillRequest;

/// Local filesystem spill: writes large text to a file, returns a reference.
pub struct FsSpill {
    dir: PathBuf,
    threshold_bytes: usize,
    preview_bytes: usize,
}

impl FsSpill {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            threshold_bytes: crate::spill::MAX_TOOL_RESULT_BYTES,
            preview_bytes: 4_000,
        }
    }

    pub fn with_threshold_bytes(mut self, value: usize) -> Self {
        self.threshold_bytes = value;
        self
    }

    pub fn with_preview_bytes(mut self, value: usize) -> Self {
        self.preview_bytes = value;
        self
    }

    pub fn contains_path(&self, path: &std::path::Path) -> bool {
        path.starts_with(&self.dir)
    }

    /// Path a spill file for `key` would occupy, reusing the shared key
    /// sanitization. Safe to call before any write.
    pub fn path_for_key(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{}.txt", sanitize_key(key)))
    }

    /// Write `text` to a spill file unconditionally, ignoring the size
    /// threshold. The caller decides when persistence is warranted (e.g. a
    /// tool that already truncated its own displayed output). Reuses the same
    /// key sanitization, directory handling, and preview logic as [`spill`].
    pub async fn spill_text(&self, key: &str, text: &str) -> Result<SpillRef, SpillError> {
        let path = self.path_for_key(key);

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&path, text).await?;

        Ok(SpillRef {
            size_bytes: text.len(),
            path,
            preview: make_preview(text, self.preview_bytes),
        })
    }

    pub async fn spill(&self, req: SpillRequest) -> Result<Option<SpillRef>, SpillError> {
        if req.text.len() <= self.threshold_bytes {
            return Ok(None);
        }
        Ok(Some(self.spill_text(&req.key, &req.text).await?))
    }
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn make_preview(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let boundary = text.floor_char_boundary(max_bytes);
    let cut = text[..boundary].rfind('\n').unwrap_or(boundary);
    text[..cut].to_string()
}
