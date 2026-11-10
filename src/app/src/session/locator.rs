//! Session locator — maps external conversation identity to a deterministic session ID.
//!
//! All channels construct a `SessionLocator` to identify a conversation.
//! The system derives a stable, deterministic session ID from it so that
//! restarting the process automatically resumes the same session.

use sha2::Digest;
use sha2::Sha256;

/// Identifies an external conversation. Channels construct this to describe
/// "who is talking, in what context."
///
/// # Scope conventions
///
/// Use colon-separated key-value pairs in fixed order:
///
/// - Direct message:  `chat:<chat_id>:user:<user_id>`
/// - Group message:   `chat:<chat_id>:user:<user_id>`
/// - Topic / thread:  `chat:<chat_id>:topic:<topic_id>`
/// - HTTP session:    `conversation:<id>`
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionLocator {
    kind: String,
    scope: String,
}

impl SessionLocator {
    pub fn new(kind: &str, scope: &str) -> Self {
        Self {
            kind: kind.to_string(),
            scope: scope.to_string(),
        }
    }

    /// Stable string representation used for serialization keys and source metadata.
    pub fn stable_key(&self) -> String {
        format!("{}:{}", self.kind, self.scope)
    }

    /// Derive a deterministic session ID from this locator.
    /// Uses SHA-256 (first 16 bytes / 32 hex chars) for cross-version stability.
    pub fn session_id(&self) -> String {
        let hash = Sha256::digest(self.stable_key().as_bytes());
        format!("ch_{}", hex_encode(&hash[..16]))
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }
}

/// Minimal hex encoding to avoid pulling in the `hex` crate.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
