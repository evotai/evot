//! Feishu's gateway adapter. Transport-specific configuration stays here.

use std::sync::Arc;

use sha2::Digest;

use crate::agent::RunManager;
use crate::conf::channels::FeishuChannelConfig;
use crate::conf::ChannelsConfig;
use crate::gateway::registry::ChannelRegistration;
use crate::gateway::registry::PreparedChannel;

pub const REGISTRATION: ChannelRegistration = ChannelRegistration {
    name: "feishu",
    configured: |channels| channels.feishu.is_some(),
    prepare,
    delivery: crate::delivery::DeliveryRegistration {
        name: "feishu",
        resolve: resolve_delivery,
    },
};

/// Hash all inbound-transport settings, including the secret value, not merely
/// its presence. Changing a delivery default must not reconnect the socket.
pub fn revision(config: &FeishuChannelConfig) -> String {
    let mut hash = sha2::Sha256::new();
    for value in [&config.app_id, &config.app_secret] {
        hash.update(value.len().to_le_bytes());
        hash.update(value.as_bytes());
    }
    hash.update([u8::from(config.mention_only)]);
    for sender in &config.allow_from {
        hash.update(sender.len().to_le_bytes());
        hash.update(sender.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn resolve_delivery(
    channels: &ChannelsConfig,
    target: &str,
) -> crate::error::Result<crate::delivery::resolve::ResolvedDelivery> {
    use crate::error::EvotError;
    let config = channels.feishu.as_ref().ok_or_else(|| {
        EvotError::Run("Feishu is not configured on the executor that ran this task".into())
    })?;
    if config.app_id.trim().is_empty() || config.app_secret.trim().is_empty() {
        return Err(EvotError::Run(
            "Feishu credentials are incomplete on the executor that ran this task".into(),
        ));
    }
    let targets = super::target::resolve_targets(config, target)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| EvotError::Run(format!("Feishu client: {error}")))?;
    Ok(crate::delivery::resolve::ResolvedDelivery {
        targets,
        sink: Box::new(super::delivery::FeishuMessageSink::new(
            client,
            super::token::TokenCache::new(),
            config.app_id.clone(),
            config.app_secret.clone(),
        )),
    })
}

fn prepare(channels: &ChannelsConfig, manager: Arc<RunManager>) -> Option<PreparedChannel> {
    let config = channels.feishu.as_ref()?.clone();
    Some(PreparedChannel {
        name: REGISTRATION.name,
        revision: revision(&config),
        start: Box::new(move |cancel| super::FeishuChannel::spawn(config, manager, cancel)),
    })
}
