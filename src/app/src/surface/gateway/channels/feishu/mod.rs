pub mod adapter;
pub mod config;
pub mod delivery;
pub mod message;
pub mod registration;
pub mod setup;
pub mod state;
pub mod target;
pub mod token;
pub mod ws;

pub use adapter::FeishuChannel;

// The channel configuration schema lives in `conf::channels`; re-exported here
// for callers that address it via the channel module.
pub use crate::conf::channels::FeishuChannelConfig;
