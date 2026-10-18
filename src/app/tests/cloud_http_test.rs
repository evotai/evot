//! Connection reuse and redirect safety for cloud session sync and shares.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::HeaderValue;
use axum::http::Method;
use axum::http::StatusCode;
use axum::http::Uri;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::Json;
use axum::Router;
use evot::auth::AuthState;
use evot::storage::MemoryStorage;
use evot::storage::Storage;
use evot::sync;
use evot::types::SessionMeta;
use futures::StreamExt;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const SHARE_ID: &str = "Xk3f9a2bQwErTyUiOpAs12";

#[derive(Clone, Debug)]
struct RecordedRequest {
    peer: SocketAddr,
    method: Method,
    path: String,
    authorization: Option<String>,
    user_agent: Option<String>,
    body: Vec<u8>,
}

struct ServerState {
    requests: Mutex<Vec<RecordedRequest>>,
    responses: Mutex<VecDeque<Response>>,
}

struct KeepAliveServer {
    url: String,
    state: Arc<ServerState>,
    task: JoinHandle<std::io::Result<()>>,
}

impl KeepAliveServer {
    async fn start(responses: Vec<Response>) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let url = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(ServerState {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(responses.into()),
        });
        let app = Router::new().fallback(record).with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        Ok(Self { url, state, task })
    }

    async fn assert_reused(&self, expected: usize) -> TestResult<Vec<RecordedRequest>> {
        let requests = self.state.requests.lock().await.clone();
        assert_eq!(requests.len(), expected);
        assert!(self.state.responses.lock().await.is_empty());
        let first = requests.first().ok_or("no requests received")?;
        for request in &requests {
            assert_eq!(request.peer, first.peer, "must reuse one TCP connection");
        }
        for request in &requests {
            assert!(
                request
                    .user_agent
                    .as_deref()
                    .is_some_and(|value| value.starts_with("evot/")),
                "cloud requests must use the engine's versioned User-Agent"
            );
        }
        Ok(requests)
    }
}

impl Drop for KeepAliveServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn record(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    state.requests.lock().await.push(RecordedRequest {
        peer,
        method,
        path: uri.path().to_owned(),
        authorization: header("authorization"),
        user_agent: header("user-agent"),
        body: body.to_vec(),
    });
    state
        .responses
        .lock()
        .await
        .pop_front()
        .unwrap_or_else(|| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn auth_state(base_url: &str, token: &str) -> Result<AuthState, serde_json::Error> {
    serde_json::from_value(json!({
        "version": 1, "server_base_url": base_url,
        "user": {"id": "user", "name": "User", "email": "user@test.dev"},
        "cli_token": token, "refresh_token": "", "models_synced_at": 0
    }))
}

fn empty_index() -> Response {
    Json(json!({"schema_version": 1, "sessions": []})).into_response()
}

fn shared_session() -> Response {
    Json(json!({
        "schema_version": 1,
        "meta": SessionMeta::new("remote".into(), "/w".into(), "m".into()),
        "seq": 0, "entries": [], "visibility": "private"
    }))
    .into_response()
}

// Delay a body larger than hyper's read buffer so dropping an unread response
// cannot accidentally reuse a connection just because a tiny body was buffered.
fn delayed_body(status: StatusCode) -> Response {
    let stream = futures::stream::once(async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 256 * 1024]))
    });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    response
}

#[tokio::test]
async fn cloud_http_reuses_connections_with_current_credentials() -> TestResult {
    let server = KeepAliveServer::start((0..6).map(|_| empty_index()).collect()).await?;
    for i in 0..6 {
        // AuthState is reloaded between periodic sync calls and token refreshes.
        let state = auth_state(&server.url, &format!("token-{i}"))?;
        let index = tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state)).await??;
        assert!(index.sessions.is_empty());
    }
    let requests = server.assert_reused(6).await?;
    for (i, request) in requests.iter().enumerate() {
        assert_eq!(request.authorization, Some(format!("Bearer token-{i}")));
        assert_eq!(request.path, "/v1/sessions");
    }
    Ok(())
}

