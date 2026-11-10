use async_trait::async_trait;

use crate::base::error::Result;

#[derive(Debug, Clone, Copy)]
pub struct DeliveryCapabilities {
    pub can_edit: bool,
    pub max_message_len: usize,
    /// Maximum number of edits allowed per message (0 = unlimited).
    /// When reached, the delivery layer proactively sends a new message
    /// instead of waiting for the API to reject the edit.
    pub max_edits_per_message: usize,
}

#[async_trait]
pub trait MessageSink: Send + Sync {
    fn capabilities(&self) -> DeliveryCapabilities;

    /// Send text message, return platform message_id.
    async fn send_text(&self, chat_id: &str, text: &str) -> Result<String>;

    /// Edit an existing message in-place. No-op if unsupported.
    async fn edit_text(&self, chat_id: &str, message_id: &str, text: &str) -> Result<()> {
        let _ = (chat_id, message_id, text);
        Ok(())
    }
}
