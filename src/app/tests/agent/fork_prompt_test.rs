//! A forked side session (`/log`) must send its instructions to the model
//! behind the evot identity line the gateway's origin guard requires.

use evot::agent::Agent;
use evot::agent::ForkRequest;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const SSE: &str = "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n\
data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n\
data: [DONE]\n\n";

#[tokio::test]
async fn forked_agent_sends_evot_identity_then_its_instructions() -> TestResult {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(SSE, "text/event-stream"))
        .expect(1)
        .mount(&server)
        .await;

    let dir = tempfile::tempdir()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "fixture".into(),
        base_url: server.uri(),
        models: vec!["fixture".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();
    let agent = Agent::new_ephemeral(&config, dir.path().to_string_lossy())?;

    let mut forked = agent.fork(ForkRequest {
        system_prompt: "You are in a temporary log analysis session.".into(),
    })?;
    let mut run = forked.query("what failed?").await?;
    while run.next().await.is_some() {}

    let requests = server
        .received_requests()
        .await
        .ok_or("no requests recorded")?;
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    let system = body["messages"][0]["content"]
        .as_str()
        .ok_or("first message is not a system string")?;
    assert!(system.starts_with(
        "You are an expert coding assistant running in evot, a coding agent harness."
    ));
    assert!(system.contains("You are in a temporary log analysis session."));
    assert!(!system.contains("Available tools:"));
    Ok(())
}

#[tokio::test]
async fn forked_structured_query_stays_on_its_readonly_side_session() -> TestResult {
    use evot::agent::tools::ToolMode;
    use evot::agent::QueryRequest;
    use evot_engine::Content;
    use evot_engine::ImageSource;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(SSE, "text/event-stream"))
        .expect(2)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "fixture".into(),
        base_url: server.uri(),
        models: vec!["fixture".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: Some(true),
    });
    config.llm.provider = "test".into();
    let agent = Agent::new_ephemeral(&config, dir.path().to_string_lossy())?;
    let mut fork = agent.fork(ForkRequest {
        system_prompt: "Read these logs only.".into(),
    })?;
    let mut initial = fork.query("log initial").await?;
    let fork_session = initial.session_id.clone();
    while initial.next().await.is_some() {}
    let mut request = QueryRequest::with_input(vec![
        Content::Text { text: "log follow-up".into() },
        Content::Image { mime_type: "image/png".into(), source: ImageSource::Base64 {
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==".into(),
        } },
    ]).session_id(Some("wrong-target".into())).mode(ToolMode::Interactive);
    request
        .extra_tools
        .push(std::sync::Arc::new(evot_engine::tools::WriteFileTool::new()));
    let mut follow_up = fork.query_input(request).await?;
    assert_eq!(follow_up.session_id, fork_session);
    while follow_up.next().await.is_some() {}
    let requests = server.received_requests().await.ok_or("no requests")?;
    let body: serde_json::Value = serde_json::from_slice(&requests[1].body)?;
    let serialized = body.to_string();
    assert!(serialized.contains("log initial"));
    assert!(serialized.contains("log follow-up"));
    assert!(serialized.contains("data:image/png;base64,"));
    let tools = body["tools"].as_array().ok_or("missing readonly tools")?;
    assert!(!tools.iter().any(|tool| matches!(
        tool["function"]["name"].as_str(),
        Some("write" | "edit" | "ask_user")
    )));
    Ok(())
}
