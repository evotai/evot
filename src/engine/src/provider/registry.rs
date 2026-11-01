//! Provider registry — maps ApiProtocol to StreamProvider implementations.

use std::collections::HashMap;

use tokio::sync::mpsc;

use super::error::*;
use super::model::ModelConfig;
use super::route::ApiProtocol;
use super::traits::*;

/// Registry of all available stream providers, keyed by API protocol.
pub struct ProviderRegistry {
    providers: HashMap<ApiProtocol, Box<dyn StreamProvider>>,
}

impl ProviderRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
        }
    }

    /// Register a provider for a given protocol.
    pub fn register(&mut self, protocol: ApiProtocol, provider: impl StreamProvider + 'static) {
        self.providers.insert(protocol, Box::new(provider));
    }

    /// Get a provider for a given protocol.
    pub fn get(&self, protocol: &ApiProtocol) -> Option<&dyn StreamProvider> {
        self.providers.get(protocol).map(|p| p.as_ref())
    }

    /// Check if a protocol is registered.
    pub fn has(&self, protocol: &ApiProtocol) -> bool {
        self.providers.contains_key(protocol)
    }

    /// List all registered protocols.
    pub fn protocols(&self) -> Vec<ApiProtocol> {
        self.providers.keys().copied().collect()
    }

    /// Stream using the appropriate provider for the model's API protocol.
    pub async fn stream(
        &self,
        model: &ModelConfig,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let provider = self.providers.get(&model.protocol()).ok_or_else(|| {
            ProviderError::Other(format!(
                "No provider registered for protocol: {}",
                model.protocol()
            ))
        })?;

        provider.stream(config, tx, cancel).await
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        use crate::provider::AnthropicProvider;
        use crate::provider::OpenAiCompatProvider;
        use crate::provider::OpenAiResponsesProvider;

        let mut registry = Self::new();
        registry.register(ApiProtocol::AnthropicMessages, AnthropicProvider);
        registry.register(ApiProtocol::OpenAiResponses, OpenAiResponsesProvider);
        registry.register(ApiProtocol::OpenAiCompletions, OpenAiCompatProvider);

        registry
    }
}
