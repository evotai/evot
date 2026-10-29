use super::catalog;
use super::resolved::ModelConfig;
use super::resolved::ModelRoute;
use super::resolved::ResolveModelRequest;
use crate::provider::route::ApiProtocol;

pub(super) fn resolve(request: ResolveModelRequest, profile: Option<&str>) -> ModelConfig {
    let normalized_id = catalog::normalize_model_id(&request.model_id);
    let mut capabilities = profile
        .and_then(|id| catalog::resolve(&catalog::normalize_model_id(id)))
        .or_else(|| catalog::resolve(&normalized_id))
        .unwrap_or_else(|| {
            catalog::protocol_fallback(matches!(
                request.protocol,
                ApiProtocol::AnthropicMessages | ApiProtocol::BedrockConverseStream
            ))
        });

    // An absent model id is the app's unconfigured sentinel, not an opaque
    // model alias. Do not offer reasoning controls before a model is selected.
    if normalized_id.is_empty() {
        capabilities.reasoning.set_supported(false);
    }
    request.overrides.apply(&mut capabilities);

    ModelConfig {
        id: request.model_id,
        route: ModelRoute {
            protocol: request.protocol,
            provider: request.provider,
            base_url: request.base_url,
            headers: request.headers,
            compat: request.compat,
            capabilities: request.route_capabilities,
        },
        capabilities,
    }
}
