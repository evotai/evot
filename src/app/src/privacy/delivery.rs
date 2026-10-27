//! [`ScrubbingSink`]: the chat-channel boundary. Replies have their values
//! restored for the user's terminal; a chat platform is someone else's
//! server, so what goes there is scrubbed for good, like an upload.
use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;

use super::masker::Masker;
use super::service;
use crate::delivery::DeliveryCapabilities;
use crate::delivery::MessageSink;
use crate::error::Result;

pub struct ScrubbingSink<S> {
    inner: S,
    /// Fixed masker; `None` follows the settings file.
    masker: Option<Arc<Masker>>,
    /// Values already recorded for this conversation's messages.
    seen: Mutex<BTreeSet<String>>,
}

impl<S: MessageSink> ScrubbingSink<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            masker: None,
            seen: Mutex::new(BTreeSet::new()),
        }
    }

    pub fn with_masker(inner: S, masker: Arc<Masker>) -> Self {
        Self {
            masker: Some(masker),
            ..Self::new(inner)
        }
    }

    async fn scrub(&self, text: &str) -> Result<String> {
        let masker = match &self.masker {
            Some(masker) => masker.clone(),
            None => service::masker_or_unavailable().await?,
        };
        service::scrub_delivery(&masker, text, &self.seen).await
    }
}

#[async_trait]
impl<S: MessageSink> MessageSink for ScrubbingSink<S> {
    fn capabilities(&self) -> DeliveryCapabilities {
        self.inner.capabilities()
    }

    async fn send_text(&self, chat_id: &str, text: &str) -> Result<String> {
        let text = self.scrub(text).await?;
        self.inner.send_text(chat_id, &text).await
    }

    async fn edit_text(&self, chat_id: &str, message_id: &str, text: &str) -> Result<()> {
        let text = self.scrub(text).await?;
        self.inner.edit_text(chat_id, message_id, &text).await
    }
}
