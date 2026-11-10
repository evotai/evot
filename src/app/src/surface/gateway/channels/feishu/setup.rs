//! Credential-free setup observations and confirmed destination binding.

use serde::Serialize;

use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::FeishuSettings;
use crate::surface::gateway::health::ChannelHealth;
use crate::surface::gateway::health::{self};

#[derive(Serialize)]
pub struct SetupState {
    pub configured: bool,
    pub revision: String,
    pub default_chat_id: String,
    pub chats: Vec<String>,
    pub connection: ChannelHealth,
}

pub fn observe(config: &Config) -> Result<SetupState> {
    let channel = config.channels.feishu.as_ref();
    let configured =
        channel.is_some_and(|c| !c.app_id.trim().is_empty() && !c.app_secret.trim().is_empty());
    let revision = channel
        .map(super::registration::revision)
        .unwrap_or_default();
    let connection = channel
        .map(|c| health::get(&health::credential_key(&c.app_id, &c.app_secret)))
        .unwrap_or_default();
    Ok(SetupState {
        configured,
        revision,
        default_chat_id: channel
            .filter(|_| configured)
            .map(|c| c.default_chat_id.clone())
            .unwrap_or_default(),
        chats: match channel.filter(|_| configured) {
            Some(c) => super::state::load_direct_chats(&c.app_id)?,
            None => Vec::new(),
        },
        connection,
    })
}

/// Reject a stale confirmation if credentials/access policy changed while the
/// picker was open. This path cannot modify credentials or adopt an unseen chat.
pub fn bind(config: &mut Config, revision: &str, chat_id: &str) -> Result<()> {
    let state = observe(config)?;
    if !state.configured || state.revision != revision {
        return Err(EvotError::Conf(
            "Feishu settings changed. Please confirm the destination again.".into(),
        ));
    }
    if !state.chats.iter().any(|chat| chat == chat_id) {
        return Err(EvotError::Conf(
            "This conversation has not been observed by the bot.".into(),
        ));
    }
    crate::conf::update_config(config, |candidate| {
        let channel = candidate
            .channels
            .feishu
            .as_ref()
            .ok_or_else(|| EvotError::Conf("Feishu is not configured".into()))?;
        let update = FeishuSettings {
            app_id: channel.app_id.clone(),
            app_secret: None,
            mention_only: channel.mention_only,
            default_chat_id: Some(chat_id.to_string()),
        };
        crate::conf::apply_feishu_settings(candidate, &update)
    })
}
