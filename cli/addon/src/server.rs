use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::tracing::init_tracing;

/// Load and validate config with optional model and port overrides.
fn load_config(
    port: Option<u16>,
    model: Option<String>,
    env_file: Option<String>,
) -> Result<evot::api::Config> {
    let mut config = evot::api::Config::load_with_env_file(env_file.as_deref())
        .map_err(|e| Error::from_reason(format!("config load failed: {e}")))?
        .with_model(model)
        .map_err(|e| Error::from_reason(format!("config model: {e}")))?;
    if let Some(p) = port {
        config = config.with_port(p);
    }
    Ok(config)
}

/// Version string for the native addon.
#[napi]
pub fn version() -> String {
    env!("EVOT_VERSION").to_string()
}

#[napi]
pub async fn start_server(
    port: Option<u16>,
    model: Option<String>,
    env_file: Option<String>,
) -> Result<()> {
    init_tracing();
    let config = load_config(port, model, env_file)?;
    evot::api::start(config)
        .await
        .map_err(|e| Error::from_reason(format!("server error: {e}")))
}

/// Serve ACP v1 on this process's stdin/stdout until stdin closes.
///
/// `tools` is `full`, `readonly`, or `none`; `permission` is `ask` (the
/// client approves every tool call) or `allow`; `ephemeral` keeps sessions in
/// memory only. Diagnostics go to the log file, never to stdout.
#[napi]
pub async fn run_acp(
    model: Option<String>,
    env_file: Option<String>,
    tools: Option<String>,
    permission: Option<String>,
    ephemeral: Option<bool>,
) -> Result<()> {
    init_tracing();
    let mode = evot::acp::tool_mode(tools.as_deref().unwrap_or("full"))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let ask_permission = evot::acp::ask_permission(permission.as_deref().unwrap_or("ask"))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let config = load_config(None, model, env_file)?;
    let options = evot::acp::AcpOptions {
        mode,
        ask_permission,
        ephemeral: ephemeral.unwrap_or(false),
        agent_version: version(),
    };
    evot::acp::serve_stdio(config, options)
        .await
        .map_err(|e| Error::from_reason(format!("acp error: {e}")))
}

struct EmbeddedServer {
    info: String,
    cancel: tokio_util::sync::CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

fn embedded_server() -> &'static tokio::sync::Mutex<Option<EmbeddedServer>> {
    static SERVER: std::sync::OnceLock<tokio::sync::Mutex<Option<EmbeddedServer>>> =
        std::sync::OnceLock::new();
    SERVER.get_or_init(|| tokio::sync::Mutex::new(None))
}

#[napi]
pub async fn stop_server_background() -> Result<()> {
    let mut slot = embedded_server().lock().await;
    if let Some(mut server) = slot.take() {
        server.cancel.cancel();
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut server.handle)
            .await
            .is_err()
        {
            server.handle.abort();
            let _ = server.handle.await;
        }
    }
    Ok(())
}

#[napi]
pub async fn start_server_background(
    port: Option<u16>,
    model: Option<String>,
    env_file: Option<String>,
) -> Result<Option<String>> {
    init_tracing();
    let mut slot = embedded_server().lock().await;
    if let Some(server) = slot.as_ref() {
        if !server.handle.is_finished() {
            return Ok(Some(server.info.clone()));
        }
    }
    *slot = None;
    let config = load_config(port, model, env_file)?;
    let host = config.server.host.clone();
    let addr = format!("{host}:{}", config.server.port);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            // Occupied is not owned. The host scheduler retries later; console
            // discovery for setup is independent of dashboard ownership.
            return Ok(None);
        }
        Err(error) => {
            return Err(Error::from_reason(format!(
                "settings server bind failed: {error}"
            )))
        }
    };

    let actual_port = listener
        .local_addr()
        .map_err(|e| Error::from_reason(e.to_string()))?
        .port();
    let addr = format!("{host}:{actual_port}");
    let agent = evot::api::build_agent(&config)
        .await
        .map_err(|e| Error::from_reason(format!("agent init: {e}")))?;

    let cancel = tokio_util::sync::CancellationToken::new();
    let handles = evot::api::spawn_runtime_tasks(&config, agent.clone(), cancel.clone());
    let runtime = evot::api::ChannelTasks::new(cancel.clone(), handles);
    let channels = evot::api::configured_names(&config.channels);

    let server = evot::api::Server::new(agent, config.clone());
    let shutdown = cancel.clone();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, server.router())
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await;
        runtime.shutdown(std::time::Duration::from_secs(5)).await;
    });

    let info = serde_json::json!({
        "port": actual_port,
        "address": format!("http://{addr}"),
        "channels": channels,
        "channelCount": channels.len(),
    });
    let info =
        serde_json::to_string(&info).map_err(|e| Error::from_reason(format!("serialize: {e}")))?;
    *slot = Some(EmbeddedServer {
        info: info.clone(),
        cancel,
        handle,
    });
    Ok(Some(info))
}
