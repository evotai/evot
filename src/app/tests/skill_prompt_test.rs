use std::sync::Arc;

use evot::agent::Agent;
use evot::agent::QueryRequest;
use evot::agent::SubmitOutcome;
use evot::agent::ToolMode;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::observability::TranscriptStats;
use evot::storage::MemoryStorage;
use evot_engine::provider::MockProvider;
use tempfile::TempDir;

fn test_agent(tmp: &TempDir) -> Result<Arc<Agent>, Box<dyn std::error::Error>> {
    let mut config = Config::new(tmp.path().join("state"));
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
    Ok(Agent::new_with_provider_for_test(
        &config,
        tmp.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        MockProvider::text("ok"),
    )?)
}

async fn first_request_prompt(
    agent: &Arc<Agent>,
    request: QueryRequest,
) -> Result<(String, Vec<String>), Box<dyn std::error::Error>> {
    let meta = agent.create_session("test").await?;
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or("missing session")?;
    let outcome = agent.submit_to_session(request, session).await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => return Err(message.into()),
    };
    while run.next().await.is_some() {}

    let transcript = agent.sessions().transcript(&meta.session_id).await?;
    let started = transcript
        .iter()
        .find_map(TranscriptStats::try_from_item)
        .and_then(|stats| match stats {
            TranscriptStats::LlmCallStarted(started) => Some(started),
            _ => None,
        })
        .ok_or("missing llm call")?;
    Ok((
        started.system_prompt,
        started
            .tool_definitions
            .into_iter()
            .map(|tool| tool.name)
            .collect(),
    ))
}

#[tokio::test]
async fn selected_skills_filter_the_system_prompt() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let agent = test_agent(&tmp)?;
    agent.set_skill_names(vec!["harden".into()])?;

    let (prompt, tools) = first_request_prompt(
        &agent,
        QueryRequest::text("harden this").mode(ToolMode::Interactive),
    )
    .await?;

    assert!(prompt.contains("<available_skills>"));
    assert!(prompt.contains("<name>harden</name>"));
    assert!(!prompt.contains("<name>memory</name>"));
    assert!(!tools.iter().any(|tool| tool == "skill"));
    Ok(())
}

#[tokio::test]
async fn active_modes_do_not_inject_retired_planning_instructions(
) -> Result<(), Box<dyn std::error::Error>> {
    for mode in [
        ToolMode::Interactive,
        ToolMode::Headless,
        ToolMode::Readonly,
        ToolMode::Chat,
    ] {
        let tmp = TempDir::new()?;
        let agent = test_agent(&tmp)?;
        agent.set_skill_names(vec![
            "harden".into(),
            "memory".into(),
            "session-search".into(),
        ])?;
        let (prompt, tools) =
            first_request_prompt(&agent, QueryRequest::text("hello").mode(mode)).await?;
        let prompt = prompt.to_lowercase();
        for retired in [
            "/plan",
            "/act",
            "plan mode",
            "plan-mode",
            "planning mode",
            "planning_mode",
            "stay in plan",
            "[done:",
        ] {
            assert!(
                !prompt.contains(retired),
                "{mode:?} prompt still contains {retired:?}"
            );
        }
        assert!(!tools.iter().any(|tool| tool == "plan"));
        let writable = matches!(mode, ToolMode::Interactive | ToolMode::Headless);
        for tool in ["edit", "write"] {
            assert_eq!(tools.iter().any(|name| name == tool), writable);
        }
    }
    Ok(())
}

#[test]
fn builtin_skill_bodies_do_not_reference_retired_planning_mode() {
    for body in [
        include_str!("../src/agent/prompt/prompts/harden.md"),
        include_str!("../src/agent/prompt/prompts/memory.md"),
        include_str!("../src/agent/prompt/prompts/session-search.md"),
    ] {
        let body = body.to_lowercase();
        for retired in ["/plan", "/act", "plan mode", "plan-mode", "planning mode"] {
            assert!(
                !body.contains(retired),
                "builtin skill still contains {retired:?}"
            );
        }
    }
}

#[tokio::test]
async fn empty_skill_selection_omits_the_index() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let agent = test_agent(&tmp)?;
    agent.set_skill_names(Vec::new())?;

    let (prompt, tools) =
        first_request_prompt(&agent, QueryRequest::text("hello").mode(ToolMode::Headless)).await?;

    assert!(!prompt.contains("<available_skills>"));
    assert!(!tools.iter().any(|tool| tool == "skill"));
    Ok(())
}
