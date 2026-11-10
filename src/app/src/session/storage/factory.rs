use std::sync::Arc;

use crate::base::error::Result;
use crate::conf::StorageConfig;
use crate::session::storage::fs::FsStorage;
use crate::session::storage::Storage;

pub fn open_storage(conf: &StorageConfig) -> Result<Arc<dyn Storage>> {
    Ok(Arc::new(FsStorage::new(conf.fs.root_dir.clone())))
}
