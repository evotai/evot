use std::collections::hash_map::DefaultHasher;
use std::hash::Hash;
use std::hash::Hasher;

use tokio::sync::Mutex;

const SHARDS: usize = 64;

/// Bounded keyed serialization. Equal keys always share a gate; unrelated keys
/// may collide and briefly serialize. Never retains historical session ids.
pub struct SessionGates {
    gates: [Mutex<()>; SHARDS],
}

impl SessionGates {
    pub fn new() -> Self {
        Self {
            gates: std::array::from_fn(|_| Mutex::new(())),
        }
    }

    pub fn gate(&self, key: &str) -> &Mutex<()> {
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        &self.gates[hasher.finish() as usize % SHARDS]
    }
}

impl Default for SessionGates {
    fn default() -> Self {
        Self::new()
    }
}
