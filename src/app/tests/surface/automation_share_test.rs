use evot::auth::AuthState;
use evot::surface::automation::fetch_task_share;
use evot::surface::automation::parse_task_share_id;
use evot::surface::automation::share_task;
use serde_json::json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

const ID: &str = "Xk3f9a2bQwErTyUiOpAs12";

#[test]
fn share_links_are_recognised_by_path_only() {
    for input in [
        "https://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12",
        "http://localhost:8787/share/t/Xk3f9a2bQwErTyUiOpAs12/",
        "evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12?x=1#frag",
        "https://anything.example/share/t/Xk3f9a2bQwErTyUiOpAs12/task.json",
        "  Xk3f9a2bQwErTyUiOpAs12  ",
    ] {
        assert_eq!(parse_task_share_id(input).as_deref(), Some(ID), "{input}");
    }
}

#[test]
fn prompts_and_other_links_are_not_share_links() {
    for input in [
        "",
        "summarise hacker news every morning",
        "import https://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12 please",
        "https://evot.ai/share/Xk3f9a2bQwErTyUiOpAs12",
        "https://evot.ai/share/t/short",
        "https://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12/extra",
        "ftp://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12",
        "https://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs1!",
    ] {
        assert_eq!(parse_task_share_id(input), None, "{input:?}");
    }
}

fn auth(server: &MockServer) -> Result<AuthState, serde_json::Error> {
    serde_json::from_value(json!({
        "version":1, "server_base_url":server.uri(),
        "user":{"id":"user", "name":"User", "email":"user@test.dev"},
        "cli_token":"test-token", "refresh_token":"", "models_synced_at":0
    }))
}

fn snapshot(schema_version: u32, kind: &str) -> serde_json::Value {
    json!({
        "schema_version": schema_version, "kind": kind, "evot_version": "1.0", "title": "Digest",
        "created_at": 1, "data": {
            "name": "Digest", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai",
            "instruction": "Summarise.", "model_policy": "fixed",
            "model_spec": "anthropic:claude", "thinking_level": "high",
            "timeout_seconds": 900, "max_lateness_seconds": 14400,
            "delivery_channel": "feishu", "delivery_target_masked": "oc_1a2b••••",
            "future_field": "ignored"
        }
    })
}

#[tokio::test]
async fn publishing_posts_to_the_owned_task_with_cli_auth() -> Result<(), Box<dyn std::error::Error>>
{
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/tasks/task-1/share"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": ID, "url": format!("https://evot.ai/share/t/{ID}"), "kind": "task"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let created = share_task(&auth(&server)?, "task-1").await?;
    assert_eq!(created.url, format!("https://evot.ai/share/t/{ID}"));
    server.verify().await;
    Ok(())
}

#[tokio::test]
async fn importing_reads_from_our_own_server_whatever_host_was_pasted(
) -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/share/t/{ID}/task.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(snapshot(1, "task")))
        .expect(1)
        .mount(&server)
        .await;
    let state = auth(&server)?;
    let shared = fetch_task_share(&state, &format!("https://evil.example/share/t/{ID}")).await?;
    assert_eq!(shared.data.name, "Digest");
    assert_eq!(shared.data.delivery_target_masked, "oc_1a2b••••");
    assert!(fetch_task_share(&state, "make me a task").await.is_err());
    server.verify().await;
    Ok(())
}

#[tokio::test]
async fn future_schemas_and_other_kinds_are_refused_clearly(
) -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    let newer = "Nk3f9a2bQwErTyUiOpAs12";
    let session = "Sk3f9a2bQwErTyUiOpAs12";
    let gone = "Gk3f9a2bQwErTyUiOpAs12";
    Mock::given(method("GET"))
        .and(path(format!("/share/t/{newer}/task.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(snapshot(2, "task")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/share/t/{session}/task.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(snapshot(1, "session")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/share/t/{gone}/task.json")))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "share not found"})))
        .mount(&server)
        .await;
    let state = auth(&server)?;
    let error = fetch_task_share(&state, newer)
        .await
        .err()
        .map(|e| e.to_string());
    assert!(
        error.as_deref().unwrap_or_default().contains("update evot"),
        "{error:?}"
    );
    let error = fetch_task_share(&state, session)
        .await
        .err()
        .map(|e| e.to_string());
    assert!(
        error
            .as_deref()
            .unwrap_or_default()
            .contains("not a shared task"),
        "{error:?}"
    );
    let error = fetch_task_share(&state, gone)
        .await
        .err()
        .map(|e| e.to_string());
    assert!(
        error.as_deref().unwrap_or_default().contains("revoked"),
        "{error:?}"
    );
    Ok(())
}
