use evot::auth::AuthState;
use serde_json::json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

#[tokio::test]
async fn share_client_uploads_more_than_the_former_32_mib_limit(
) -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    let state: AuthState = serde_json::from_value(json!({
        "version":1, "server_base_url":server.uri(),
        "user":{"id":"user", "name":"User", "email":"user@test.dev"},
        "cli_token":"test-token", "refresh_token":"", "models_synced_at":0
    }))?;
    Mock::given(method("POST"))
        .and(path("/v1/shares"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": "token", "url": "https://evot.ai/share/token"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let payload = evot::share::ShareUpload {
        schema_version: 1,
        evot_version: "test".into(),
        session_id: "session".into(),
        title: None,
        data: json!({"text": "x".repeat(33 * 1024 * 1024)}),
    };

    let created = evot::share::upload(&state, &payload).await?;
    assert_eq!(created.id, "token");
    let requests = server.received_requests().await.ok_or("missing requests")?;
    let request = requests.first().ok_or("missing upload")?;
    assert!(request.body.len() > 32 * 1024 * 1024);
    server.verify().await;
    Ok(())
}

#[tokio::test]
async fn share_client_uses_cli_auth_and_never_follows_redirects(
) -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    let state: AuthState = serde_json::from_value(json!({
        "version":1, "server_base_url":server.uri(),
        "user":{"id":"user", "name":"User", "email":"user@test.dev"},
        "cli_token":"test-token", "refresh_token":"", "models_synced_at":0
    }))?;
    Mock::given(method("GET"))
        .and(path("/v1/shares"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"shares":[]})))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(evot::share::list(&state).await?, json!({"shares":[]}));
    Mock::given(method("POST"))
        .and(path("/v1/shares"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/private"))
        .expect(1)
        .mount(&server)
        .await;
    let payload = evot::share::ShareUpload {
        schema_version: 1,
        evot_version: "test".into(),
        session_id: "session".into(),
        title: None,
        data: json!({}),
    };
    assert!(evot::share::upload(&state, &payload).await.is_err());
    server.verify().await;
    Ok(())
}
