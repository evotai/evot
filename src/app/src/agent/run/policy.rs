/// Tool permissions are independent from how a run is supervised.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolAccess {
    Full,
    Planning,
    Readonly,
    /// No model-callable tools at all: built-in, host, or run-scoped.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionBudget {
    Configured,
    Unbounded,
}

/// Resolved preset policy. External transports select a preset; they cannot
/// grant individual capabilities by supplying booleans in a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunPolicy {
    pub tools: ToolAccess,
    pub budget: ExecutionBudget,
    pub host_tools: bool,
    pub background_processes: bool,
    pub web_fetch: bool,
}
