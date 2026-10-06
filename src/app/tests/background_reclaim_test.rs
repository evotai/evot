//! Session-scoped reclaim accessors.
//!
//! These resolve a session id to its process manager. A wrong or missing lookup
//! returns zero rather than failing, which in the TUI means ctrl+b finds
//! "nothing waiting" and reports that it moved nothing — so a user watching a
//! live command would be told there is none. So the lookup itself is worth
//! pinning.
//!
//! Also covers the mode seam these accessors sit behind: whether a session owns
//! a process manager at all decides whether a `timeout` backgrounds a command or
//! kills it.

use std::sync::Arc;

use evot::agent::Agent;
use evot::agent::BackgroundReason;
use evot::agent::QueryRequest;
use evot::agent::SubmitOutcome;
use evot::agent::ToolMode;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::storage::MemoryStorage;
use evot_engine::provider::mock::MockToolCall;
use evot_engine::provider::MockProvider;
use evot_engine::provider::MockResponse;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn provider_config(tmp: &tempfile::TempDir) -> Config {
    let mut config = Config::new(tmp.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["test-model".into()],
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

fn test_agent(tmp: &tempfile::TempDir) -> Result<Arc<Agent>, Box<dyn std::error::Error>> {
    let config = provider_config(tmp);
    Ok(Agent::new_with_provider_for_test(
        &config,
        tmp.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        MockProvider::text("done"),
    )?)
}

/// An agent whose first turn detaches a long shell, so the session provably owns
/// a process manager with live work in it.
fn agent_that_starts_a_background_shell(
    tmp: &tempfile::TempDir,
) -> Result<Arc<Agent>, Box<dyn std::error::Error>> {
    agent_that_backgrounds_command(tmp, "sleep 30")
}

/// Same, with the command spelled out.
///
/// The duration matters per test rather than globally: a run that must still own
/// live work when the assertions run needs a long command, while one asserting
/// the task was never registered does not — and there it runs inline to
/// completion, so a long sleep would just stall the suite for its full length.
fn agent_that_backgrounds_command(
    tmp: &tempfile::TempDir,
    command: &str,
) -> Result<Arc<Agent>, Box<dyn std::error::Error>> {
    let config = provider_config(tmp);
    let provider = MockProvider::new(vec![
        MockResponse::ToolCalls(vec![MockToolCall {
            name: "bash".into(),
            arguments: serde_json::json!({
                "command": command,
                "description": "test background process reclaim",
                "run_in_background": true,
            }),
        }]),
        MockResponse::Text("started".into()),
    ]);
    Ok(Agent::new_with_provider_for_test(
        &config,
        tmp.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        provider,
    )?)
}

/// Runs one interactive turn so the session acquires a process manager.
///
/// Interactive mode is the one that allows background processes, and the manager
/// is created lazily when a run is built — so a session that has never run has
/// nothing to look up.
async fn session_with_manager(agent: &Arc<Agent>) -> Result<String, Box<dyn std::error::Error>> {
    let meta = agent.create_session("test").await?;
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;
    let outcome = agent
        .submit_to_session(
            QueryRequest::text("hello").mode(ToolMode::Interactive),
            session,
        )
        .await?;
    if let SubmitOutcome::Run(mut run) = outcome {
        while run.next().await.is_some() {}
    }
    Ok(meta.session_id)
}

#[tokio::test]
async fn a_session_with_live_work_really_owns_a_manager() -> TestResult {
    // Anchors every other test in this file. They all assert zero, which is also
    // what a missing manager returns -- so without one case proving the lookup
    // resolves to a real registry, the whole file could pass while the accessors
    // were wired to nothing.
    let tmp = tempfile::TempDir::new()?;
    let agent = agent_that_starts_a_background_shell(&tmp)?;
    let session_id = session_with_manager(&agent).await?;

    let tasks = agent.background_processes(&session_id);
    assert_eq!(
        tasks.len(),
        1,
        "expected the detached shell, got: {tasks:?}"
    );

    // The shell detached itself, so nothing is in the foreground and no wait is
    // outstanding: this is the state the screenshot showed, where esc used to
    // find nothing to release and killed the run instead.
    assert_eq!(
        agent.background_foreground_processes(&session_id, BackgroundReason::UserRequested),
        0
    );
    assert_eq!(agent.blocking_task_waits(&session_id), 0);

    agent.stop_all_background_processes(&session_id).await;
    Ok(())
}

#[tokio::test]
async fn an_idle_session_has_nothing_to_reclaim() -> TestResult {
    let tmp = tempfile::TempDir::new()?;
    let agent = test_agent(&tmp)?;
    let session_id = session_with_manager(&agent).await?;

    // No shell and no wait: the caller is expected to escalate to interrupting.
    assert_eq!(
        agent.background_foreground_processes(&session_id, BackgroundReason::UserRequested),
        0
    );
    assert_eq!(agent.blocking_task_waits(&session_id), 0);
    assert_eq!(agent.release_blocking_task_waits(&session_id), 0);
    Ok(())
}

#[tokio::test]
async fn an_unknown_session_reports_nothing_rather_than_failing() -> TestResult {
    // Sessions disappear via /clear, /new and resume, and a keypress can land in
    // that window. Reporting zero is right; panicking or erroring is not.
    let tmp = tempfile::TempDir::new()?;
    let agent = test_agent(&tmp)?;

    assert_eq!(
        agent.background_foreground_processes("no-such-session", BackgroundReason::UserRequested),
        0
    );
    assert_eq!(agent.blocking_task_waits("no-such-session"), 0);
    assert_eq!(agent.release_blocking_task_waits("no-such-session"), 0);
    Ok(())
}

#[tokio::test]
async fn reclaim_accessors_are_scoped_to_one_session() -> TestResult {
    // The lookup is by session id, so one session's gesture must never disturb
    // another's work. Both sessions are idle here, so the assertion is that
    // neither call reaches across.
    let tmp = tempfile::TempDir::new()?;
    let agent = test_agent(&tmp)?;
    let first = session_with_manager(&agent).await?;
    let second = session_with_manager(&agent).await?;
    assert_ne!(first, second);

    assert_eq!(
        agent.background_foreground_processes(&first, BackgroundReason::UserRequested),
        0
    );
    assert_eq!(agent.blocking_task_waits(&second), 0);
    Ok(())
}

#[tokio::test]
async fn a_session_that_never_ran_has_no_manager() -> TestResult {
    // A created-but-unrun session has no process manager yet. The accessors must
    // treat that as "nothing waiting" rather than materialising one.
    let tmp = tempfile::TempDir::new()?;
    let agent = test_agent(&tmp)?;
    let meta = agent.create_session("test").await?;

    assert_eq!(agent.blocking_task_waits(&meta.session_id), 0);
    assert_eq!(
        agent.background_foreground_processes(&meta.session_id, BackgroundReason::MessageDelivery),
        0
    );
    assert!(agent.background_processes(&meta.session_id).is_empty());
    Ok(())
}

/// Runs one turn in a caller-chosen mode, so a test can pick the side of the
/// background seam it wants to exercise.
async fn session_with_manager_in_mode(
    agent: &Arc<Agent>,
    mode: ToolMode,
) -> Result<String, Box<dyn std::error::Error>> {
    let meta = agent.create_session("test").await?;
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;
    let outcome = agent
        .submit_to_session(QueryRequest::text("hello").mode(mode), session)
        .await?;
    if let SubmitOutcome::Run(mut run) = outcome {
        while run.next().await.is_some() {}
    }
    Ok(meta.session_id)
}

#[tokio::test]
async fn a_headless_run_registers_no_background_task() -> TestResult {
    // The seam that decides whether a `timeout` kills or backgrounds. Headless
    // gets no process manager, so its bash has no background support and its
    // deadline stays a kill -- the only bound such a run has, since it has no
    // yield, no task_output and no notifications.
    //
    // Worth testing across crates: the engine half is covered by its own tests,
    // but nothing checked that app-level mode policy actually selects it. A
    // future mode gaining a manager would silently make every headless timeout
    // non-terminating.
    let tmp = tempfile::TempDir::new()?;
    // Short: headless refuses the capability, so this runs inline to completion
    // and a long sleep would stall the suite for its full length. The assertion
    // is that no task was registered, which the duration says nothing about.
    let agent = agent_that_backgrounds_command(&tmp, "true")?;
    let session_id = session_with_manager_in_mode(&agent, ToolMode::Headless).await?;

    // The model asked for run_in_background and was refused the capability, so
    // the command ran to completion inline instead of becoming a task.
    assert!(
        agent.background_processes(&session_id).is_empty(),
        "headless must not own background tasks, got: {:?}",
        agent.background_processes(&session_id)
    );
    assert_eq!(agent.blocking_task_waits(&session_id), 0);
    Ok(())
}

#[tokio::test]
async fn an_interactive_run_does_register_one() -> TestResult {
    // The contrast that gives the test above its meaning: identical request and
    // identical mock, opposite outcome, decided only by mode.
    let tmp = tempfile::TempDir::new()?;
    let agent = agent_that_starts_a_background_shell(&tmp)?;
    let session_id = session_with_manager_in_mode(&agent, ToolMode::Interactive).await?;

    assert_eq!(agent.background_processes(&session_id).len(), 1);

    agent.stop_all_background_processes(&session_id).await;
    Ok(())
}
