//! ACP v1 method handlers and the per-connection read loop.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use agent_client_protocol_schema::v1 as acp;
use agent_client_protocol_schema::ProtocolVersion;
use futures::StreamExt;
use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::task::JoinSet;
use tokio_util::codec::FramedRead;
use tokio_util::codec::LinesCodec;
use tokio_util::codec::LinesCodecError;
use tokio_util::sync::CancellationToken;

use super::config_reload::ConfigFiles;
use super::connection::to_value;
use super::connection::write_frames;
use super::connection::Connection;
use super::connection::Inbound;
use super::models::model_options;
use super::permission::AcpApprover;
use super::projection::TurnProjection;
use super::prompt::prompt_input;
use super::AcpOptions;
use crate::agent::models::ModelSelection;
use crate::agent::Agent;
use crate::agent::QueryRequest;
use crate::agent::SubmitOutcome;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::conf::Config;

/// Largest accepted inbound frame. Prompts are text only, so this is generous.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MODEL_CONFIG_ID: &str = "model";

type RpcResult<T> = std::result::Result<T, acp::Error>;

/// Serve ACP on this process's stdin/stdout until stdin closes. Stdout
/// carries protocol frames only; diagnostics go to tracing.
pub async fn serve_stdio(config: Config, options: AcpOptions) -> Result<()> {
    let agent = if options.ephemeral {
        crate::agent::bootstrap::build_ephemeral_agent(&config).await?
    } else {
        crate::agent::bootstrap::build_agent(&config).await?
    };
    serve(
        agent,
        config,
        options,
        tokio::io::stdin(),
        tokio::io::stdout(),
    )
    .await
}

/// Serve ACP on an arbitrary byte stream until `reader` reaches end of input.
/// In-flight prompts are cancelled when the client disconnects.
pub async fn serve<R, W>(
    agent: Arc<Agent>,
    config: Config,
    options: AcpOptions,
    reader: R,
    writer: W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (connection, frames_out) = Connection::new();
    let writer = tokio::spawn(write_frames(writer, frames_out));
    let files = ConfigFiles::for_config(&config)?.map(tokio::sync::Mutex::new);
    let server = Arc::new(Server {
        agent,
        config: RwLock::new(config),
        files,
        options,
        connection: Arc::new(connection),
        sessions: Mutex::new(HashMap::new()),
    });

    let mut frames = FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    let mut prompts = JoinSet::new();
    let mut read_error = None;
    while let Some(frame) = frames.next().await {
        match frame {
            Ok(line) if line.trim().is_empty() => {}
            Ok(line) => server.dispatch(&line, &mut prompts).await,
            Err(LinesCodecError::MaxLineLengthExceeded) => {
                // The codec skips to the next newline; the stream stays usable.
                server.connection.error(
                    Value::Null,
                    acp::Error::invalid_request().data(Value::from("frame too large")),
                );
            }
            Err(LinesCodecError::Io(error)) => {
                read_error = Some(error);
                break;
            }
        }
        while prompts.try_join_next().is_some() {}
    }

    server.disconnect();
    while prompts.join_next().await.is_some() {}
    drop(server);
    match writer.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!("acp: output closed: {error}"),
        Err(error) => tracing::warn!("acp: writer task failed: {error}"),
    }
    match read_error {
        Some(error) => Err(EvotError::Io(error)),
        None => Ok(()),
    }
}

/// Connection-scoped state of one ACP session.
struct SessionState {
    /// Per-session model choice; switching it never moves other sessions.
    selection: Arc<ModelSelection>,
    /// Tools the client chose to always allow in this session.
    always_allowed: Arc<Mutex<HashSet<String>>>,
    /// Cancel signal of the prompt running in this session, if any.
    prompt: Option<Arc<CancellationToken>>,
}

/// Reserved synchronously in wire order, before spawning or waiting on reload.
struct AdmittedPrompt {
    input: Vec<evot_engine::Content>,
    selection: Arc<ModelSelection>,
    always_allowed: Arc<Mutex<HashSet<String>>>,
    finished: PromptFinished,
}

struct Server {
    agent: Arc<Agent>,
    /// Model catalog and providers. A long-lived ACP process reloads this
    /// when the files it was loaded from change; see [`Server::refresh_config`].
    config: RwLock<Config>,
    /// Files behind `config`; `None` for an in-memory config.
    files: Option<tokio::sync::Mutex<ConfigFiles>>,
    options: AcpOptions,
    connection: Arc<Connection>,
    /// Sessions created or resumed on this connection. Prompts are accepted
    /// only for these, as ACP requires.
    sessions: Mutex<HashMap<String, SessionState>>,
}

