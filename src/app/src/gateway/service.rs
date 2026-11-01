use std::sync::Arc;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::conf::Config;
use crate::error::Result;

/// Spawn every long-lived background task a running evot instance needs:
/// inbound channels (feishu, telegram, ...) plus the scheduled-task dispatcher.
///
/// Both the standalone server and the CLI's embedded server go through here, so
/// runtime wiring cannot drift between the two entry points.
pub fn spawn_runtime_tasks(
    conf: &Config,
    agent: Arc<Agent>,
    cancel: CancellationToken,
) -> Vec<JoinHandle<()>> {
    vec![
        super::supervisor::spawn(conf, agent.clone(), cancel.clone()),
        crate::automation::dispatcher::spawn(conf, agent, cancel),
    ]
}

pub async fn start(conf: Config) -> Result<()> {
    let llm = conf.active_llm().ok();
    tracing::info!(
        id = ?conf.id,
        env_file = %conf.env_file_path.display(),
        provider = %llm.as_ref().map(|l| l.provider.as_str()).unwrap_or("unconfigured"),
        model = %llm.as_ref().map(|l| l.model.as_str()).unwrap_or("unconfigured"),
        storage_root = %conf.storage.fs.root_dir.display(),
        skills_dirs = ?conf.skills_dirs,
        sandbox = conf.sandbox.enabled,
        "server starting"
    );

    let agent = crate::bootstrap::build_agent(&conf).await?;
    let cancel = CancellationToken::new();
    let handles = spawn_runtime_tasks(&conf, agent.clone(), cancel.clone());

    let channels = super::channel_tasks::ChannelTasks::new(cancel, handles);
    print_banner(&conf);

    // Always stop channel tasks, including when HTTP binding/startup fails.
    let result = super::channels::http::Server::new(agent, conf.clone())
        .start(conf.server.host.clone(), conf.server.port)
        .await;
    channels.shutdown(std::time::Duration::from_secs(5)).await;
    result
}

fn print_banner(conf: &Config) {
    let llm = conf.active_llm().ok();
    let addr = format!("{}:{}", conf.server.host, conf.server.port);

    eprintln!();
    eprintln!("  evot server");
    eprintln!("  ───────────────────────────────────");
    eprintln!("  address:  http://{addr}");
    eprintln!(
        "  provider: {}",
        llm.as_ref()
            .map(|l| l.provider.as_str())
            .unwrap_or("unconfigured")
    );
    eprintln!(
        "  model:    {}",
        llm.as_ref()
            .map(|l| l.model.as_str())
            .unwrap_or("unconfigured")
    );
    if let Some(base_url) = llm
        .as_ref()
        .map(|l| l.base_url.as_str())
        .filter(|s| !s.is_empty())
    {
        eprintln!("  base_url: {base_url}");
    }
    eprintln!("  storage:  {}", conf.storage.fs.root_dir.display());
    let names = super::registry::configured_names(&conf.channels);
    if !names.is_empty() {
        eprintln!("  channels: {}", names.join(", "));
    }
    eprintln!("  ───────────────────────────────────");
    eprintln!();
}
