use super::is_native_openai_responses_route;
use super::ApiProtocol;

/// Explicit endpoint capability overrides from user configuration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RouteCapabilityOverrides {
    pub verbosity: bool,
    /// Legacy config name with no runtime effect. Still parsed and written
    /// back so existing provider entries survive a settings rewrite.
    pub remote_compaction: bool,
}

impl RouteCapabilityOverrides {
    pub fn set_named(&mut self, name: &str) -> bool {
        match name {
            "verbosity" => self.verbosity = true,
            "remote_compaction" => self.remote_compaction = true,
            _ => return false,
        }
        true
    }

    /// Stable config names for the enabled endpoint overrides.
    pub fn names(self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.verbosity {
            names.push("verbosity");
        }
        if self.remote_compaction {
            names.push("remote_compaction");
        }
        names
    }
}

/// Features implemented by the selected endpoint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RouteCapabilities {
    pub verbosity: bool,
}

impl RouteCapabilities {
    /// Compose known endpoint support with explicit overrides. Model support is
    /// intersected separately by `ModelConfig`.
    pub fn for_route(
        _protocol: ApiProtocol,
        provider: &str,
        base_url: &str,
        explicit: RouteCapabilityOverrides,
    ) -> Self {
        let native_responses = is_native_openai_responses_route(provider, base_url);
        Self {
            verbosity: native_responses || explicit.verbosity,
        }
    }
}
