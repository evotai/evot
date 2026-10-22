use std::sync::Arc;

use evot_engine::provider::ModelConfig;
use evot_engine::provider::StreamProvider;

use super::SuggestionEndpoint;
use crate::conf::LlmConfig;
use crate::error::EvotError;
use crate::error::Result;

/// Runtime-only request identity. Keep the complete resolved route rather
/// than round-tripping the current model through a published service DTO.
#[derive(Clone)]
pub struct SuggestionModel {
    pub config: ModelConfig,
    pub api_key: String,
}

impl From<LlmConfig> for SuggestionModel {
    fn from(current: LlmConfig) -> Self {
        Self {
            config: current.model_config,
            api_key: current.api_key,
        }
    }
}

impl TryFrom<&SuggestionEndpoint> for SuggestionModel {
    type Error = EvotError;

    fn try_from(service: &SuggestionEndpoint) -> Result<Self> {
        let protocol = service
            .parsed_protocol()
            .ok_or_else(|| EvotError::Conf("invalid suggestion service protocol".into()))?;
        Ok(Self {
            config: crate::conf::resolve_model_config(
                protocol,
                "evot-suggestion",
                &service.model,
                Some(&service.base_url),
                Default::default(),
                Default::default(),
                Some(if service.context_window == 0 {
                    8192
                } else {
                    service.context_window
                }),
                None,
                // Published services already accept image requests. Do not
                // apply this override to the active chat model's capability.
                Some(true),
            ),
            api_key: service.api_key.clone(),
        })
    }
}

impl SuggestionModel {
    /// Select exactly once, before sampling. Errors from service loading or
    /// validation must not silently authorize traffic through another route.
    pub(super) async fn resolve(current: LlmConfig) -> Result<Option<Self>> {
        if let Some(service) = super::endpoint::current().await? {
            return Self::try_from(&service).map(Some);
        }
        let model = Self::from(current);
        // Local endpoints may intentionally have no API key.
        Ok(
            (!model.config.id().trim().is_empty() && !model.config.base_url().trim().is_empty())
                .then_some(model),
        )
    }

    pub(super) fn provider(&self) -> Arc<dyn StreamProvider> {
        use evot_engine::provider::ApiProtocol;
        match self.config.protocol() {
            ApiProtocol::AnthropicMessages => Arc::new(evot_engine::provider::AnthropicProvider),
            ApiProtocol::OpenAiCompletions => Arc::new(evot_engine::provider::OpenAiCompatProvider),
            ApiProtocol::BedrockConverseStream => Arc::new(evot_engine::provider::BedrockProvider),
            ApiProtocol::OpenAiResponses => {
                Arc::new(evot_engine::provider::OpenAiResponsesProvider)
            }
        }
    }
}
