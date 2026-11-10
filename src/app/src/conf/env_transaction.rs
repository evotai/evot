use std::path::Path;
use std::path::PathBuf;

use fs2::FileExt;
use sha2::Digest;
use sha2::Sha256;

use crate::base::error::EvotError;
use crate::base::error::Result;

/// Private, in-memory revision of exact file bytes. Never serialized or logged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EnvRevision {
    path: PathBuf,
    digest: Option<[u8; 32]>,
}

/// Cooperative file lock shared by settings writes and load-time cloud cleanup.
/// Lock the sidecar, not the env inode: atomic rename replaces the latter.
pub(crate) struct EnvTransaction {
    path: PathBuf,
    _lock: std::fs::File,
}

impl EnvTransaction {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let absolute = std::path::absolute(path)?;
        let parent = absolute
            .parent()
            .ok_or_else(|| EvotError::Conf("env path has no parent".into()))?;
        std::fs::create_dir_all(parent)?;
        let parent = std::fs::canonicalize(parent)?;
        let name = absolute
            .file_name()
            .ok_or_else(|| EvotError::Conf("env path has no file name".into()))?;
        // Resolve existing symlinks so cooperating writers share the same lock.
        let path = if absolute.exists() {
            std::fs::canonicalize(&absolute)?
        } else {
            parent.join(name)
        };
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".lock");
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(PathBuf::from(lock_name))?;
        FileExt::lock_exclusive(&lock)?;
        Ok(Self { path, _lock: lock })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn revision(&self) -> Result<EnvRevision> {
        let digest = match std::fs::read(&self.path) {
            Ok(bytes) => Some(Sha256::digest(bytes).into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(EnvRevision {
            path: self.path.clone(),
            digest,
        })
    }

    pub(crate) fn check(&self, expected: Option<&EnvRevision>) -> Result<()> {
        let current = self.revision()?;
        let conflict = match expected {
            Some(expected) => current != *expected,
            None => current.digest.is_some(),
        };
        if conflict {
            return Err(EvotError::Conf(
                "configuration changed on disk; reload settings and retry".into(),
            ));
        }
        Ok(())
    }
}
