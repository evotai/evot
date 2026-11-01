use std::sync::Arc;

use crate::conf::StorageConfig;
use crate::error::Result;
use crate::storage::fs::FsStorage;
use crate::storage::Storage;

pub fn open_storage(conf: &StorageConfig) -> Result<Arc<dyn Storage>> {
    Ok(Arc::new(FsStorage::new(conf.fs.root_dir.clone())))
}