#[tokio::test]
async fn cloud_http_shares_pool_without_caching_auth_or_server_selection() -> TestResult {
    let server = KeepAliveServer::start(vec![
        empty_index(),
        Json(json!({"shares": []})).into_response(),
        shared_session(),
        shared_session(),
        Json(json!({
            "schema_version": 1, "kind": "task", "evot_version": "test",
            "title": "Digest", "created_at": 1,
            "data": {"name": "Digest", "cron": "0 9 * * *", "instruction": "Summarise."}
        }))
        .into_response(),
        empty_index(),
    ])
    .await?;
    let other = KeepAliveServer::start(vec![empty_index()]).await?;
    let first_auth = auth_state(&server.url, "first")?;
    let other_auth = auth_state(&other.url, "other")?;
    let rotated_auth = auth_state(&server.url, "rotated")?;
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        sync::remote_index(&first_auth).await?;
        sync::remote_index(&other_auth).await?;
        evot::share::list(&rotated_auth).await?;
        evot::share::import_shared_session(
            &rotated_auth,
            &storage,
            &format!("https://evot.ai/share/{SHARE_ID}"),
        )
        .await?;
        evot::share::import_shared_session(
            &rotated_auth,
            &storage,
            &format!("https://evot.ai/team/{SHARE_ID}"),
        )
        .await?;
        evot::automation::fetch_task_share(&rotated_auth, SHARE_ID).await?;
        sync::remote_index(&rotated_auth).await?;
        Ok::<_, evot::error::EvotError>(())
    })
    .await??;

    let requests = server.assert_reused(6).await?;
    let expected_auth = [
        Some("Bearer first"),
        Some("Bearer rotated"),
        None,
        Some("Bearer rotated"),
        None,
        Some("Bearer rotated"),
    ];
    for (request, expected) in requests.iter().zip(expected_auth) {
        assert_eq!(request.authorization.as_deref(), expected);
    }
    let other_requests = other.assert_reused(1).await?;
    assert_eq!(
        other_requests[0].authorization.as_deref(),
        Some("Bearer other")
    );
    Ok(())
}

#[tokio::test]
async fn cloud_http_never_follows_same_or_cross_origin_redirects() -> TestResult {
    let server = MockServer::start().await;
    let other = MockServer::start().await;
    let state = auth_state(&server.uri(), "test-token")?;
    Mock::given(path("/redirected"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1, "sessions": [], "shares": []
        })))
        .expect(0)
        .mount(&other)
        .await;

    for status in [301, 302, 303, 307, 308] {
        for location in [
            "/redirected".to_owned(),
            format!("{}/redirected", other.uri()),
        ] {
            server.reset().await;
            Mock::given(method("GET"))
                .respond_with(
                    ResponseTemplate::new(status).insert_header("location", location.as_str()),
                )
                .expect(2)
                .mount(&server)
                .await;
            Mock::given(path("/redirected"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "schema_version": 1, "sessions": [], "shares": []
                })))
                .expect(0)
                .mount(&server)
                .await;
            assert!(
                tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state))
                    .await?
                    .is_err()
            );
            assert!(
                tokio::time::timeout(REQUEST_TIMEOUT, evot::share::list(&state))
                    .await?
                    .is_err()
            );
            server.verify().await;
        }
    }
    other.verify().await;
    Ok(())
}

#[tokio::test]
async fn cloud_http_drains_rate_limited_responses_before_retrying() -> TestResult {
    let mut limited = delayed_body(StatusCode::TOO_MANY_REQUESTS);
    limited
        .headers_mut()
        .insert("retry-after", HeaderValue::from_static("1"));
    let server = KeepAliveServer::start(vec![
        limited,
        Json(json!({"seq": 0, "visibility": "private"})).into_response(),
        empty_index(),
    ])
    .await?;
    let state = auth_state(&server.url, "test-token")?;
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let outcome = tokio::time::timeout(
        REQUEST_TIMEOUT,
        sync::share_session(&state, &storage, "s1", None, "test", &|_| {}),
    )
    .await??;
    assert!(matches!(outcome, sync::PushOutcome::Synced { .. }));
    tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state)).await??;
    let requests = server.assert_reused(3).await?;
    assert_eq!(requests[0].method, Method::PUT);
    assert_eq!(requests[1].method, Method::PUT);
    assert_eq!(requests[0].body, requests[1].body, "retry the same batch");
    Ok(())
}

