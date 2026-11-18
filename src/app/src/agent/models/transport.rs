//! The one place LLM transports are built, so every caller (agent turns,
//! compaction, suggestions) gets the privacy boundary.
use std::sync::Arc;

use evot_engine::provider::AnthropicProvider;
use evot_engine::provider::ApiProtocol;
use evot_engine::provider::OpenAiCompatProvider;
use evot_engine::provider::OpenAiResponsesProvider;
use evot_engine::provider::StreamProvider;

use crate::conf::Protocol;

fn raw_for_protocol(protocol: &Protocol) -> Arc<dyn StreamProvider> {
    match protocol {
        Protocol::Anthropic => Arc::new(AnthropicProvider),
        Protocol::OpenAiResponses => Arc::new(OpenAiResponsesProvider),
        Protocol::OpenAi => Arc::new(OpenAiCompatProvider),
    }
}

pub fn for_protocol(protocol: &Protocol) -> Arc<dyn StreamProvider> {
    crate::privacy::wrap(raw_for_protocol(protocol))
}

pub fn for_run(
    protocol: &Protocol,
    provider: Option<Arc<dyn StreamProvider>>,
) -> Arc<dyn StreamProvider> {
    crate::privacy::wrap_for_run(provider.unwrap_or_else(|| raw_for_protocol(protocol)))
}

pub fn for_api(protocol: ApiProtocol) -> Arc<dyn StreamProvider> {
    let raw: Arc<dyn StreamProvider> = match protocol {
        ApiProtocol::AnthropicMessages => Arc::new(AnthropicProvider),
        ApiProtocol::OpenAiCompletions => Arc::new(OpenAiCompatProvider),
        ApiProtocol::OpenAiResponses => Arc::new(OpenAiResponsesProvider),
    };
    crate::privacy::wrap(raw)
}

/// A caller-supplied provider (tests, embedders) behind the same boundary.
pub fn overridden(provider: Arc<dyn StreamProvider>) -> Arc<dyn StreamProvider> {
    crate::privacy::wrap(provider)
}