impl Server {
    async fn dispatch(self: &Arc<Self>, line: &str, prompts: &mut JoinSet<()>) {
        match Inbound::parse(line) {
            // Prompts run concurrently so cancel and other requests get through.
            Ok(Inbound::Request { id, method, params }) if method == "session/prompt" => {
                match self.admit_prompt(params) {
                    Ok(prompt) => {
                        let server = self.clone();
                        prompts.spawn(async move {
                            let result = server.prompt(prompt).await;
                            server.connection.reply(id, result);
                        });
                    }
                    Err(error) => self.connection.error(id, error),
                }
            }
            Ok(Inbound::Request { id, method, params }) => {
                let result = self.request(&method, params).await;
                self.connection.reply(id, result);
            }
            Ok(Inbound::Notification { method, params }) => {
                if method == "session/cancel" {
                    if let Ok(cancel) = serde_json::from_value::<acp::CancelNotification>(params) {
                        self.cancel_prompt(&cancel.session_id.0);
                    }
                }
            }
            Ok(Inbound::Response { id, frame }) => self.connection.resolve(&id, frame),
            Err(error) => self.connection.error(Value::Null, error),
        }
    }

    async fn request(&self, method: &str, params: Value) -> RpcResult<Value> {
        match method {
            "initialize" => to_value(self.initialize(parse(params)?)),
            "authenticate" => to_value(acp::AuthenticateResponse::new()),
            "session/new" => to_value(self.new_session(parse(params)?).await?),
            "session/resume" => to_value(self.resume_session(parse(params)?).await?),
            "session/list" => to_value(self.list_sessions(parse(params)?).await?),
            "session/close" => to_value(self.close_session(parse(params)?)?),
            "session/set_config_option" => to_value(self.set_config_option(parse(params)?).await?),
            _ => Err(acp::Error::method_not_found()),
        }
    }

    fn initialize(&self, _request: acp::InitializeRequest) -> acp::InitializeResponse {
        // Only v1 exists; ACP has the agent answer with its latest version
        // when it does not support the requested one.
        acp::InitializeResponse::new(ProtocolVersion::V1)
            .agent_capabilities(
                acp::AgentCapabilities::new()
                    .load_session(false)
                    .prompt_capabilities(acp::PromptCapabilities::new().image(true))
                    .session_capabilities(
                        acp::SessionCapabilities::new()
                            .list(acp::SessionListCapabilities::new())
                            .resume(acp::SessionResumeCapabilities::new())
                            .close(acp::SessionCloseCapabilities::new()),
                    ),
            )
            .agent_info(acp::Implementation::new(
                "evot",
                self.options.agent_version.clone(),
            ))
    }

    async fn new_session(
        &self,
        request: acp::NewSessionRequest,
    ) -> RpcResult<acp::NewSessionResponse> {
        let cwd = absolute_dir(&request.cwd)?;
        if !request.mcp_servers.is_empty() {
            tracing::warn!(
                count = request.mcp_servers.len(),
                "acp: MCP servers are not supported; ignoring"
            );
        }
        self.refresh_config().await;
        let meta = self
            .agent
            .create_session_in("acp", Some(cwd))
            .await
            .map_err(internal)?;
        let config = self.config.read();
        let selection = Arc::new(ModelSelection::new(self.agent.llm()));
        let options = Self::config_options(&config, &selection);
        self.register(&meta.session_id, selection);
        Ok(acp::NewSessionResponse::new(meta.session_id).config_options(options))
    }

    async fn resume_session(
        &self,
        request: acp::ResumeSessionRequest,
    ) -> RpcResult<acp::ResumeSessionResponse> {
        let session_id = request.session_id.0.to_string();
        let meta = self
            .agent
            .sessions()
            .find(&session_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| acp::Error::resource_not_found(None))?;
        self.refresh_config().await;
        let config = self.config.read();
        let selection = Arc::new(ModelSelection::new(self.agent.llm()));
        if !meta.provider.is_empty() && !meta.model.is_empty() {
            // A saved model that is no longer configured falls back to the
            // current selection rather than failing the resume.
            let spec = format!("{}:{}", meta.provider, meta.model);
            if let Err(error) = selection.select_by_spec(&config, &spec) {
                tracing::info!("acp: resume keeps current model: {error}");
            }
        }
        let options = Self::config_options(&config, &selection);
        self.register(&session_id, selection);
        Ok(acp::ResumeSessionResponse::new().config_options(options))
    }

    async fn list_sessions(
        &self,
        request: acp::ListSessionsRequest,
    ) -> RpcResult<acp::ListSessionsResponse> {
        let cwd = request.cwd.as_deref().map(absolute_dir).transpose()?;
        let sessions = self
            .agent
            .sessions()
            .list(0)
            .await
            .map_err(internal)?
            .into_iter()
            .filter(|meta| cwd.as_ref().is_none_or(|cwd| &meta.cwd == cwd))
            .map(|meta| {
                let title = meta.custom_title.or(meta.title);
                acp::SessionInfo::new(meta.session_id, meta.cwd)
                    .title(title)
                    .updated_at(meta.updated_at)
            })
            .collect();
        Ok(acp::ListSessionsResponse::new(sessions))
    }