#[tokio::test]
async fn cloud_http_does_not_extend_retry_after_for_a_stalled_body() -> TestResult {
    let mut limited = Response::new(Body::from_stream(futures::stream::pending::<
        Result<Bytes, std::io::Error>,
    >()));
    *limited.status_mut() = StatusCode::TOO_MANY_REQUESTS;
    limited
        .headers_mut()
        .insert("retry-after", HeaderValue::from_static("1"));
    let server = KeepAliveServer::start(vec![
        limited,
        Json(json!({"seq": 0, "visibility": "private"})).into_response(),
    ])
    .await?;
    let state = auth_state(&server.url, "test-token")?;
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(
        Duration::from_secs(3),
        sync::share_session(&state, &storage, "s1", None, "test", &|_| {}),
    )
    .await??;
    assert!(matches!(outcome, sync::PushOutcome::Synced { .. }));
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "honour Retry-After"
    );
    let requests = server.state.requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert_ne!(
        requests[0].peer, requests[1].peer,
        "discard the stalled socket"
    );
    assert_eq!(requests[0].body, requests[1].body);
    Ok(())
}

#[tokio::test]
async fn cloud_http_ignores_broken_delete_bodies() -> TestResult {
    let body = futures::stream::once(async { Ok(Bytes::from_static(b"partial")) }).chain(
        futures::stream::once(async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Err(std::io::Error::from(std::io::ErrorKind::ConnectionReset))
        }),
    );
    let server =
        KeepAliveServer::start(vec![Response::new(Body::from_stream(body)), empty_index()]).await?;
    let state = auth_state(&server.url, "test-token")?;
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    let mut meta = SessionMeta::new("s1".into(), "/w".into(), "m".into());
    meta.cloud = Some(evot::types::CloudSync::new(
        evot::types::CloudVisibility::Private,
        "test",
    ));
    storage.save_session(meta).await?;
    tokio::time::timeout(
        REQUEST_TIMEOUT,
        sync::unshare_session(&state, &storage, "s1"),
    )
    .await??;
    let meta = storage.get_session("s1").await?.ok_or("missing session")?;
    assert!(
        meta.cloud.is_none(),
        "DELETE succeeded despite an unreadable body"
    );
    tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state)).await??;
    assert_eq!(server.state.requests.lock().await.len(), 2);
    Ok(())
}

#[tokio::test]
async fn cloud_http_drains_successful_delete_responses() -> TestResult {
    let server = KeepAliveServer::start(vec![delayed_body(StatusCode::OK), empty_index()]).await?;
    let state = auth_state(&server.url, "test-token")?;
    let storage: Arc<dyn Storage> = Arc::new(MemoryStorage::new());
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    tokio::time::timeout(
        REQUEST_TIMEOUT,
        sync::unshare_session(&state, &storage, "s1"),
    )
    .await??;
    tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state)).await??;
    let requests = server.assert_reused(2).await?;
    assert_eq!(requests[0].method, Method::DELETE);
    Ok(())
}

#[tokio::test]
async fn cloud_http_reuses_connections_after_server_errors() -> TestResult {
    let server = KeepAliveServer::start(vec![
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "try later"})),
        )
            .into_response(),
        empty_index(),
    ])
    .await?;
    let state = auth_state(&server.url, "test-token")?;
    let error = tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state))
        .await?
        .err()
        .ok_or("expected a server error")?;
    assert!(error.to_string().contains("try later"), "{error}");
    tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state)).await??;
    server.assert_reused(2).await?;
    Ok(())
}

#[tokio::test]
async fn cloud_http_reconnects_when_the_server_closes_keep_alive() -> TestResult {
    let mut closing = empty_index();
    closing
        .headers_mut()
        .insert("connection", HeaderValue::from_static("close"));
    let server = KeepAliveServer::start(vec![closing, empty_index()]).await?;
    let state = auth_state(&server.url, "test-token")?;
    for _ in 0..2 {
        tokio::time::timeout(REQUEST_TIMEOUT, sync::remote_index(&state)).await??;
    }
    let requests = server.state.requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert_ne!(
        requests[0].peer, requests[1].peer,
        "closed sockets cannot be reused"
    );
    Ok(())
}
