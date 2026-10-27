use crate::agent::run::policy::ExecutionBudget;
use crate::agent::run::policy::RunPolicy;
use crate::agent::run::policy::ToolAccess;

/// Product presets, resolved once into explicit execution/tool policy. Host
/// tools are supplied separately and are admitted only by the resolved policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolMode {
    Interactive,
    Headless,
    Planning,
    Readonly,
    /// Tool-free conversation for embedding clients that only want an answer.
    Chat,
}

impl ToolMode {
    pub fn policy(self) -> RunPolicy {
        match self {
            Self::Interactive => RunPolicy {
                tools: ToolAccess::Full,
                budget: ExecutionBudget::Unbounded,
                host_tools: true,
                background_processes: true,
                web_fetch: true,
            },
            Self::Headless => RunPolicy {
                tools: ToolAccess::Full,
                budget: ExecutionBudget::Configured,
                host_tools: true,
                background_processes: false,
                web_fetch: false,
            },
            Self::Planning => RunPolicy {
                tools: ToolAccess::Planning,
                budget: ExecutionBudget::Unbounded,
                host_tools: true,
                background_processes: true,
                web_fetch: true,
            },
            Self::Readonly => RunPolicy {
                tools: ToolAccess::Readonly,
                budget: ExecutionBudget::Configured,
                host_tools: false,
                background_processes: false,
                web_fetch: false,
            },
            Self::Chat => RunPolicy {
                tools: ToolAccess::None,
                budget: ExecutionBudget::Configured,
                host_tools: false,
                background_processes: false,
                web_fetch: false,
            },
        }
    }
}
