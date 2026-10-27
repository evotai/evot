//! Tool-effect bookkeeping, independent of reversible placeholder bindings.
//! Ownership remains process-wide through the existing Vault: this refactor
//! does not change restoration scope or discard old sessions' mappings.
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::RwLock;

const MAX_ENTRIES: usize = 100_000;

/// Why a file counts as holding a secret: which call put it there and
/// what it found. Shown to the user when a later call is refused for
/// reading the file, so it holds nothing of the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaintOrigin {
    /// The kind found (`API_KEY`, `PRIVATE_KEY`).
    pub kind: String,
    /// The pack rule that found it, when one did.
    pub rule: Option<String>,
    /// The tool that wrote the file (`write`, `bash`).
    pub tool: String,
}

#[derive(Default)]
pub(super) struct EgressState {
    inner: RwLock<State>,
}

#[derive(Default)]
struct State {
    paths: HashMap<String, TaintOrigin>,
    /// Readers clone this Arc, not every path on every tool call.
    names: Arc<HashSet<String>>,
    secret_env: HashSet<String>,
}

fn name_of(path: &str) -> Option<&str> {
    path.rsplit('/').next().filter(|name| !name.is_empty())
}

impl EgressState {
    pub fn taint(&self, path: &str, origin: TaintOrigin) {
        let mut state = self.inner.write();
        if state.paths.contains_key(path) {
            return;
        }
        // Preserve the existing quota policy; changing overflow enforcement
        // would change authorization and belongs in a separate rollout.
        if state.paths.len() >= MAX_ENTRIES {
            state.paths.clear();
            state.names = Arc::default();
        }
        if let Some(name) = name_of(path) {
            Arc::make_mut(&mut state.names).insert(name.to_string());
        }
        state.paths.insert(path.to_string(), origin);
    }

    /// Forget that `path` holds a secret. `true` when it was marked.
    pub fn untaint(&self, path: &str) -> bool {
        let mut state = self.inner.write();
        if state.paths.remove(path).is_none() {
            return false;
        }
        let names: HashSet<String> = state
            .paths
            .keys()
            .filter_map(|p| name_of(p))
            .map(str::to_string)
            .collect();
        state.names = Arc::new(names);
        true
    }

    pub fn names(&self) -> Arc<HashSet<String>> {
        self.inner.read().names.clone()
    }

    pub fn origin(&self, path: &str) -> Option<TaintOrigin> {
        self.inner.read().paths.get(path).cloned()
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
