//! Built-in channel registration. Adding a transport requires one registration
//! here, not changes to the supervisor or server startup paths.

use std::sync::Arc;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent::RunManager;
use crate::conf::ChannelsConfig;
use crate::surface::delivery::DeliveryRegistration;

/// A configured adapter's opaque lifecycle description. The revision must
/// change whenever transport configuration changes; never expose raw secrets.
pub struct PreparedChannel {
    pub name: &'static str,
    pub revision: String,
    pub start: Box<dyn FnOnce(CancellationToken) -> JoinHandle<()> + Send>,
}

pub struct ChannelRegistration {
    pub name: &'static str,
    pub configured: fn(&ChannelsConfig) -> bool,
    pub prepare: fn(&ChannelsConfig, Arc<RunManager>) -> Option<PreparedChannel>,
    /// Outbound delivery capability for this channel.
    pub delivery: DeliveryRegistration,
}

pub const CHANNELS: &[ChannelRegistration] = &[super::channels::feishu::registration::REGISTRATION];

/// Delivery registrations across all channels, for `delivery::resolve`.
pub fn delivery_registrations() -> impl Iterator<Item = DeliveryRegistration> {
    CHANNELS.iter().map(|entry| entry.delivery)
}

pub fn prepare_all(conf: &ChannelsConfig, manager: Arc<RunManager>) -> Vec<PreparedChannel> {
    CHANNELS
        .iter()
        .filter_map(|entry| (entry.prepare)(conf, manager.clone()))
        .collect()
}

pub fn configured_names(conf: &ChannelsConfig) -> Vec<&'static str> {
    CHANNELS
        .iter()
        .filter(|entry| (entry.configured)(conf))
        .map(|entry| entry.name)
        .collect()
}
