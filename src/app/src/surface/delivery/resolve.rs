//! Resolve outbound delivery through channel-provided registrations.
//!
//! The delivery layer is transport-agnostic: callers pass the registered
//! channels in, so this module never reaches into gateway internals.

use super::MessageSink;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::ChannelsConfig;

pub struct ResolvedDelivery {
    pub sink: Box<dyn MessageSink>,
    pub targets: Vec<String>,
}

/// One channel's outbound delivery capability. Inbound lifecycle concerns stay
/// in `gateway::registry`; this is the narrow slice delivery resolution needs.
///
/// `Copy` keeps registration tables cheap to iterate and pass by value.
#[derive(Clone, Copy)]
pub struct DeliveryRegistration {
    pub name: &'static str,
    pub resolve: fn(&ChannelsConfig, &str) -> Result<ResolvedDelivery>,
}

pub fn resolve_delivery(
    registrations: impl IntoIterator<Item = DeliveryRegistration>,
    channels: &ChannelsConfig,
    channel: &str,
    target: &str,
) -> Result<ResolvedDelivery> {
    let registration = registrations
        .into_iter()
        .find(|entry| entry.name == channel)
        .ok_or_else(|| EvotError::Run(format!("unsupported delivery channel: {channel}")))?;
    (registration.resolve)(channels, target)
}
