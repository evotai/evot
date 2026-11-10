//! Delivery target policy for the Feishu channel.
//!
//! A Feishu app has no single implicit "default chat". A target is therefore one
//! of three explicit things:
//!
//! - an explicit `oc_...` chat id, used verbatim;
//! - empty, meaning the channel's configured default notification chat;
//! - `p2p:*`, an opt-in broadcast to every direct conversation this device has
//!   observed. This is never the default: fanning a scheduled result out to
//!   everyone who ever messaged the bot has to be a deliberate choice.

use super::state::load_direct_chats;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::channels::FeishuChannelConfig;

/// Opt-in broadcast to every known direct conversation.
pub const BROADCAST_TARGET: &str = "p2p:*";

pub fn is_chat_id(value: &str) -> bool {
    value.starts_with("oc_")
}

/// Expand a task's stored delivery target into concrete chat ids.
pub fn resolve_targets(config: &FeishuChannelConfig, target: &str) -> Result<Vec<String>> {
    let target = target.trim();
    if target == BROADCAST_TARGET {
        return expand_broadcast(load_direct_chats(&config.app_id)?);
    }
    if target.is_empty() {
        let default_chat = config.default_chat_id.trim();
        if default_chat.is_empty() {
            return Err(EvotError::Run(
                "Feishu delivery has no target: set a default notification chat ID in settings"
                    .into(),
            ));
        }
        return single(default_chat);
    }
    single(target)
}

fn single(chat_id: &str) -> Result<Vec<String>> {
    if !is_chat_id(chat_id) {
        return Err(EvotError::Run(format!(
            "Feishu delivery target is not a chat ID: {chat_id}"
        )));
    }
    Ok(vec![chat_id.to_string()])
}

/// Deduplicate observed direct conversations into a stable target list.
pub fn expand_broadcast(direct_chats: Vec<String>) -> Result<Vec<String>> {
    let targets: std::collections::BTreeSet<String> = direct_chats
        .into_iter()
        .filter(|chat| is_chat_id(chat))
        .collect();
    if targets.is_empty() {
        return Err(EvotError::Run(
            "Feishu bot has no known direct conversations yet".into(),
        ));
    }
    Ok(targets.into_iter().collect())
}