    fn close_session(
        &self,
        request: acp::CloseSessionRequest,
    ) -> RpcResult<acp::CloseSessionResponse> {
        let session_id = request.session_id.0.to_string();
        let state = self
            .sessions
            .lock()
            .remove(&session_id)
            .ok_or_else(|| acp::Error::resource_not_found(None))?;
        if let Some(prompt) = state.prompt {
            self.abort(&session_id, &prompt);
        }
        Ok(acp::CloseSessionResponse::new())
    }

    async fn set_config_option(
        &self,
        request: acp::SetSessionConfigOptionRequest,
    ) -> RpcResult<acp::SetSessionConfigOptionResponse> {
        if request.config_id.0.as_ref() != MODEL_CONFIG_ID {
            return Err(acp::Error::invalid_params().data(Value::from("unknown config option")));
        }
        let acp::SessionConfigOptionValue::ValueId { value } = request.value else {
            return Err(acp::Error::invalid_params().data(Value::from("model expects a value id")));
        };
        let selection = self
            .sessions
            .lock()
            .get(request.session_id.0.as_ref())
            .map(|state| state.selection.clone())
            .ok_or_else(|| acp::Error::resource_not_found(None))?;
        // Clients validate the saved model against the catalog this process
        // advertised. Re-read it first, as restarting the agent would.
        self.refresh_config().await;
        let config = self.config.read();
        selection
            .select_by_spec(&config, &value.0)
            .map_err(|error| acp::Error::invalid_params().data(Value::from(error.to_string())))?;
        Ok(acp::SetSessionConfigOptionResponse::new(
            Self::config_options(&config, &selection),
        ))
    }

    fn admit_prompt(self: &Arc<Self>, params: Value) -> RpcResult<AdmittedPrompt> {
        let request: acp::PromptRequest = parse(params)?;
        let session_id = request.session_id.0.to_string();
        let input = prompt_input(&request.prompt)?;
        let cancel = Arc::new(CancellationToken::new());
        let (selection, always_allowed) = {
            let mut sessions = self.sessions.lock();
            let state = sessions
                .get_mut(&session_id)
                .ok_or_else(|| acp::Error::resource_not_found(None))?;
            if state.prompt.is_some() {
                return Err(acp::Error::invalid_request()
                    .data(Value::from("a prompt is already running in this session")));
            }
            state.prompt = Some(cancel.clone());
            (state.selection.clone(), state.always_allowed.clone())
        };
        Ok(AdmittedPrompt {
            input,
            selection,
            always_allowed,
            finished: PromptFinished {
                server: self.clone(),
                session_id,
                cancel,
            },
        })
    }

    async fn prompt(self: &Arc<Self>, prompt: AdmittedPrompt) -> RpcResult<acp::PromptResponse> {
        let AdmittedPrompt {
            input,
            selection,
            always_allowed,
            finished,
        } = prompt;
        let session_id = finished.session_id.clone();
        let cancel = finished.cancel.clone();
        let _finished = finished;
        self.refresh_config().await;
        if cancel.is_cancelled() {
            return Ok(acp::PromptResponse::new(acp::StopReason::Cancelled));
        }
        let llm = selection.snapshot();
        let mut query = QueryRequest::with_input(input)
            .session_id(Some(session_id.clone()))
            .mode(self.options.mode)
            .llm(llm)
            .source("acp");
        if self.options.asks_permission() {
            query = query.approver(Arc::new(AcpApprover {
                connection: self.connection.clone(),
                session_id: session_id.clone(),
                always_allowed,
            }));
        }
        let mut run = match self.agent.submit(query).await.map_err(internal)? {
            SubmitOutcome::Run(run) => run,
            SubmitOutcome::Command(message) => {
                let chunk = acp::ContentChunk::new(acp::ContentBlock::from(message));
                self.connection
                    .update(&session_id, acp::SessionUpdate::AgentMessageChunk(chunk));
                return Ok(acp::PromptResponse::new(acp::StopReason::EndTurn));
            }
        };
        // A cancel that raced submission found no run to abort.
        if cancel.is_cancelled() {
            self.agent.abort_run(&session_id);
        }

        let mut projection = TurnProjection::new(self.options.asks_permission());
        while let Some(event) = run.next().await {
            if let Some(update) = projection.apply(&event) {
                self.connection.update(&session_id, update);
            }
        }
        // ACP requires `cancelled` after session/cancel, whatever the run did.
        if cancel.is_cancelled() {
            return Ok(acp::PromptResponse::new(acp::StopReason::Cancelled));
        }
        projection
            .finish()
            .map(acp::PromptResponse::new)
            .map_err(|message| acp::Error::internal_error().data(Value::from(message)))
    }

