use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::tracing::init_tracing;

/// Load config with the explicit startup selection and port override. A
/// selection that cannot be honored fails startup.
fn load_config(
    port: Option<u16>,
    model: Option<String>,
    thinking_level: Option<String>,
    env_file: Option<String>,
) -> Result<evot::api::Config> {
    let mut config = evot::api::Config::load_with_env_file(env_file.as_deref())
        .map_err(|e| Error::from_reason(format!("config load failed: {e}")))?
        .with_startup_selection(model.as_deref(), thinking_level.as_deref())
        .map_err(|e| Error::from_reason(e.to_string()))?;
    if let Some(p) = port {
        config = config.with_port(p);
    }
    Ok(config)
}

/// Resolve the actual configured Console port for local discovery and handoff preflight.
#[napi]
pub fn console_port(port: Option<u16>, env_file: Option<String>) -> Result<u16> {
    Ok(load_config(port, None, None, env_file)?.server.port)
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
    thinking_level: Option<String>,
    env_file: Option<String>,
) -> Result<()> {
    init_tracing();
    let config = load_config(port, model, thinking_level, env_file)?;
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
    thinking_level: Option<String>,
    env_file: Option<String>,
    tools: Option<String>,
    permission: Option<String>,
    ephemeral: Option<bool>,
) -> Result<()> {
    init_tracing();
    let mode = evot::api::acp::tool_mode(tools.as_deref().unwrap_or("full"))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let ask_permission = evot::api::acp::ask_permission(permission.as_deref().unwrap_or("ask"))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let config = load_config(None, model, thinking_level, env_file)?;
    let options = evot::api::acp::AcpOptions {
        mode,
        ask_permission,
        ephemeral: ephemeral.unwrap_or(false),
        agent_version: version(),
    };
    evot::api::acp::serve_stdio(config, options)
        .await
        .map_err(|e| Error::from_reason(format!("acp error: {e}")))
}

struct EmbeddedServer {
    info: String,
    requests: std::sync::Arc<tokio::sync::RwLock<()>>,
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

/// Unlike process exit, handoff may not abort an active Console response. A
/// writer closes admission and waits for the last response body, including SSE.
#[napi]
pub async fn drain_server_background() -> Result<()> {
    let mut slot = embedded_server().lock().await;
    let Some(server) = slot.as_ref() else {
        return Ok(());
    };
    let _admission = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        server.requests.clone().write_owned(),
    )
    .await
    .map_err(|_| Error::from_reason("Console is serving an active request; retry --host later."))?;
    if let Some(server) = slot.take() {
        server.cancel.cancel();
        server
            .handle
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
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
    let config = load_config(port, model, None, env_file)?;
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
    let requests = std::sync::Arc::new(tokio::sync::RwLock::new(()));
    let admission = requests.clone();
    let router = server.router().layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let permit = admission.clone().try_read_owned();
            async move {
                use axum::response::IntoResponse;
                use futures::StreamExt;
                let Ok(permit) = permit else {
                    return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
                };
                next.run(request).await.map(|body| {
                    axum::body::Body::from_stream(body.into_data_stream().map(move |chunk| {
                        let _hold_until_body_dropped = &permit;
                        chunk
                    }))
                })
            }
        },
    ));
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
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
        requests,
        cancel,
        handle,
    });
    Ok(Some(info))
}
