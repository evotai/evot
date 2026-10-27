//! Tool-set construction: engine-owned built-ins plus host-delegated tools.

use std::path::PathBuf;

use evot_engine::host::HostTool;
use evot_engine::host::HostToolSpec;
use evot_engine::host::SharedHost;
use evot_engine::tools::*;

use crate::agent::run::policy::RunPolicy;
use crate::agent::run::policy::ToolAccess;

/// Host-owned tools attached to a run.
///
/// Bundles the outbound [`SharedHost`] bridge with the specs the host has
/// registered. The engine builds one [`HostTool`] per spec, all routing back
/// through the same bridge. This is the single seam for ask_user and any future
/// domain tool — none of them are known to the engine or app core.
#[derive(Clone)]
pub struct HostTools {
    pub host: SharedHost,
    pub specs: Vec<HostToolSpec>,
}

impl HostTools {
    pub fn new(host: SharedHost, specs: Vec<HostToolSpec>) -> Self {
        Self { host, specs }
    }

    fn into_tools(self) -> Vec<Box<dyn evot_engine::AgentTool>> {
        self.specs
            .into_iter()
            .map(|spec| {
                Box::new(HostTool::new(spec, self.host.clone())) as Box<dyn evot_engine::AgentTool>
            })
            .collect()
    }
}

fn build_bash_tool(
    envs: Vec<(String, String)>,
    sandbox_dirs: Option<Vec<PathBuf>>,
    process_manager: Option<std::sync::Arc<ProcessManager>>,
    interactive: bool,
) -> Box<dyn evot_engine::AgentTool> {
    let mut bash = BashTool::default().with_envs(envs);
    if let Some(process_manager) = process_manager {
        bash = bash.with_process_manager(process_manager);
        // Only an interactive host can see the yield and detach earlier via
        // Ctrl+B; channel runs keep the timeout as their sole bound.
        if interactive {
            bash = bash.with_foreground_wait(std::time::Duration::from_secs(10));
        }
    }
    if let Some(dirs) = sandbox_dirs {
        bash = bash.with_sandbox_dirs(dirs);
    }
    Box::new(bash)
}

/// Assemble the active tool set for a turn.
///
/// `host_tools` carries the host bridge and its registered specs; it is
/// attached only when the resolved policy permits it.
pub(crate) fn build_tools(
    policy: RunPolicy,
    envs: Vec<(String, String)>,
    allow_bash: bool,
    sandbox_dirs: Option<Vec<PathBuf>>,
    process_manager: Option<std::sync::Arc<ProcessManager>>,
    host_tools: Option<HostTools>,
) -> Vec<Box<dyn evot_engine::AgentTool>> {
    if policy.tools == ToolAccess::None {
        return Vec::new();
    }
    if policy.tools == ToolAccess::Readonly {
        // Read-only mode: read + structured search, no mutation or shell.
        return vec![
            Box::new(ReadFileTool::default()),
            Box::new(GrepTool::new()),
            Box::new(GlobTool::new()),
            #[cfg(feature = "code-search")]
            Box::new(SearchTool::new()),
        ];
    }

    let mut t: Vec<Box<dyn evot_engine::AgentTool>> = Vec::new();

    // Core coding set: read, bash, edit, write. The dedicated explore tools
    // (grep, glob, semantic_code_search) are currently unregistered here —
    // search and file-finding go through bash (rg/grep/find). They remain
    // available in Readonly mode above, which has no shell.
    t.push(Box::new(ReadFileTool::default()));

    if allow_bash {
        let background_enabled = policy.background_processes && process_manager.is_some();
        t.push(build_bash_tool(
            envs,
            sandbox_dirs,
            process_manager.clone().filter(|_| background_enabled),
            policy.host_tools && host_tools.is_some(),
        ));
        if let Some(process_manager) = process_manager.filter(|_| background_enabled) {
            t.push(Box::new(TaskOutputTool::new(process_manager.clone())));
            t.push(Box::new(TaskStopTool::new(process_manager)));
        }
    }

    if policy.tools == ToolAccess::Planning {
        let msg = "Not allowed in planning mode. Use /act to switch.";
        t.push(Box::new(EditFileTool::new().disallow(msg)));
        t.push(Box::new(WriteFileTool::new().disallow(msg)));
    } else {
        t.push(Box::new(EditFileTool::new()));
        t.push(Box::new(WriteFileTool::new()));
    }

    // evot-specific tools, appended after the pi-aligned core set.
    #[cfg(feature = "web")]
    if policy.web_fetch {
        t.push(Box::new(WebFetchTool::new()));
    }

    // Host-owned tools (ask_user, …). The engine treats these exactly like
    // built-ins; only their execution is delegated back to the host.
    if policy.host_tools {
        if let Some(host_tools) = host_tools {
            t.extend(host_tools.into_tools());
        }
    }

    t
}

/// Canonical tool set used to assemble the system prompt's tool list and
/// guidelines at startup for the gateway, which runs in Headless mode. Must
/// stay in sync with the Headless set built by `build_tools`: read, bash,
/// edit, write (no explore tools, no webfetch, no host tools).
pub(crate) fn prompt_tools() -> Vec<Box<dyn evot_engine::AgentTool>> {
    vec![
        Box::new(ReadFileTool::default()),
        Box::new(BashTool::default()),
        Box::new(EditFileTool::new()),
        Box::new(WriteFileTool::new()),
    ]
}

/// Adapt a shared tool to the engine's boxed tool list. Run-scoped tools are
/// cloned into every turn of the run, so they are held by `Arc` and keep
/// per-run state (e.g. a call counter) across turns.
struct SharedTool(std::sync::Arc<dyn evot_engine::AgentTool>);

pub(crate) fn shared_tool(
    tool: std::sync::Arc<dyn evot_engine::AgentTool>,
) -> Box<dyn evot_engine::AgentTool> {
    Box::new(SharedTool(tool))
}

#[async_trait::async_trait]
impl evot_engine::AgentTool for SharedTool {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn label(&self) -> &str {
        self.0.label()
    }
    fn description(&self) -> &str {
        self.0.description()
    }
    fn parameters_schema(&self) -> serde_json::Value {
        self.0.parameters_schema()
    }
    fn prompt_snippet(&self) -> Option<&str> {
        self.0.prompt_snippet()
    }
    fn prompt_guidelines(&self) -> Vec<&str> {
        self.0.prompt_guidelines()
    }
    fn prefer_over(&self) -> Option<(&str, &str)> {
        self.0.prefer_over()
    }
    fn parameter_aliases(&self) -> Option<evot_engine::tools::validation::AliasMap> {
        self.0.parameter_aliases()
    }
    fn prepare_arguments(&self, args: &serde_json::Value) -> serde_json::Value {
        self.0.prepare_arguments(args)
    }
    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        self.0.preview_command(params)
    }
    fn name_aliases(&self) -> Vec<(String, String)> {
        self.0.name_aliases()
    }
    fn ends_turn(&self) -> bool {
        self.0.ends_turn()
    }
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: evot_engine::ToolContext,
    ) -> Result<evot_engine::ToolResult, evot_engine::ToolError> {
        self.0.execute(params, ctx).await
    }
}
