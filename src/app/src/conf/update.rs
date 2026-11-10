use super::env_transaction::EnvTransaction;
use crate::base::error::Result;
use crate::conf::config_to_env_groups;
use crate::conf::Config;

/// Commit a config mutation only if the loaded env file is still current.
/// Validation and durable write finish before publishing the in-memory copy.
/// The closure cannot perform nested config I/O while the transaction is held.
pub fn update_config<T>(
    config: &mut Config,
    mutate: impl FnOnce(&mut Config) -> Result<T>,
) -> Result<T> {
    let transaction = EnvTransaction::open(&config.env_file_path)?;
    transaction.check(config.env_revision.as_ref())?;
    let mut candidate = config.clone();
    let result = mutate(&mut candidate)?;
    if candidate.env_file_path != config.env_file_path {
        return Err(crate::base::error::EvotError::Conf(
            "configuration transaction cannot change its destination path".into(),
        ));
    }
    super::env_writer::write_grouped_locked(&transaction, &config_to_env_groups(&candidate))?;
    candidate.env_revision = Some(transaction.revision()?);
    *config = candidate;
    Ok(result)
}