    fn register(&self, session_id: &str, selection: Arc<ModelSelection>) {
        self.sessions
            .lock()
            .insert(session_id.to_string(), SessionState {
                selection,
                always_allowed: Arc::default(),
                prompt: None,
            });
    }

    fn cancel_prompt(&self, session_id: &str) {
        if let Some(state) = self.sessions.lock().get(session_id) {
            if let Some(prompt) = &state.prompt {
                self.abort(session_id, prompt);
            }
        }
    }

    fn abort(&self, session_id: &str, prompt: &CancellationToken) {
        prompt.cancel();
        self.agent.abort_run(session_id);
    }

    /// Client disconnected: stop every running prompt.
    fn disconnect(&self) {
        self.connection.close();
        for (session_id, state) in self.sessions.lock().iter() {
            if let Some(prompt) = &state.prompt {
                self.abort(session_id, prompt);
            }
        }
    }

    /// Reload the config when a file it was loaded from changed since the
    /// last load: the cloud catalog cache, cloud login, env file or TOML.
    /// Other evot processes rewrite them (`evot login`, the REPL's catalog
    /// sync, key recovery), and without this a long-lived ACP process keeps
    /// rejecting models its startup snapshot lacked until the client
    /// restarts it. A failed reload keeps the current config and retries on
    /// the next request.
    async fn refresh_config(&self) {
        let Some(files) = &self.files else {
            return;
        };
        // Serialize check/load/publication so a slower request cannot publish
        // an older config after a newer refresh. Never hold a parking_lot
        // guard across the worker await.
        let mut files = files.lock().await;
        let snapshot = files.clone();
        let loaded = crate::base::blocking::blocking_io("acp config reload", move |cancel| {
            snapshot.reload(cancel)
        })
        .await;
        match loaded {
            Ok(Some((fresh, observed))) => {
                // Config -> selection is the same lock order as explicit model
                // switches and session registration. No reader may rebuild a
                // session from the old config after its selection was refreshed.
                let mut config = self.config.write();
                let landing = self.agent.reload_selection(&fresh);
                for state in self.sessions.lock().values() {
                    // Admitted runs own their LlmConfig copies. Refreshing the
                    // session only affects its next prompt and keeps effort.
                    state.selection.reload_selection(&fresh);
                }
                tracing::info!(?landing, "acp: reloaded config after its files changed");
                *config = fresh;
                files.accept(observed);
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!("acp: config reload failed, keeping current config: {error}");
            }
        }
    }

    /// The model selector: configured specs and legacy cloud group aliases,
    /// plus the session's current choice when it is not among them.
    fn config_options(
        config: &Config,
        selection: &ModelSelection,
    ) -> Vec<acp::SessionConfigOption> {
        let current = selection.snapshot();
        if current.provider.is_empty() || current.model.is_empty() {
            return Vec::new();
        }
        let current_value = format!("{}:{}", current.provider, current.model);
        let mut options = model_options(config);
        if !options
            .iter()
            .any(|option| option.value.0.as_ref() == current_value)
        {
            options.push(
                acp::SessionConfigSelectOption::new(current_value.clone(), current.model.clone())
                    .description(current.provider.clone()),
            );
        }
        vec![
            acp::SessionConfigOption::select(MODEL_CONFIG_ID, "Model", current_value, options)
                .category(acp::SessionConfigOptionCategory::Model),
        ]
    }
}

/// Clears the session's running prompt however the prompt task ends.
struct PromptFinished {
    server: Arc<Server>,
    session_id: String,
    cancel: Arc<CancellationToken>,
}

impl Drop for PromptFinished {
    fn drop(&mut self) {
        if let Some(state) = self.server.sessions.lock().get_mut(&self.session_id) {
            // Closing/resuming a session can admit a successor before this
            // task finishes. A stale guard must not clear its cancellation.
            if state
                .prompt
                .as_ref()
                .is_some_and(|prompt| Arc::ptr_eq(prompt, &self.cancel))
            {
                state.prompt = None;
            }
        }
    }
}

fn parse<T: DeserializeOwned>(params: Value) -> RpcResult<T> {
    serde_json::from_value(params)
        .map_err(|error| acp::Error::invalid_params().data(Value::from(error.to_string())))
}

fn internal(error: EvotError) -> acp::Error {
    acp::Error::internal_error().data(Value::from(error.to_string()))
}

/// ACP session paths must be absolute; evot also needs the directory to
/// exist. Canonical, so it compares equal to the cwd stored with sessions.
fn absolute_dir(path: &std::path::Path) -> RpcResult<String> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(acp::Error::invalid_params()
            .data(Value::from("cwd must be an existing absolute directory")));
    }
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(path.to_string_lossy().to_string())
}
