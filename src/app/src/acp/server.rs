//! ACP v1 method handlers and the per-connection read loop.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use agent_client_protocol_schema::v1 as acp;
use agent_client_protocol_schema::ProtocolVersion;
use futures::StreamExt;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::task::JoinSet;
use tokio_util::codec::FramedRead;
use tokio_util::codec::LinesCodec;
use tokio_util::codec::LinesCodecError;
use tokio_util::sync::CancellationToken;

use super::connection::to_value;
use super::connection::write_frames;
use super::connection::Connection;
use super::connection::Inbound;
use super::permission::AcpApprover;
use super::projection::TurnProjection;
use super::prompt::prompt_input;
use super::AcpOptions;
use crate::agent::Agent;
use crate::agent::QueryRequest;
use crate::agent::SubmitOutcome;
use crate::conf::Config;
use crate::error::EvotError;
use crate::error::Result;
use crate::models::ModelSelection;

/// Largest accepted inbound frame. Prompts are text only, so this is generous.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MODEL_CONFIG_ID: &str = "model";

type RpcResult<T> = std::result::Result<T, acp::Error>;

/// Serve ACP on this process's stdin/stdout until stdin closes. Stdout
/// carries protocol frames only; diagnostics go to tracing.
pub async fn serve_stdio(config: Config, options: AcpOptions) -> Result<()> {
    let agent = if options.ephemeral {
        crate::bootstrap::build_ephemeral_agent(&config).await?
    } else {
        crate::bootstrap::build_agent(&config).await?
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
    let server = Arc::new(Server {
        agent,
        config,
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
    prompt: Option<CancellationToken>,
}

struct Server {
    agent: Arc<Agent>,
    config: Config,
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
                let server = self.clone();
                prompts.spawn(async move {
                    let result = server.prompt(params).await;
                    server.connection.reply(id, result);
                });
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
            "session/set_config_option" => to_value(self.set_config_option(parse(params)?)?),
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
                    .prompt_capabilities(acp::PromptCapabilities::new())
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
        let meta = self
            .agent
            .create_session_in("acp", Some(cwd))
            .await
            .map_err(internal)?;
        let selection = Arc::new(ModelSelection::new(self.agent.llm()));
        let options = self.config_options(&selection);
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
        let selection = Arc::new(ModelSelection::new(self.agent.llm()));
        if !meta.provider.is_empty() && !meta.model.is_empty() {
            // A saved model that is no longer configured falls back to the
            // current selection rather than failing the resume.
            let spec = format!("{}:{}", meta.provider, meta.model);
            if let Err(error) = selection.select_by_spec(&self.config, &spec) {
                tracing::info!("acp: resume keeps current model: {error}");
            }
        }
        let options = self.config_options(&selection);
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

    fn set_config_option(
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
        selection
            .select_by_spec(&self.config, &value.0)
            .map_err(|error| acp::Error::invalid_params().data(Value::from(error.to_string())))?;
        Ok(acp::SetSessionConfigOptionResponse::new(
            self.config_options(&selection),
        ))
    }

    async fn prompt(self: &Arc<Self>, params: Value) -> RpcResult<acp::PromptResponse> {
        let request: acp::PromptRequest = parse(params)?;
        let session_id = request.session_id.0.to_string();
        let input = prompt_input(&request.prompt)?;
        let cancel = CancellationToken::new();
        let (llm, always_allowed) = {
            let mut sessions = self.sessions.lock();
            let state = sessions
                .get_mut(&session_id)
                .ok_or_else(|| acp::Error::resource_not_found(None))?;
            if state.prompt.is_some() {
                return Err(acp::Error::invalid_request()
                    .data(Value::from("a prompt is already running in this session")));
            }
            state.prompt = Some(cancel.clone());
            (state.selection.snapshot(), state.always_allowed.clone())
        };
        let _finished = PromptFinished {
            server: self.clone(),
            session_id: session_id.clone(),
        };

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

    /// The model selector: every configured `provider:model`, plus the
    /// session's current choice when it is not among them.
    fn config_options(&self, selection: &ModelSelection) -> Vec<acp::SessionConfigOption> {
        let current = selection.snapshot();
        if current.provider.is_empty() || current.model.is_empty() {
            return Vec::new();
        }
        let current_value = format!("{}:{}", current.provider, current.model);
        let mut options: Vec<acp::SessionConfigSelectOption> = self
            .config
            .providers
            .iter()
            .flat_map(|(provider, profile)| {
                profile.models.iter().map(move |model| {
                    acp::SessionConfigSelectOption::new(
                        format!("{provider}:{model}"),
                        model.clone(),
                    )
                    .description(provider.clone())
                })
            })
            .collect();
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
}

impl Drop for PromptFinished {
    fn drop(&mut self) {
        if let Some(state) = self.server.sessions.lock().get_mut(&self.session_id) {
            state.prompt = None;
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
