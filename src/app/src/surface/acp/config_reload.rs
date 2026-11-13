//! Request-boundary refresh of the files behind a long-lived ACP connection.
//! File stamps and parsing share one blocking worker. The first request always
//! reloads: a startup Config cannot prove which file revisions it read.

use std::path::PathBuf;
use std::time::SystemTime;

use tokio_util::sync::CancellationToken;

use crate::base::blocking::cancelled;
use crate::base::error::Result;
use crate::conf::Config;

const LABEL: &str = "acp config reload";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    modified: SystemTime,
    len: u64,
    inode: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Observed(Vec<Option<Stamp>>);

#[derive(Clone, Debug)]
pub(super) struct ConfigFiles {
    env_file: PathBuf,
    paths: Vec<PathBuf>,
    loaded: Option<Observed>,
}

impl ConfigFiles {
    /// In-memory configurations have no disk owner and must not be replaced.
    pub(super) fn for_config(config: &Config) -> Result<Option<Self>> {
        if config.env_file_path.as_os_str().is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            env_file: config.env_file_path.clone(),
            paths: vec![
                config.env_file_path.clone(),
                crate::auth::models_cache_path()?,
                crate::auth::auth_file_path()?,
                crate::base::paths::config_file_path()?,
            ],
            loaded: None,
        }))
    }

    pub(super) fn reload(&self, cancel: &CancellationToken) -> Result<Option<(Config, Observed)>> {
        let observed = observe(&self.paths, cancel)?;
        if self.loaded.as_ref() == Some(&observed) {
            return Ok(None);
        }
        let fresh = Config::load_with_env_file(self.env_file.to_str())?;
        if cancel.is_cancelled() {
            return Err(cancelled(LABEL));
        }
        // Accept the pre-load stamps, not post-load stamps: a concurrent write
        // must cause another refresh rather than bless an unproven snapshot.
        Ok(Some((fresh, observed)))
    }

    pub(super) fn accept(&mut self, observed: Observed) {
        self.loaded = Some(observed);
    }
}

fn observe(paths: &[PathBuf], cancel: &CancellationToken) -> Result<Observed> {
    let mut stamps = Vec::with_capacity(paths.len());
    for path in paths {
        if cancel.is_cancelled() {
            return Err(cancelled(LABEL));
        }
        let stamp = match std::fs::metadata(path) {
            Ok(metadata) => Some(Stamp {
                modified: metadata.modified()?,
                len: metadata.len(),
                inode: inode(&metadata),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        stamps.push(stamp);
    }
    Ok(Observed(stamps))
}

#[cfg(unix)]
fn inode(metadata: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(metadata)
}

#[cfg(not(unix))]
fn inode(_metadata: &std::fs::Metadata) -> u64 {
    0
}
