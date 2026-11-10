mod compat;
mod features;
mod known;

pub use compat::CompatCaps;
pub use compat::MaxTokensField;
pub use compat::OpenAiCompat;
pub use compat::ThinkingFormat;
pub use features::RouteCapabilities;
pub use features::RouteCapabilityOverrides;
pub use known::default_base_url;
pub use known::is_native_openai_responses_route;
pub use known::is_official_openai_route;

pub use crate::types::ApiProtocol;
