//! Path guard — restricts tool file access to an allowlist of directories.

use std::path::Path;
use std::path::PathBuf;

use crate::types::ToolError;

/// Controls which filesystem paths tools are allowed to access.
///
/// - `open` mode: no restrictions (default).
/// - `restricted` mode: only paths under the configured allowlist are permitted.
///
/// Constructed by the app layer and passed to tools via `ToolContext`.
#[derive(Debug, Clone)]
pub struct PathGuard {
    /// `None` = open mode, `Some` = restricted to these canonical dirs.
    allowed_dirs: Option<Vec<PathBuf>>,
}

impl Default for PathGuard {
    fn default() -> Self {
        Self::open()
    }
}

impl PathGuard {
    /// Create an open guard — all paths allowed.
    pub fn open() -> Self {
        Self { allowed_dirs: None }
    }

    /// Create a restricted guard.
    ///
    /// `dirs` must already be canonicalized by the caller (app layer).
    pub fn restricted(dirs: Vec<PathBuf>) -> Self {
        Self {
            allowed_dirs: Some(dirs),
        }
    }

    /// Whether this guard is in restricted mode.
    pub fn is_restricted(&self) -> bool {
        self.allowed_dirs.is_some()
    }

    /// Expose allowed directories for OS sandbox integration.
    /// Returns `None` in open mode.
    pub fn allowed_dirs(&self) -> Option<&[PathBuf]> {
        self.allowed_dirs.as_deref()
    }

    /// Resolve `input` to an absolute path and verify it is inside the allowlist.
    ///
    /// - Open mode: resolves relative paths against `base_dir`, returns the
    ///   target path as-is (no canonicalization overhead).
    /// - Restricted mode: resolves the path (relative to `base_dir` if not
    ///   absolute), canonicalizes it, and checks `starts_with` against every
    ///   allowed directory.
    ///
    /// For paths that do not yet exist (new files), the nearest existing
    /// ancestor is canonicalized and checked instead.
    ///
    /// Tools must use the returned `PathBuf` for all subsequent IO — never the
    /// raw input string.
    pub fn resolve_path(&self, base_dir: &Path, input: &str) -> Result<PathBuf, ToolError> {
        let target = if Path::new(input).is_absolute() {
            PathBuf::from(input)
        } else {
            base_dir.join(input)
        };

        let dirs = match &self.allowed_dirs {
            Some(d) => d,
            None => return Ok(target),
        };

        let canonical = canonicalize_or_ancestor(&target)?;

        if dirs.iter().any(|d| canonical.starts_with(d)) {
            Ok(target)
        } else {
            Err(denied_error(input))
        }
    }

    /// Like [`resolve_path`] but treats `None` / empty input as `base_dir`.
    pub fn resolve_optional_path(
        &self,
        base_dir: &Path,
        input: Option<&str>,
    ) -> Result<PathBuf, ToolError> {
        match input {
            Some(s) if !s.is_empty() => self.resolve_path(base_dir, s),
            _ => self.resolve_path(base_dir, &base_dir.to_string_lossy()),
        }
    }
}

/// Canonicalize `path`. If it doesn't exist, walk up to the nearest existing
/// ancestor and canonicalize that (covers new-file creation).
fn canonicalize_or_ancestor(path: &Path) -> Result<PathBuf, ToolError> {
    if let Ok(c) = path.canonicalize() {
        return Ok(c);
    }

    // Walk up until we find an existing ancestor.
    let mut current = path.to_path_buf();
    while let Some(parent) = current.parent() {
        if parent == current {
            // Reached filesystem root without success.
            break;
        }
        if let Ok(c) = parent.canonicalize() {
            return Ok(c);
        }
        current = parent.to_path_buf();
    }

    Err(ToolError::Failed(format!(
        "Cannot resolve path: {}",
        path.display()
    )))
}

fn denied_error(path: &str) -> ToolError {
    ToolError::Failed(format!(
        "Access denied: {path} is outside allowed directories. \
         Check EVOT_SANDBOX and EVOT_SANDBOX_ALLOWED_DIRS."
    ))
}
