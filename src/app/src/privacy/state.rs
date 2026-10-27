//! Tool-effect bookkeeping, independent of reversible placeholder bindings.
//! Ownership remains process-wide through the existing Vault: this refactor
//! does not change restoration scope or discard old sessions' mappings.
use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::RwLock;

const MAX_ENTRIES: usize = 100_000;

#[derive(Default)]
pub(super) struct EgressState {
    inner: RwLock<State>,
}

#[derive(Default)]
struct State {
    paths: HashSet<String>,
    /// Readers clone this Arc, not every path on every tool call.
    names: Arc<HashSet<String>>,
    secret_env: HashSet<String>,
}

impl EgressState {
    pub fn taint(&self, path: &str) {
        let mut state = self.inner.write();
        if state.paths.contains(path) {
            return;
        }
        // Preserve the existing quota policy; changing overflow enforcement
        // would change authorization and belongs in a separate rollout.
        if state.paths.len() >= MAX_ENTRIES {
            state.paths.clear();
            state.names = Arc::default();
        }
        if let Some(name) = path.rsplit('/').next() {
            Arc::make_mut(&mut state.names).insert(name.to_string());
        }
        state.paths.insert(path.to_string());
    }

    pub fn names(&self) -> Arc<HashSet<String>> {
        self.inner.read().names.clone()
    }

    pub fn is_tainted(&self, path: &str) -> bool {
        self.inner.read().paths.contains(path)
    }

    pub fn remember_env(&self, name: &str) {
        if name.is_empty() {
            return;
        }
        let mut state = self.inner.write();
        if state.secret_env.contains(name) {
            return;
        }
        if state.secret_env.len() >= MAX_ENTRIES {
            state.secret_env.clear();
        }
        state.secret_env.insert(name.to_string());
    }

    pub fn is_secret_env(&self, name: &str) -> bool {
        self.inner.read().secret_env.contains(name)
    }
}
