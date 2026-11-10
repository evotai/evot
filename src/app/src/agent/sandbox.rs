//! Sandbox policy — assembles the final PathGuard from config + system dirs.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use evot_engine::PathGuard;
use evot_engine::SandboxSupport;

use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::SandboxConfig;

/// Runtime output of sandbox policy evaluation.
pub struct SandboxRuntime {
    pub path_guard: Arc<PathGuard>,
    pub allow_bash: bool,
    /// Directories the OS sandbox allows bash to access.
    /// Same as PathGuard dirs — the caller configures any extra paths via
    /// `EVOT_SANDBOX_ALLOWED_DIRS`.
    /// `None` when sandbox is disabled.
    pub bash_sandbox_dirs: Option<Vec<PathBuf>>,
}

/// Determines which directories tools are allowed to access and whether
/// bash is available.
pub struct SandboxPolicy {
    pub enabled: bool,
    pub extra_dirs: Vec<PathBuf>,
}

impl SandboxPolicy {
    pub fn from_config(config: &SandboxConfig) -> Self {
        Self {
            enabled: config.enabled,
            extra_dirs: config.allowed_dirs.clone(),
        }
    }

    /// Build the sandbox runtime: path guard + tool availability flags.
    ///
    /// - `cwd`: working directory (must exist).
    /// - `system_dirs`: system-managed directories (skill scan dirs, memory
    ///   vault); missing dirs are skipped.
    ///
    /// User-configured `extra_dirs` that don't exist cause a config error.
    pub fn build_runtime(&self, cwd: &Path, system_dirs: &[PathBuf]) -> Result<SandboxRuntime> {
        if !self.enabled {
            return Ok(SandboxRuntime {
                path_guard: Arc::new(PathGuard::open()),
                allow_bash: true,
                bash_sandbox_dirs: None,
            });
        }

        let mut dirs = Vec::new();

        // cwd — must exist
        let canonical_cwd = cwd.canonicalize().map_err(|e| {
            EvotError::Conf(format!(
                "sandbox: cannot resolve cwd {}: {e}",
                cwd.display()
            ))
        })?;
        dirs.push(canonical_cwd);

        // System dirs — skip missing
        for d in system_dirs {
            if let Ok(c) = d.canonicalize() {
                dirs.push(c);
            }
        }

        // User extra dirs — must exist
        for d in &self.extra_dirs {
            let c = d.canonicalize().map_err(|e| {
                EvotError::Conf(format!(
                    "sandbox: EVOT_SANDBOX_ALLOWED_DIRS entry {} does not exist or cannot be resolved: {e}",
                    d.display()
                ))
            })?;
            dirs.push(c);
        }

        // Deduplicate
        dirs.sort();
        dirs.dedup();

        // Check OS sandbox availability — if unavailable, disable bash
        let allow_bash = match evot_engine::check_sandbox_available() {
            SandboxSupport::Available => true,
            SandboxSupport::Unavailable(reason) => {
                tracing::warn!(
                    "OS sandbox unavailable: {reason}. Bash tool disabled in sandbox mode."
                );
                false
            }
        };

        Ok(SandboxRuntime {
            path_guard: Arc::new(PathGuard::restricted(dirs.clone())),
            allow_bash,
            bash_sandbox_dirs: if allow_bash { Some(dirs) } else { None },
        })
    }
}
