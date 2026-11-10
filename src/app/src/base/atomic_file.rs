use std::io::Write;
use std::path::Path;

use crate::base::error::EvotError;
use crate::base::error::Result;

fn prepare_private_temp(parent: &Path, content: &[u8]) -> Result<tempfile::NamedTempFile> {
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file_mut()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temp.write_all(content)?;
    temp.flush()?;
    temp.as_file_mut().sync_all()?;
    Ok(temp)
}

fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .ok_or_else(|| EvotError::Conf(format!("state path has no parent: {}", path.display())))
}

fn sync_parent(parent: &Path) {
    // A successful rename still gives process-level atomicity on filesystems
    // that do not support directory sync, so report that durability limitation
    // without failing the write.
    match std::fs::File::open(parent).and_then(|dir| dir.sync_all()) {
        Ok(()) => {}
        Err(error) => {
            tracing::warn!(path = %parent.display(), %error, "state directory sync failed")
        }
    }
}

/// Atomically replace a private state file.
///
/// The temporary file lives in the destination directory so rename is atomic.
/// Data and the directory entry are synced before returning; readers therefore
/// see either the previous complete document or the new complete document.
pub(crate) fn write_private_atomic(path: &Path, content: &[u8]) -> Result<()> {
    let parent = parent(path)?;
    let temp = prepare_private_temp(parent, content)?;
    temp.persist(path).map_err(|error| {
        EvotError::Conf(format!(
            "failed to atomically replace {}: {}",
            path.display(),
            error.error
        ))
    })?;
    sync_parent(parent);
    Ok(())
}

/// Atomically create a private state file without replacing one that appeared
/// concurrently. Returns `true` when this call created the file.
pub(crate) fn create_private_atomic(path: &Path, content: &[u8]) -> Result<bool> {
    let parent = parent(path)?;
    let temp = prepare_private_temp(parent, content)?;
    match temp.persist_noclobber(path) {
        Ok(_) => {
            sync_parent(parent);
            Ok(true)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(EvotError::Conf(format!(
            "failed to atomically create {}: {}",
            path.display(),
            error.error
        ))),
    }
}
