use std::path::PathBuf;

use crate::auth::types::AuthState;
use crate::auth::types::ModelsCache;
use crate::auth::types::MODELS_CACHE_SCHEMA_VERSION;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::base::paths;

pub fn auth_file_path() -> Result<PathBuf> {
    Ok(paths::state_root_dir()?.join("auth.json"))
}

pub fn models_cache_path() -> Result<PathBuf> {
    Ok(paths::state_root_dir()?.join("models.cache.json"))
}

pub fn load_auth() -> Result<Option<AuthState>> {
    let path = auth_file_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| EvotError::Conf(format!("read {}: {error}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let state = serde_json::from_str::<AuthState>(&raw)
        .map_err(|error| EvotError::Conf(format!("parse {}: {error}", path.display())))?;
    Ok(Some(state))
}

pub fn save_auth(state: &AuthState) -> Result<()> {
    let path = auth_file_path()?;
    crate::base::atomic_file::write_private_atomic(
        &path,
        serde_json::to_string_pretty(state)?.as_bytes(),
    )
}

pub fn clear_auth() -> Result<()> {
    let path = auth_file_path()?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

pub fn load_models_cache() -> Result<Option<ModelsCache>> {
    let path = models_cache_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| EvotError::Conf(format!("read {}: {error}", path.display())))?;
    let cache = serde_json::from_str::<ModelsCache>(&raw)
        .map_err(|error| EvotError::Conf(format!("parse {}: {error}", path.display())))?;
    if cache.schema_version > MODELS_CACHE_SCHEMA_VERSION {
        return Err(EvotError::Conf(format!(
            "{} uses models cache schema {}, but this client supports up to {}",
            path.display(),
            cache.schema_version,
            MODELS_CACHE_SCHEMA_VERSION
        )));
    }
    Ok(Some(cache))
}

pub fn save_models_cache(cache: &ModelsCache) -> Result<()> {
    let path = models_cache_path()?;
    let mut current = cache.clone();
    current.schema_version = MODELS_CACHE_SCHEMA_VERSION;
    crate::base::atomic_file::write_private_atomic(
        &path,
        serde_json::to_string_pretty(&current)?.as_bytes(),
    )
}
