//! Task-local workspaces must never fall back to the CLI checkout.
use std::path::Path;
use std::sync::Arc;

use evot::agent::turn_assembler::TurnAssembler;
use evot::agent::turn_assembler::TurnBuildRequest;
use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::SubmitOutcome;
use evot::agent::ToolMode;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::session::conversation::RunEventPayload;
use evot::session::storage::MemoryStorage;
use evot::session::Session;
use evot::surface::automation::workspace::prepare_request;
use evot::surface::automation::Task;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;
use evot_engine::provider::MockToolCall;
use evot_engine::provider::StreamProvider;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn task(workspace: &str) -> Result<Task, serde_json::Error> {
    serde_json::from_value(json!({
        "id": "task", "revision": 1, "name": "../untrusted task name",
        "cron": "0 * * * *", "timezone": "UTC", "instruction": "prepare a report",
        "executor_id": "device", "enabled": true, "next_run_at": 0,
        "workspace_ref": workspace
    }))
}

fn config(root: &Path) -> Config {
    let mut config = Config::new(root.to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "fixture-key".into(),
        base_url: "https://unused.example.test/v1".into(),
        models: vec!["fixture-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    config
}

#[tokio::test]
async fn default_workspace_and_scratch_belong_to_each_run() -> TestResult {
    let root = tempfile::tempdir()?;
    let task = task(" \t ")?;
    let first = prepare_request(root.path(), &task, "one").await?;
    let second = prepare_request(root.path(), &task, "two").await?;
    let cwd = Path::new(first.cwd.as_deref().ok_or("missing cwd")?);
    let scratch = first.scratch_dir.as_ref().ok_or("missing scratch")?;
    let session = first.session_id.as_ref().ok_or("missing session")?;
    assert_eq!(
        cwd,
        root.path()
            .canonicalize()?
            .join("sessions")
            .join(session)
            .join("workspace")
    );
    assert_eq!(
        scratch,
        &cwd.parent().ok_or("missing parent")?.join("scratch")
    );
    assert!(cwd.is_dir());
    assert!(scratch.is_dir());
    assert_ne!(first.cwd, second.cwd);
    assert_ne!(first.scratch_dir, second.scratch_dir);
    assert_eq!(first.source, "automation");
    assert_eq!(first.mode, ToolMode::Headless);
    assert_eq!(first.input_text(), task.instruction);
    // Re-preparing a claimed run preserves its artifacts and directory identity.
    std::fs::write(scratch.join("evidence.log"), "keep")?;
    let again = prepare_request(root.path(), &task, "one").await?;
    assert_eq!(again.cwd, first.cwd);
    assert_eq!(again.scratch_dir, first.scratch_dir);
    assert_eq!(
        std::fs::read_to_string(scratch.join("evidence.log"))?,
        "keep"
    );
    Ok(())
}

#[tokio::test]
async fn explicit_workspace_is_preserved_without_creating_scratch_inside_it() -> TestResult {
    let root = tempfile::tempdir()?;
    let project = tempfile::tempdir()?;
    let request = prepare_request(
        root.path(),
        &task(&project.path().to_string_lossy())?,
        "run",
    )
    .await?;
    assert_eq!(
        request.cwd.as_deref(),
        project.path().canonicalize()?.to_str()
    );
    let scratch = request.scratch_dir.ok_or("missing scratch")?;
    assert!(!scratch.starts_with(project.path().canonicalize()?));
    assert!(scratch.is_dir());
    assert_eq!(std::fs::read_dir(project.path())?.count(), 0);
    let session_dir = scratch.parent().ok_or("missing session dir")?;
    assert!(!session_dir.join("workspace").exists());
    Ok(())
}

#[tokio::test]
async fn invalid_workspaces_and_directory_creation_errors_never_fall_back() -> TestResult {
    let root = tempfile::tempdir()?;
    let missing = root.path().join("missing-project");
    assert!(
        prepare_request(root.path(), &task(&missing.to_string_lossy())?, "missing")
            .await
            .is_err()
    );
    assert!(
        !missing.exists(),
        "do not create a misspelled explicit workspace"
    );
    let file = root.path().join("not-a-directory");
    std::fs::write(&file, "file")?;
    assert!(
        prepare_request(root.path(), &task(&file.to_string_lossy())?, "file")
            .await
            .is_err()
    );
    assert!(prepare_request(&file, &task("")?, "blocked-root")
        .await
        .is_err());
    let prepared = prepare_request(root.path(), &task("")?, "blocked-scratch").await?;
    let scratch = prepared.scratch_dir.ok_or("missing scratch")?;
    std::fs::remove_dir(&scratch)?;
    std::fs::write(&scratch, "file")?;
    assert!(prepare_request(root.path(), &task("")?, "blocked-scratch")
        .await
        .is_err());
    Ok(())
}

struct CapturingProvider {
    inner: MockProvider,
    prompts: Arc<parking_lot::Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl StreamProvider for CapturingProvider {
    async fn stream(
        &self,
        config: evot_engine::provider::StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<evot_engine::provider::StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<evot_engine::provider::StreamOutcome, evot_engine::provider::ProviderError> {
        self.prompts.lock().push(config.system_prompt.clone());
        self.inner.stream(config, tx, cancel).await
    }
}

fn call(name: &str, arguments: serde_json::Value) -> MockResponse {
    MockResponse::ToolCalls(vec![MockToolCall {
        name: name.into(),
        arguments,
    }])
}

async fn drain(agent: &Arc<Agent>, request: QueryRequest) -> TestResult {
    let SubmitOutcome::Run(mut run) = agent.submit(request).await? else {
        return Err("expected run".into());
    };
    while let Some(event) = run.next().await {
        match event.payload {
            RunEventPayload::Error { message } => return Err(message.into()),
            RunEventPayload::ToolFinished {
                content, is_error, ..
            } => {
                assert!(!is_error, "{content}");
                assert!(!content.contains("Exit code:"), "{content}");
            }
            _ => {}
        }
    }
    Ok(())
}

#[tokio::test]
async fn task_tools_use_the_workspace_and_scratch_without_polluting_the_cli_checkout() -> TestResult
{
    let root = tempfile::tempdir()?;
    let checkout = tempfile::tempdir()?;
    let project = tempfile::tempdir()?;
    for explicit in [false, true] {
        let task = task(if explicit {
            project.path().to_str().ok_or("non-UTF8 project")?
        } else {
            ""
        })?;
        let request = prepare_request(
            root.path(),
            &task,
            if explicit { "project" } else { "isolated" },
        )
        .await?;
        let session_id = request.session_id.clone().ok_or("missing session")?;
        let cwd = std::path::PathBuf::from(request.cwd.as_ref().ok_or("missing cwd")?);
        let scratch = request.scratch_dir.clone().ok_or("missing scratch")?;
        let prompts = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let provider = CapturingProvider {
            prompts: prompts.clone(),
            inner: MockProvider::new(vec![
                call(
                    "bash",
                    json!({"command":
                    "set -eu; pwd -P > \"$EVOT_SCRATCH_DIR/cwd.txt\"; \
                     test \"$TMPDIR\" = \"$EVOT_SCRATCH_DIR\"; \
                     test \"$TMP\" = \"$TMPDIR\"; test \"$TEMP\" = \"$TMPDIR\"; \
                     mktemp \"$TMPDIR/temp.XXXXXX\" > \"$EVOT_SCRATCH_DIR/temp-path.txt\"; \
                     printf final > requested-result.txt; \
                     cd \"$EVOT_SCRATCH_DIR\"; printf debug > debug.log"}),
                ),
                call(
                    "write",
                    json!({"path": scratch.join("intermediate.txt"), "content": "before"}),
                ),
                call(
                    "edit",
                    json!({"path": scratch.join("intermediate.txt"), "edits": [{"oldText": "before", "newText": "after"}]}),
                ),
                MockResponse::Text("done".into()),
            ]),
        };
        let agent = Agent::new_with_provider_for_test(
            &config(root.path()),
            checkout.path().to_string_lossy(),
            Arc::new(MemoryStorage::new()),
            provider,
        )?;
        let variables = Arc::new(evot::agent::Variables::new(
            agent.storage(),
            ["EVOT_SCRATCH_DIR", "TMPDIR", "TMP", "TEMP"]
                .into_iter()
                .map(|key| evot::types::VariableRecord {
                    key: key.into(),
                    value: "/unused/inherited-task-temp-directory".into(),
                    updated_at: String::new(),
                })
                .collect(),
        ));
        let agent = agent.with_variables(variables);
        drain(&agent, request).await?;
        assert_eq!(
            std::fs::read_to_string(cwd.join("requested-result.txt"))?,
            "final"
        );
        assert_eq!(std::fs::read_to_string(scratch.join("debug.log"))?, "debug");
        assert_eq!(
            std::fs::read_to_string(scratch.join("intermediate.txt"))?,
            "after"
        );
        assert_eq!(
            std::fs::read_to_string(scratch.join("cwd.txt"))?.trim(),
            cwd.to_string_lossy()
        );
        let temp_path = std::fs::read_to_string(scratch.join("temp-path.txt"))?;
        assert!(Path::new(temp_path.trim()).starts_with(&scratch));
        let session = agent
            .load_session(&session_id)
            .await?
            .ok_or("missing session")?;
        assert_eq!(session.meta().await.cwd, cwd.to_string_lossy());
        let prompts = prompts.lock();
        assert!(prompts.len() >= 4);
        for prompt in prompts.iter() {
            assert!(prompt.contains(&format!("Run scratch directory: {}", scratch.display())));
            assert!(prompt.contains("never in the project workspace"));
            assert!(prompt.contains("do not move source edits"));
        }
    }
    assert_eq!(std::fs::read_dir(checkout.path())?.count(), 0);
    assert!(!project.path().join("debug.log").exists());
    assert!(!project.path().join("intermediate.txt").exists());
    Ok(())
}

#[tokio::test]
async fn an_existing_task_session_cannot_silently_override_the_prepared_workspace() -> TestResult {
    let root = tempfile::tempdir()?;
    let checkout = tempfile::tempdir()?;
    let agent = Agent::new_with_provider_for_test(
        &config(root.path()),
        checkout.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        MockProvider::text("must not run"),
    )?;
    let request = prepare_request(root.path(), &task("")?, "legacy-run").await?;
    let session_id = request.session_id.clone().ok_or("missing session")?;
    // Emulate a pre-isolation run that persisted the launcher's checkout.
    let legacy = Session::new_with_provider_source(
        session_id.clone(),
        checkout
            .path()
            .canonicalize()?
            .to_string_lossy()
            .into_owned(),
        "test".into(),
        "fixture-model".into(),
        "automation",
        agent.storage(),
    )
    .await?;
    let error = match agent.submit(request).await {
        Ok(_) => return Err("reused the old checkout".into()),
        Err(error) => error,
    };
    assert!(error.to_string().contains("task session workspace differs"));
    assert_eq!(
        legacy.meta().await.cwd,
        checkout.path().canonicalize()?.to_string_lossy()
    );
    assert_eq!(std::fs::read_dir(checkout.path())?.count(), 0);
    Ok(())
}

#[tokio::test]
async fn ordinary_runs_still_use_the_selected_project_without_task_scratch_instructions(
) -> TestResult {
    let root = tempfile::tempdir()?;
    let project = tempfile::tempdir()?;
    let prompts = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let agent = Agent::new_with_provider_for_test(
        &config(root.path()),
        project.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        CapturingProvider {
            prompts: prompts.clone(),
            inner: MockProvider::new(vec![
                call("bash", json!({"command": "printf ordinary > ordinary.txt"})),
                MockResponse::Text("done".into()),
            ]),
        },
    )?;
    drain(&agent, QueryRequest::text("work in the current project")).await?;
    assert_eq!(
        std::fs::read_to_string(project.path().join("ordinary.txt"))?,
        "ordinary"
    );
    assert!(!prompts.lock().is_empty());
    assert!(prompts
        .lock()
        .iter()
        .all(|prompt| !prompt.contains("Run scratch directory:")));
    Ok(())
}

#[tokio::test]
async fn scratch_is_allowed_by_the_file_sandbox_without_opening_the_startup_checkout() -> TestResult
{
    let root = tempfile::tempdir()?;
    let outside = tempfile::tempdir()?;
    let request = prepare_request(root.path(), &task("")?, "sandbox").await?;
    let scratch = request.scratch_dir.clone().ok_or("missing scratch")?;
    let session_id = request.session_id.as_ref().ok_or("missing session")?;
    let mut config = config(root.path());
    config.sandbox.enabled = true;
    let llm = config.build_llm("test", None)?;
    let session = Session::new_with_provider_source(
        session_id.clone(),
        request.cwd.clone().ok_or("missing cwd")?,
        llm.provider.clone(),
        llm.model.clone(),
        "automation",
        Arc::new(MemoryStorage::new()),
    )
    .await?;
    let turn = TurnAssembler::new(&config)
        .build_turn(
            &llm,
            ToolMode::Readonly,
            session,
            session_id,
            TurnBuildRequest {
                input: request.input,
                scratch_dir: request.scratch_dir,
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: false,
                previous_llm: None,
            },
        )
        .await?;
    let guard = turn.options.path_guard;
    assert!(guard
        .resolve_path(
            &turn.options.cwd,
            &scratch.join("data.json").to_string_lossy()
        )
        .is_ok());
    assert!(guard
        .resolve_path(
            &turn.options.cwd,
            &outside.path().join("unrelated.json").to_string_lossy()
        )
        .is_err());
    Ok(())
}
