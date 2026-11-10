use std::path::Path;

use fs2::FileExt;

use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::types::CloudSync;
use crate::types::SessionMeta;

pub(super) enum Edit {
    Save(Box<SessionMeta>),
    Rename(String),
    Cloud(Option<CloudSync>),
}

/// A shared process-safe transaction prevents stale active-session snapshots
/// from undoing a rename or a sync acknowledgement. Only Rename owns
/// custom_title and only Cloud owns cloud; Save owns activity.
pub(super) fn update(path: &Path, edit: Edit) -> Result<SessionMeta> {
    let parent = path
        .parent()
        .ok_or_else(|| EvotError::Store("session path has no parent".into()))?;
    if matches!(edit, Edit::Save(_)) {
        std::fs::create_dir_all(parent)?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join("metadata.lock"))?;
    lock.lock_exclusive()?;
    let result = (|| {
        let existing: Option<SessionMeta> = match std::fs::read(path) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mut next = match edit {
            Edit::Save(mut session) => {
                if let Some(current) = existing {
                    session.custom_title = current.custom_title;
                    session.cloud = current.cloud;
                }
                *session
            }
            Edit::Cloud(cloud) => {
                let mut session = existing
                    .ok_or_else(|| EvotError::Session("session no longer exists".into()))?;
                session.cloud = cloud;
                session
            }
            Edit::Rename(title) => {
                let mut session = existing
                    .ok_or_else(|| EvotError::Session("session no longer exists".into()))?;
                session.custom_title = Some(title);
                session
            }
        };
        next.schema_version = 1;
        crate::base::atomic_file::write_private_atomic(path, &serde_json::to_vec_pretty(&next)?)?;
        Ok(next)
    })();
    FileExt::unlock(&lock)?;
    result
}
