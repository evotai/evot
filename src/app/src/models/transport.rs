//! The one place LLM transports are built, so every caller (agent turns,
//! compaction, judge, suggestions) gets the privacy boundary.
use std::sync::Arc;

use evot_engine::provider::AnthropicProvider;
use evot_engine::provider::ApiProtocol;
use evot_engine::provider::BedrockProvider;
use evot_engine::provider::OpenAiCompatProvider;
use evot_engine::provider::OpenAiResponsesProvider;
use evot_engine::provider::StreamProvider;

use crate::conf::Protocol;

pub fn for_protocol(protocol: &Protocol) -> Arc<dyn StreamProvider> {
    let raw: Arc<dyn StreamProvider> = match protocol {
        Protocol::Anthropic => Arc::new(AnthropicProvider),
        Protocol::OpenAiResponses => Arc::new(OpenAiResponsesProvider),
        Protocol::OpenAi => Arc::new(OpenAiCompatProvider),
    };
    crate::privacy::wrap(raw)
}

pub fn for_api(protocol: ApiProtocol) -> Arc<dyn StreamProvider> {
    let raw: Arc<dyn StreamProvider> = match protocol {
        ApiProtocol::AnthropicMessages => Arc::new(AnthropicProvider),
        ApiProtocol::OpenAiCompletions => Arc::new(OpenAiCompatProvider),
        ApiProtocol::BedrockConverseStream => Arc::new(BedrockProvider),
        ApiProtocol::OpenAiResponses => Arc::new(OpenAiResponsesProvider),
    };
    crate::privacy::wrap(raw)
}

/// A caller-supplied provider (tests, embedders) behind the same boundary.
pub fn overridden(provider: Arc<dyn StreamProvider>) -> Arc<dyn StreamProvider> {
    crate::privacy::wrap(provider)
}
