mod apply_env;
mod cloud;
mod env_file;
mod env_keys;
mod providers;
mod source;

use self::apply_env::apply_env;
use self::cloud::apply_cloud_provider;
use self::cloud::reconcile_cloud_env;
use self::env_file::ensure_env_file;
use self::env_file::load_env_file;
use self::env_file::load_process_env;
use self::source::load_file_source;
use crate::conf::default_config;
use crate::conf::paths;
use crate::conf::Config;
use crate::error::Result;

pub(super) fn load_config_inner(env_file: Option<&str>) -> Result<Config> {
    let mut config = default_config()?;

    // 1. TOML
    let file_source = load_file_source(&paths::config_file_path()?)?;
    file_source.apply(&mut config)?;

    // 2. Env file
    let (env_path, is_custom_env) = match env_file {
        Some(path) => (paths::expand_home_path(path)?, true),
        None => (paths::default_env_file_path()?, false),
    };
    if is_custom_env {
        if !env_path.exists() {
            return Err(crate::error::EvotError::Conf(format!(
                "env file not found: {}",
                env_path.display()
            )));
        }
    } else {
        ensure_env_file(&env_path)?;
    }
    let transaction = super::env_transaction::EnvTransaction::open(&env_path)?;
    let env_file_vars = load_env_file(transaction.path())?;
    apply_env(&mut config, &env_file_vars)?;

    config.env_file_path = env_path;

    // 3. Process env (highest priority)
    let process_vars = load_process_env();
    apply_env(&mut config, &process_vars)?;

    // Default provider: if not explicitly set, use the first registered provider
    if config.llm.provider.is_empty() {
        if let Some(first) = config.providers.keys().next() {
            config.llm.provider = first.clone();
        }
    }

    apply_cloud_provider(&mut config)?;
    reconcile_cloud_env(&mut config, &env_file_vars, &transaction);
    config.env_revision = Some(transaction.revision()?);

    if !config.providers.contains_key(&config.llm.provider) {
        if let Some(first) = config.providers.keys().next() {
            config.llm.provider = first.clone();
        }
    }

    // Apply instance isolation: if EVOT_ID is set, redirect fs storage
    if let Some(ref id) = config.id {
        let isolated_root = paths::state_root_dir()?.join(id);
        config.storage.fs.root_dir = isolated_root;
    }

    Ok(config)
}
