use super::anthropic;
use super::deepseek;
use super::glm;
use super::google;
use super::kimi;
use super::openai;
use super::profile;
use super::xai;
use crate::provider::model::capabilities::ModelCapabilities;

pub(in crate::provider::model) fn resolve(id: &str) -> Option<ModelCapabilities> {
    if id.is_empty() {
        return None;
    }

    openai::resolve(id)
        .or_else(|| anthropic::resolve(id))
        .or_else(|| deepseek::resolve(id))
        .or_else(|| glm::resolve(id))
        .or_else(|| google::resolve(id))
        .or_else(|| kimi::resolve(id))
        .or_else(|| xai::resolve(id))
        .or_else(|| openai::fallback(id))
        .or_else(|| anthropic::fallback(id))
        .or_else(|| glm::fallback(id))
        .or_else(|| google::fallback(id))
        .or_else(|| deepseek::fallback(id))
        .or_else(|| kimi::fallback(id))
        .or_else(|| xai::fallback(id))
        .map(profile::ModelProfile::capabilities)
}

pub(in crate::provider::model) fn normalize_model_id(model_id: &str) -> String {
    let normalized = model_id.trim().to_ascii_lowercase();
    for prefix in [
        "openai/",
        "xai/",
        "x-ai/",
        "anthropic/",
        "deepseek/",
        "google/",
        "zai/",
        "z-ai/",
        "moonshotai/",
        "moonshotai-cn/",
    ] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    normalized
}
