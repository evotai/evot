//! Channel-agnostic result delivery for scheduled tasks.
//!
//! Automation knows only "a channel name plus a target". Which sink that maps
//! to, and which concrete chats a target expands into, is the delivery layer's
//! job — the channel registrations are passed in by the caller.

use crate::conf::ChannelsConfig;
use crate::delivery::resolve::resolve_delivery;
use crate::error::EvotError;
use crate::error::Result;

/// Delivery status reported back to the cloud.
pub const NOT_REQUESTED: &str = "not_requested";
pub const SENT: &str = "sent";
pub const FAILED: &str = "failed";

/// Validate local configuration and resolve targets without sending anything.
pub fn validate(channels: &ChannelsConfig, channel: &str, target: &str) -> Result<()> {
    if channel.trim().is_empty() {
        return Ok(());
    }
    resolve_delivery(
        crate::gateway::registry::delivery_registrations(),
        channels,
        channel,
        target,
    )?;
    Ok(())
}

/// Send one task result. Returns the delivery status to report.
pub async fn deliver(
    channels: &ChannelsConfig,
    channel: &str,
    target: &str,
    text: &str,
) -> Result<&'static str> {
    if channel.trim().is_empty() {
        return Ok(NOT_REQUESTED);
    }
    let resolved = resolve_delivery(
        crate::gateway::registry::delivery_registrations(),
        channels,
        channel,
        target,
    )?;
    let total = resolved.targets.len();
    let mut sent = 0usize;
    let mut last_error = None;
    for chat_id in &resolved.targets {
        match resolved.sink.send_text(chat_id, text).await {
            Ok(_) => sent += 1,
            Err(error) => last_error = Some(error),
        }
    }
    match last_error {
        Some(error) => Err(EvotError::Run(format!(
            "{channel} delivery sent {sent}/{total}: {error}"
        ))),
        None => Ok(SENT),
    }
}
