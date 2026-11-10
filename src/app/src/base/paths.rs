use std::path::PathBuf;

use crate::base::error::EvotError;
use crate::base::error::Result;

pub fn home_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| EvotError::Conf("HOME or USERPROFILE not set".into()))?;
    Ok(PathBuf::from(home))
}

pub fn expand_home_path(value: &str) -> Result<PathBuf> {
    if value == "~" {
        return home_dir();
    }

    if let Some(stripped) = value.strip_prefix("~/") {
        return Ok(home_dir()?.join(stripped));
    }

    Ok(PathBuf::from(value))
}

pub fn state_root_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(".evotai"))
}

pub fn config_file_path() -> Result<PathBuf> {
    Ok(state_root_dir()?.join("evot.toml"))
}

pub fn default_env_file_path() -> Result<PathBuf> {
    Ok(state_root_dir()?.join("evot.env"))
}

pub fn skills_dir() -> Result<PathBuf> {
    Ok(state_root_dir()?.join("skills"))
}

/// Memory vault used by the builtin `memory` skill.
pub fn memory_dir() -> Result<PathBuf> {
    Ok(state_root_dir()?.join("memory"))
}
