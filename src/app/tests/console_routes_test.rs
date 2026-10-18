//! Exercises the console's HTTP surface against the real router: the page
//! documents, their static assets, and the split models/channel APIs.
//!
//! These run through `Server::router`, so a route that is declared but not
//! reachable (or an asset served with the wrong content type, which a browser
//! silently refuses to execute as a module) fails here rather than in a browser.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use axum::http::StatusCode;
use evot::agent::Agent;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::gateway::channels::http::Server;
use evot::storage::MemoryStorage;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::ThinkingLevel;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn setup_endpoint_observes_owning_console_without_exposing_credentials() -> TestResult {
    let (app, env_path) = router_with_env("setup_observe")?;
    // Persist the fixture through the real settings writer before observing it.
    let (status, _, _) = post(
        app.clone(),
        "/api/channels/feishu",
        serde_json::json!({"app_id": ""}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _, body) = read(
        app.clone(),
        Request::builder()
            .uri("/api/channels/feishu/setup")
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let state: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(state["configured"], false);
    assert!(state["chats"].is_array());
    assert!(!body.contains("app_secret"));
    let (status, _, _) = post(
        app,
        "/api/channels/feishu/setup",
        serde_json::json!({
            "revision": "stale", "chat_id": "oc_unseen"
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    std::fs::remove_file(env_path)?;
    Ok(())
}

struct BlockingChatProvider {
    started: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl StreamProvider for BlockingChatProvider {
    async fn stream(
        &self,
        _config: StreamConfig,
        _tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> std::result::Result<StreamOutcome, ProviderError> {
        self.started.store(true, Ordering::SeqCst);
        cancel.cancelled().await;
        self.cancelled.store(true, Ordering::SeqCst);
        Err(ProviderError::Cancelled)
    }
}

fn test_config() -> Config {
    test_config_at(std::env::temp_dir().join("console_routes_test.env"))
}

fn test_config_at(env_path: std::path::PathBuf) -> Config {
    let mut config = Config::new(std::env::temp_dir());
    config
        .providers
        .insert("anthropic".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "sk-test-key-abcd".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["claude-sonnet-4-6".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.providers.insert("deepseek".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "sk-deepseek-test".into(),
        base_url: "https://api.deepseek.com".into(),
        models: vec!["deepseek-chat".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "anthropic".into();
    config.env_file_path = env_path;
    config
}

/// A router whose saves land in their own env file, so POST tests do not
/// interfere with each other or leave shared state behind.
fn router_with_env(tag: &str) -> TestResult2<(axum::Router, std::path::PathBuf)> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("console_routes_{tag}_{nanos}.env"));
    let config = test_config_at(path.clone());
    let agent = Agent::new(&config, "/work")?;
    Ok((Server::new(agent, config).router(), path))
}

fn router() -> TestResult2<axum::Router> {
    let config = test_config();
    // `Agent::new` already hands back an Arc.
    let agent = Agent::new(&config, "/work")?;
    Ok(Server::new(agent, config).router())
}

type TestResult2<T> = std::result::Result<T, Box<dyn std::error::Error>>;

async fn get(path: &str) -> TestResult2<(StatusCode, String, String)> {
    read(router()?, Request::builder().uri(path).body(Body::empty())?).await
}

async fn post(
    app: axum::Router,
    path: &str,
    body: serde_json::Value,
) -> TestResult2<(StatusCode, String, String)> {
    read(
        app,
        Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body)?))?,
    )
    .await
}

async fn read(
    app: axum::Router,
    request: Request<Body>,
) -> TestResult2<(StatusCode, String, String)> {
    let response = app.oneshot(request).await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    Ok((status, content_type, String::from_utf8_lossy(&bytes).into()))
}

#[tokio::test]
async fn console_pages_are_served() -> TestResult {
    for path in ["/models", "/feishu", "/chat"] {
        let (status, content_type, body) = get(path).await?;
        assert_eq!(status, StatusCode::OK, "{path} should be reachable");
        assert!(
            content_type.starts_with("text/html"),
            "{path} content-type was {content_type}"
        );
        // Each page is a shell host: it must pull in the shared stylesheet and
        // its own module, or it renders unstyled and inert.
        assert!(body.contains("/ui/app.css"), "{path} missing stylesheet");
        assert!(
            body.contains("/ui/theme.css"),
            "{path} missing product palette"
        );
        assert!(
            body.contains("/ui/theme.js"),
            "{path} missing theme control"
        );
        assert!(
            body.contains("type=\"module\""),
            "{path} missing module script"
        );
    }
    Ok(())
}

#[tokio::test]
async fn console_assets_carry_executable_content_types() -> TestResult {
    // A module served as text/plain is refused by the browser, so the header is
    // as load-bearing as the body here.
    let (status, content_type, body) = get("/ui/app.css").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.starts_with("text/css"),
        "css was {content_type}"
    );
    assert!(body.contains("var(--page)"));
    assert!(body.contains("--font"));
    assert!(body.contains(".load-bar"), "missing the top refresh bar");
    assert!(
        body.contains(".sk ") || body.contains(".sk{"),
        "missing skeleton shimmer"
    );

    for path in ["/ui/app.js", "/ui/models.js", "/ui/feishu.js"] {
        let (status, content_type, body) = get(path).await?;
        assert_eq!(status, StatusCode::OK, "{path} should be reachable");
        assert!(
            content_type.starts_with("text/javascript"),
            "{path} content-type was {content_type}"
        );
        assert!(!body.is_empty(), "{path} was empty");
    }
    Ok(())
}

#[tokio::test]
async fn page_modules_only_import_served_paths() -> TestResult {
    // The pages are unbundled ES modules, so every import must resolve to a
    // route. A typo would only surface as a blank page in a browser.
    for path in [
        "/ui/app.js",
        "/ui/models.js",
        "/ui/feishu.js",
        "/ui/chat.js",
        "/ui/rail.js",
    ] {
        let (_, _, body) = get(path).await?;
        for line in body.lines().filter(|line| line.starts_with("import ")) {
            if let Some((_, suffix)) = line.split_once("from \"./") {
                let name = suffix.split('"').next().ok_or("missing module name")?;
                let url = format!("/ui/{name}");
                let (status, content_type, _) = get(&url).await?;
                assert_eq!(status, StatusCode::OK, "{path} imports missing {url}");
                assert!(
                    content_type.starts_with("text/javascript"),
                    "{url} is not executable"
                );
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn settings_url_redirects_to_models() -> TestResult {
    let response = router()?
        .oneshot(Request::builder().uri("/settings").body(Body::empty())?)
        .await?;
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok()),
        Some("/models")
    );
    Ok(())
}

#[test]
fn models_page_has_only_cloud_and_custom_sections() {
    let html = include_str!("../assets/console/ui/models.html");
    let js = include_str!("../assets/console/ui/models.js");

    // These are the only top-level concepts on the page. Global thinking is a
    // compact header control rather than a third configuration section.
    assert!(js.contains("<h2>Cloud</h2>"));
    assert!(js.contains("<h2>Custom</h2>"));
    assert_eq!(js.matches("<section class=\"model-section\">").count(), 2);
    assert!(html.contains(".cloud-list"));
    assert!(html.contains(".custom-editor"));
    assert!(js.contains("id=\"globalThinking\""));

    // Cloud entries are account-owned rows, never editor inputs or members of
    // the POST payload. Only custom providers pass through this filter.
    assert!(js.contains("const customProviders = () =>"));
    assert!(js.contains("!isCloud(provider)"));
    assert!(js.contains("providers: customProviders().map"));
    assert!(js.contains("const defaultName = () => state.active_provider || \"\";"));
    assert!(!js.contains("const defaultName = () => state.providers[0]"));
    assert!(js.contains("state.active_provider = nextName"));
    assert!(js.contains("state.active_provider === removed.name"));
    assert!(!js.contains("providerKey\" value=\""));

    // The Cloud directory groups by catalog tier through the shared label
    // helper; per-protocol provider names only ride the chip payload.
    assert!(js.contains("tierLabel(group.tier)"));
    assert!(js.contains("data-cloud-model"));
    assert!(js.contains("data-cloud-provider"));
    assert!(js.contains("active_model: pendingCloudModel"));
}

#[tokio::test]
async fn models_api_masks_secrets() -> TestResult {
    // The page renders from this payload, so a raw key here would put the secret
    // into the browser and into any HAR or devtools capture.
    let (status, content_type, body) = get("/api/models").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("application/json"));
    assert!(!body.contains("sk-test-key-abcd"), "raw api key leaked");

    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["active_provider"], "anthropic");
    let provider = &json["providers"][0];
    assert_eq!(provider["name"], "anthropic");
    assert_eq!(provider["api_key_set"], true);
    assert_eq!(provider["cloud"], false);
    assert!(
        provider["api_key_hint"]
            .as_str()
            .is_some_and(|hint| hint.starts_with("****")),
        "hint should be masked, got {:?}",
        provider["api_key_hint"]
    );
    // The page builds its selects from these, so an empty list would render a
    // form that cannot be filled in.
    assert!(json["protocols"].as_array().is_some_and(|a| !a.is_empty()));
    assert!(json["thinking_levels"]
        .as_array()
        .is_some_and(|a| !a.is_empty()));
    Ok(())
}

#[tokio::test]
async fn models_and_channel_apis_are_separate() -> TestResult {
    // The split is the point: each page fetches only its own section, so
    // neither payload should carry the other's fields.
    let (_, _, models) = get("/api/models").await?;
    let models: serde_json::Value = serde_json::from_str(&models)?;
    assert!(
        models.get("feishu").is_none(),
        "models leaked channel config"
    );

    let (status, _, channel) = get("/api/channels/feishu").await?;
    assert_eq!(status, StatusCode::OK);
    let channel: serde_json::Value = serde_json::from_str(&channel)?;
    assert!(
        channel.get("providers").is_none(),
        "channel leaked provider config"
    );
    // Unconfigured is a null channel rather than a missing key, so the page can
    // tell "not linked" from a malformed response.
    assert!(channel["feishu"].is_null());
    Ok(())
}

#[tokio::test]
async fn saving_models_leaves_the_channel_alone() -> TestResult {
    // The isolation the split exists for: the Models page sends no channel
    // fields, so a save must not clear a linked bot. Under the old combined
    // endpoint an absent `feishu` was indistinguishable from "unlink".
    let (app, env_path) = router_with_env("models_save")?;
    let (status, _, _) = post(
        app.clone(),
        "/api/channels/feishu",
        serde_json::json!({
            "app_id": "cli_app",
            "app_secret": "feishu-secret",
            "mention_only": true,
            "default_chat_id": "oc_daily_report",
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let (status, _, body) = post(
        app.clone(),
        "/api/models",
        serde_json::json!({
            "active_provider": "anthropic",
            "thinking_level": "high",
            "providers": [{
                "name": "anthropic",
                "protocol": "anthropic",
                "base_url": "https://api.anthropic.com",
                "models": ["claude-sonnet-4-6"],
                "api_key": serde_json::Value::Null,
                "thinking_level": serde_json::Value::Null,
            }],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "models save failed: {body}");

    let (_, _, channel) = read(
        app,
        Request::builder()
            .uri("/api/channels/feishu")
            .body(Body::empty())?,
    )
    .await?;
    let channel: serde_json::Value = serde_json::from_str(&channel)?;
    assert_eq!(channel["feishu"]["app_id"], "cli_app");
    assert_eq!(channel["feishu"]["app_secret_set"], true);
    assert_eq!(channel["feishu"]["default_chat_id"], "oc_daily_report");

    let written = std::fs::read_to_string(&env_path)?;
    assert!(written.contains("EVOT_CHANNEL_FEISHU_APP_ID=cli_app"));
    assert!(written.contains("EVOT_CHANNEL_FEISHU_DEFAULT_CHAT_ID=oc_daily_report"));
    assert!(written.contains("EVOT_LLM_THINKING_LEVEL=high"));
    let _ = std::fs::remove_file(&env_path);
    Ok(())
}

#[tokio::test]
async fn settings_reject_external_changes_instead_of_overwriting_new_secrets() -> TestResult {
    let (app, env_path) = router_with_env("conflict")?;
    let update = serde_json::json!({
        "app_id": "fixture-app", "app_secret": "fixture-secret", "mention_only": true,
    });
    let (status, _, body) = post(app.clone(), "/api/channels/feishu", update.clone()).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let edited =
        std::fs::read_to_string(&env_path)?.replace("fixture-secret", "externally-rotated");
    std::fs::write(&env_path, &edited)?;
    let (status, _, body) = post(app, "/api/channels/feishu", update).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("configuration changed on disk"));
    assert_eq!(std::fs::read_to_string(&env_path)?, edited);
    std::fs::remove_file(env_path)?;
    Ok(())
}

#[tokio::test]
async fn saving_the_channel_leaves_models_alone() -> TestResult {
    // The mirror case: the Feishu page sends no provider list, which must not be
    // read as "delete every provider".
    let (app, env_path) = router_with_env("channel_save")?;
    let (status, _, body) = post(
        app.clone(),
        "/api/channels/feishu",
        serde_json::json!({
            "app_id": "cli_app",
            "app_secret": "feishu-secret",
            "mention_only": false,
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "channel save failed: {body}");
    // The supervisor applies saved transport settings without restarting evot.
    let parsed: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(parsed["restart_required"], false);

    let (_, _, models) = read(
        app,
        Request::builder().uri("/api/models").body(Body::empty())?,
    )
    .await?;
    let models: serde_json::Value = serde_json::from_str(&models)?;
    assert_eq!(models["active_provider"], "anthropic");
    assert_eq!(models["providers"][0]["name"], "anthropic");
    assert_eq!(models["providers"][0]["api_key_set"], true);
    let _ = std::fs::remove_file(&env_path);
    Ok(())
}

#[tokio::test]
async fn blank_secrets_keep_the_stored_values() -> TestResult {
    // The pages send null when a secret field is left empty, since they only
    // ever receive a masked hint and could not echo the real value back.
    let (app, env_path) = router_with_env("blank_secret")?;
    post(
        app.clone(),
        "/api/channels/feishu",
        serde_json::json!({
            "app_id": "cli_app",
            "app_secret": "feishu-secret",
            "mention_only": true,
        }),
    )
    .await?;

    let (status, _, _) = post(
        app.clone(),
        "/api/channels/feishu",
        serde_json::json!({
            "app_id": "cli_app",
            "app_secret": serde_json::Value::Null,
            "mention_only": false,
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let written = std::fs::read_to_string(&env_path)?;
    assert!(
        written.contains("EVOT_CHANNEL_FEISHU_APP_SECRET=feishu-secret"),
        "blank secret cleared the stored one"
    );
    assert!(written.contains("EVOT_CHANNEL_FEISHU_MENTION_ONLY=false"));
    let _ = std::fs::remove_file(&env_path);
    Ok(())
}

#[tokio::test]
async fn an_invalid_save_is_rejected_with_a_reason() -> TestResult {
    // The page surfaces `error` verbatim, so it has to say what was wrong
    // rather than just failing the request.
    let (app, env_path) = router_with_env("invalid_save")?;
    let (status, _, body) = post(
        app,
        "/api/models",
        serde_json::json!({
            "active_provider": "ghost",
            "providers": [],
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let parsed: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(parsed["ok"], false);
    assert!(
        parsed["error"]
            .as_str()
            .is_some_and(|e| e.contains("ghost")),
        "error should name the bad provider, got {:?}",
        parsed["error"]
    );
    let _ = std::fs::remove_file(&env_path);
    Ok(())
}

/// The full catalog-default chain: cache default `max` → active_llm → the
/// options payload the composer renders. Guards against a clamp or startup
/// path silently downgrading the selection (e.g. Max → Xhigh → chip fallback).
// Holding env_lock across the requests IS the point: HOME must stay pinned
// while handlers reload config from disk.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn chat_options_current_thinking_honors_the_catalog_default() -> TestResult {
    let _guard = crate::conf_load_test::env_lock().lock().unwrap();
    let original_home = std::env::var_os("HOME");
    let env_home =
        std::env::temp_dir().join(format!("evot-chat-options-thinking-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&env_home);
    let root = env_home.join(".evotai");
    std::fs::create_dir_all(&root)?;
    std::fs::write(
        root.join("auth.json"),
        r#"{"version":1,"server_base_url":"http://localhost:8787",
            "user":{"id":"u1","name":"bo","email":"bo@test.dev"},
            "cli_token":"tok","refresh_token":"ref","models_synced_at":0}"#,
    )?;
    std::fs::write(
        root.join("models.cache.json"),
        r#"{"synced_at":1,"response":{"version":3,
          "providers":[{"name":"evot-free","protocol":"anthropic",
            "base_url":"http://localhost:8787/v1/llm","api_key":"evot.key",
            "default_model":"glm-5.3-flash","models":["glm-5.3-flash"]}],
          "models":[{"id":"glm-5.3-flash","display_name":"GLM 5.3 Flash",
            "protocol":"anthropic","tier":"base","thinking_level":"max"}],
          "notices":[]}}"#,
    )?;
    std::env::set_var("HOME", &env_home);
    let loaded = Config::load();
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let mut config = loaded?;
    config.env_file_path = std::env::temp_dir().join("chat-options-thinking.env");

    // Startup resolution itself must land on Max.
    assert_eq!(config.active_llm()?.thinking_level, ThinkingLevel::Max);

    let agent = Agent::new(&config, "/work")?;
    let app = Server::new(agent, config).router();
    let (status, _, body) = read(
        app,
        Request::builder()
            .uri("/api/chat/options")
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["current"]["thinking_level"], "max");
    assert_eq!(
        json["providers"][0]["models"][0]["thinking_levels"],
        serde_json::json!(["low", "high", "max"])
    );
    // The per-model default the composer preselects on a manual switch.
    assert_eq!(
        json["providers"][0]["models"][0]["default_thinking_level"],
        "max"
    );
    // The composer groups cloud providers by tier, same as the Models page.
    assert_eq!(json["providers"][0]["tier"], "base");
    let _ = std::fs::remove_dir_all(&env_home);
    Ok(())
}

#[tokio::test]
async fn chat_page_uses_conversation_layout_and_runtime_controls() -> TestResult {
    let (_, _, body) = get("/chat").await?;
    for id in [
        "id=\"chat\"",
        "id=\"input\"",
        "id=\"sendBtn\"",
        "id=\"commandBtn\"",
        "id=\"commandMenu\"",
        "id=\"modelSelect\"",
        "id=\"modelMenu\"",
        "id=\"thinkingSelect\"",
        "id=\"thinkingMenu\"",
        "id=\"workspaceChip\"",
        "id=\"contextMeter\"",
        "id=\"contextPanel\"",
        "id=\"statsLine\"",
        "id=\"toBottom\"",
    ] {
        assert!(body.contains(id), "chat page lost {id}");
    }
    assert!(
        body.contains("/brand/icon.png"),
        "chat page missing the tab icon"
    );
    assert!(
        body.contains("IBM+Plex+Mono"),
        "chat page should load the admin typeface"
    );
    // The shared rail renders during parsing (classic script in <head>), so
    // it is painted before first paint instead of being moved in later.
    assert!(body.contains("<evot-rail class=\"sidenav\" data-mode=\"chat\"></evot-rail>"));
    assert!(body.contains("<script src=\"/ui/rail.js\"></script>"));
    assert!(body.contains("/ui/rail.css"));
    assert!(!body.contains("/ui/chrome.js"));
    let rail = include_str!("../assets/console/ui/rail.js");
    for id in [
        "id=\"recentSessions\"",
        "id=\"newChat\"",
        "id=\"openSearch\"",
        "id=\"authBox\"",
    ] {
        assert!(rail.contains(id), "rail lost {id}");
    }
    assert!(!body.contains("class=\"sidebar-links\""));
    assert!(!body.contains("class=\"chat-brand\""));
    assert!(body.contains("class=\"composer-card\""));
    assert!(body.contains("aria-haspopup=\"listbox\""));
    assert!(body.contains("data-command=\"/clear\""));
    assert!(!body.contains("Attachments are not available yet"));
    assert!(body.contains("/ui/chat.js"), "chat page missing its module");
    assert!(body.contains("/ui/chat-theme.css"));
    assert!(
        body.contains("/ui/chat.css"),
        "chat page missing its stylesheet"
    );
    assert!(
        !body.contains("<style>"),
        "chat should not carry inline styles"
    );
    Ok(())
}

#[tokio::test]
async fn chat_assets_are_served() -> TestResult {
    let (status, content_type, theme) = get("/ui/theme.js").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/javascript"));
    assert!(theme.contains("evot-theme"));
    for path in ["/ui/theme.css", "/ui/chat-theme.css", "/ui/trace-theme.css"] {
        let (status, content_type, body) = get(path).await?;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(content_type.starts_with("text/css"));
        assert!(!body.is_empty());
    }
    let (status, content_type, transport) = get("/ui/chat-transport.js").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/javascript"));
    assert!(transport.contains("export async function streamChat"));
    assert!(!transport.contains("document."));
    let (status, content_type, control) = get("/ui/chat-control.js").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/javascript"));
    assert!(control.contains("export async function requestSteering"));
    assert!(!control.contains("document."));
    let chat = include_str!("../assets/console/ui/chat.js");
    assert!(chat.contains("import { streamChat }"));
    assert!(!chat.contains("response.body.getReader()"));
    let (status, content_type, body) = get("/ui/chat.css").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/css"), "was {content_type}");
    assert!(body.contains(".composer-card"));
    // Conversation chrome the harness layout depends on.
    assert!(body.contains(".turn-status"));
    // Spinner hugs the composer: no blank line before the input capsule.
    assert!(body.contains("margin: 6px 0 4px"));
    assert!(body.contains(".context-meter"));
    assert!(body.contains(".stats-line"));
    assert!(body.contains(".msg-action"));
    assert!(body.contains(".to-bottom"));
    // Tool rows are one collapsed line with an expandable IN/OUT body.
    assert!(body.contains(".tool-row"));
    assert!(body.contains(".tool-summary"));
    assert!(body.contains(".io-label"));
    // The hero welcome clears the floating composer band.
    assert!(body.contains(".conversation.hero .welcome { padding-bottom: 240px; }"));
    // Notices are a live ticker: full bodies, no titles, marquee on overflow.
    assert!(body.contains(".notice-banner.scroll"));
    assert!(body.contains("@keyframes notice-marquee"));
    // Ticker chunks keep inline styling: links clickable, emphasis tinted.
    assert!(body.contains(".notice-chunk a"));
    assert!(body.contains(".notice-chunk strong"));
    // Assistant markdown covers block structure, not just inline code.
    assert!(body.contains(".code-block"));
    assert!(body.contains(".table-wrap"));
    assert!(body.contains("blockquote"));
    // Queued steering has its own bubble state until the run admits it.
    assert!(body.contains("data-pending-steering"));
    // Search results show match context, not just titles.
    assert!(body.contains(".search-snippet"));
    assert!(body.contains(".seat-menu"));
    assert!(body.contains(".seat-group-title"));
    assert!(body.contains("mark {"));
    let (status, content_type, rail) = get("/ui/rail.css").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/css"), "was {content_type}");
    assert!(rail.contains(".chat-sidebar"));
    // Scroll-triggered page loading shows an in-list indicator, not a freeze.
    assert!(rail.contains(".recent-more"));

    let (status, content_type, body) = get("/ui/chat.js").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.starts_with("text/javascript"),
        "was {content_type}"
    );
    assert!(body.contains("/api/chat/options"));
    assert!(body.contains("chooseModel"));
    assert!(body.contains("paintModelMenu"));
    // New never pre-creates a draft: the welcome hero returns and the first
    // message creates the session, carrying the chosen workspace cwd.
    assert!(!body.contains("/api/chat/new"));
    assert!(body.contains("payload.cwd = workspace.cwd"));
    // Notices ride the live ticker: title + body as markdown, polled live.
    assert!(body.contains("notice.body"));
    assert!(body.contains("notice.title"));
    assert!(body.contains("flattenNoticeHtml"));
    // Flattening drops structural tags but keeps inline styling alive.
    assert!(body.contains("blockquote|pre|div|table"));
    assert!(body.contains("NOTICE_POLL_MS"));
    assert!(body.contains("visibilitychange"));
    assert!(body.contains("/api/chat/abort"));
    assert!(control.contains("/api/chat/steer"));
    assert!(body.contains("requestSteering(postJson, sessionId, text)"));
    assert!(body.contains("/api/workspace"));
    assert!(body.contains("/api/sessions/"));
    // Sidebar sessions: full-text search plus armed two-step delete.
    assert!(body.contains("/api/sessions/delete"));
    assert!(body.contains("loadRecentPage"));
    assert!(
        body.contains("recentRows"),
        "paged refreshes must reconcile rows in place"
    );
    assert!(body.contains("/api/sessions?full=true"));
    assert!(body.contains("armDestructive"));
    assert!(body.contains("onSearchKeydown"));
    assert!(body.contains("snippetAround"));
    assert!(body.contains("Stop generating"));
    let (status, content_type, state) = get("/ui/chat-state.js").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/javascript"));
    assert!(state.contains("new AbortController()"));
    assert!(!state.contains("document."));
    let (status, content_type, stream_state) = get("/ui/chat-stream-state.js").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/javascript"));
    assert!(stream_state.contains("class ChatStreamState"));
    assert!(body.contains("runtime.begin(currentSessionId)"));
    assert!(body.contains("requestAnimationFrame"));
    assert!(body.contains("followOutput = isNearBottom()"));
    assert!(body.contains("thinking_level: thinkingLevel"));
    assert!(body.contains("node.type === \"session\""));
    assert!(body.contains("kind === \"thinking\""));
    assert!(body.contains("payload.cwd = workspace.cwd"));
    // Manual model switches preselect the model's catalog default, not tier 0.
    assert!(body.contains("entry?.default_thinking_level"));
    // Turn chrome: copy/clock actions, running status, and session readings.
    assert!(body.contains("navigator.clipboard.writeText"));
    assert!(body.contains("Ran for "));
    assert!(body.contains("tok/s"));
    assert!(body.contains("showTurnStatus()"));
    assert!(body.contains("renderContextMeter"));
    assert!(body.contains("detail.stats"));
    // Tool rows classify on the engine's lowercase wire names.
    assert!(body.contains("web_fetch: \"read\""));
    assert!(body.contains("toolRowModel"));
    assert!(body.contains("assistant.toolFacts"));
    // Markdown links are restricted to web/mail schemes.
    assert!(body.contains("function safeHref"));
    assert!(body.contains("mailto:"));
    // Mid-run Enter queues onto the active turn instead of dropping the text.
    assert!(body.contains("async function steerRun"));
    assert!(body.contains("appendPendingSteering"));
    assert!(body.contains("settleAllPendingSteering"));
    assert!(body.contains("abandonPendingSteering"));
    Ok(())
}

#[tokio::test]
async fn chat_abort_is_validated_and_idempotent() -> TestResult {
    let app = router()?;
    let (status, _, body) = post(
        app.clone(),
        "/api/chat/abort",
        serde_json::json!({ "session_id": "" }),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body)?["ok"],
        false
    );

    let (status, _, body) = post(
        app,
        "/api/chat/abort",
        serde_json::json!({ "session_id": "not-running" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["ok"], true);
    assert_eq!(json["active"], false);
    Ok(())
}

#[tokio::test]
async fn chat_steer_is_validated_and_reports_no_active_run() -> TestResult {
    let app = router()?;
    for payload in [
        serde_json::json!({ "session_id": "", "message": "hi" }),
        serde_json::json!({ "session_id": "sess-1", "message": "   " }),
        serde_json::json!({ "session_id": "sess-1", "message": "/compact" }),
        serde_json::json!({ "session_id": "sess-1", "message": "/unknown" }),
    ] {
        let (status, _, body) = post(app.clone(), "/api/chat/steer", payload).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body)?["ok"],
            false
        );
    }

    // No run in flight: the browser is told so and sends a normal turn instead.
    let (status, _, body) = post(
        app,
        "/api/chat/steer",
        serde_json::json!({ "session_id": "not-running", "message": "hi" }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["ok"], true);
    assert_eq!(json["active"], false);
    Ok(())
}

#[tokio::test]
async fn chat_abort_stops_an_active_http_run() -> TestResult {
    let config = test_config();
    let started = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let agent = Agent::new_with_provider_for_test(
        &config,
        "/work",
        Arc::new(MemoryStorage::new()),
        BlockingChatProvider {
            started: Arc::clone(&started),
            cancelled: Arc::clone(&cancelled),
        },
    )?;
    let session = agent.create_session("http").await?;
    let app = Server::new(Arc::clone(&agent), config).router();

    // Keep the SSE response alive without consuming it. This ensures the run
    // can only be cancelled by the explicit abort route, not receiver drop.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&serde_json::json!({
                    "message": "wait until stopped",
                    "session_id": session.session_id,
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-6"
                }))?))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    tokio::time::timeout(Duration::from_secs(3), async {
        while !started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert!(agent.has_active_run(&session.session_id));

    let (status, _, body) = post(
        app,
        "/api/chat/abort",
        serde_json::json!({ "session_id": session.session_id }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["active"], true);

    tokio::time::timeout(Duration::from_secs(3), async {
        while !cancelled.load(Ordering::SeqCst) || agent.has_active_run(&session.session_id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    drop(response);
    Ok(())
}

#[tokio::test]
async fn chat_options_expose_the_live_configured_model() -> TestResult {
    let (status, content_type, body) = get("/api/chat/options").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("application/json"));
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["current"]["provider"], "anthropic");
    assert_eq!(json["current"]["model"], "claude-sonnet-4-6");
    assert_eq!(json["providers"][0]["name"], "anthropic");
    assert_eq!(json["providers"][0]["models"][0]["id"], "claude-sonnet-4-6");
    assert!(
        json["providers"][0]["models"][0]["thinking_levels"]
            .as_array()
            .is_some_and(|levels| !levels.is_empty()),
        "configured reasoning model should expose its resolved thinking levels"
    );
    let deepseek = json["providers"]
        .as_array()
        .and_then(|providers| {
            providers
                .iter()
                .find(|provider| provider["name"] == "deepseek")
        })
        .ok_or("deepseek missing from chat options")?;
    assert_eq!(deepseek["models"][0]["id"], "deepseek-chat");
    assert_eq!(
        deepseek["models"][0]["thinking_levels"],
        serde_json::json!([])
    );
    Ok(())
}

#[tokio::test]
async fn chat_rejects_unconfigured_runtime_selections_before_starting() -> TestResult {
    let cases = [
        (
            serde_json::json!({ "message": "hello", "provider": "anthropic" }),
            "chat model selection requires both provider and model",
        ),
        (
            serde_json::json!({ "message": "hello", "model": "claude-sonnet-4-6" }),
            "chat model selection requires both provider and model",
        ),
        (
            serde_json::json!({
                "message": "hello",
                "provider": "ghost",
                "model": "claude-sonnet-4-6"
            }),
            "provider 'ghost' is not configured",
        ),
        (
            serde_json::json!({
                "message": "hello",
                "provider": "anthropic",
                "model": "ghost-model"
            }),
            "model 'ghost-model' is not configured",
        ),
        (
            serde_json::json!({
                "message": "hello",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "thinking_level": "invalid"
            }),
            "unknown thinking level",
        ),
        (
            serde_json::json!({
                "message": "hello",
                "provider": "deepseek",
                "model": "deepseek-chat",
                "thinking_level": "high"
            }),
            "thinking level 'high' is not supported",
        ),
    ];

    for (payload, expected) in cases {
        let config = test_config();
        let storage = Arc::new(MemoryStorage::new());
        let agent = Agent::new_with_provider_for_test(
            &config,
            "/work",
            storage.clone(),
            evot_engine::provider::MockProvider::text("unexpected run"),
        )?;
        let before = agent.llm();
        let app = Server::new(agent.clone(), config).router();
        let (status, content_type, body) = post(app, "/api/chat", payload).await?;
        // SSE endpoints keep HTTP 200 and carry run/setup failures as events.
        assert_eq!(status, StatusCode::OK);
        assert!(content_type.starts_with("text/event-stream"));
        assert!(
            body.contains("\"type\":\"error\""),
            "missing SSE error: {body}"
        );
        assert!(body.contains(expected), "expected {expected:?} in {body}");
        assert!(
            body.contains("\"type\":\"done\""),
            "stream did not close: {body}"
        );
        assert_eq!(agent.llm().provider, before.provider);
        assert_eq!(agent.llm().model, before.model);
        assert_eq!(agent.llm().thinking_level, before.thinking_level);
        assert!(agent.sessions().list(0).await?.is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn chat_selection_pins_session_effort_and_keeps_legacy_omission_semantics() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mut config = test_config_at(dir.path().join("not-written.env"));
    config.storage = evot::conf::StorageConfig::fs(dir.path().to_path_buf());
    let agent = Agent::new_with_provider_for_test(
        &config,
        dir.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        evot_engine::provider::MockProvider::text("ok"),
    )?;
    let app = Server::new(agent.clone(), config.clone()).router();
    for payload in [
        serde_json::json!({
            "message": "hello", "provider": "anthropic", "model": "claude-sonnet-4-6", "thinking_level": "low",
        }),
        // Historical requests with no provider/model use the live snapshot and
        // ignore a standalone thinking field, even one that would be invalid.
        serde_json::json!({ "message": "again", "thinking_level": "invalid" }),
    ] {
        let (status, content_type, body) = post(app.clone(), "/api/chat", payload).await?;
        assert_eq!(status, StatusCode::OK);
        assert!(content_type.starts_with("text/event-stream"));
        assert!(
            !body.contains("\"type\":\"error\""),
            "unexpected SSE error: {body}"
        );
        assert_eq!(agent.llm().thinking_level, ThinkingLevel::Low);
    }
    let sessions = agent.sessions().list(0).await?;
    assert_eq!(sessions.len(), 2);
    for session in sessions {
        assert_eq!(session.model, "claude-sonnet-4-6");
        assert_eq!(session.thinking_level.as_deref(), Some("low"));
    }
    assert!(
        !config.env_file_path.exists(),
        "runtime selection must not persist defaults"
    );
    Ok(())
}

#[tokio::test]
async fn root_redirects_to_chat_and_the_list_page_is_gone() -> TestResult {
    // Chat is the console's front door. Old bookmarks land there; the
    // standalone sessions list page is gone with its asset, while the
    // per-session trace viewer stays reachable.
    for path in ["/", "/sessions"] {
        let response = router()?
            .oneshot(Request::builder().uri(path).body(Body::empty())?)
            .await?;
        assert_eq!(response.status(), StatusCode::SEE_OTHER, "{path}");
        assert_eq!(
            response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok()),
            Some("/chat"),
            "{path}"
        );
    }

    let (gone, _, _) = get("/ui/sessions.js").await?;
    assert_eq!(gone, StatusCode::NOT_FOUND);

    let (status, content_type, body) = get("/sessions/abc123/trace").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/html"), "was {content_type}");
    assert!(body.contains("Back to chat"), "trace lost its way home");
    Ok(())
}

#[tokio::test]
async fn the_spa_bundle_is_gone() -> TestResult {
    // The bundle and its live sockets were only consumed by the deleted SPA.
    // Leaving the routes behind would keep 1.8MB of assets in the binary.
    for path in ["/assets/index.js", "/assets/index.css", "/assets/logo.svg"] {
        let (status, _, _) = get(path).await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} should be gone");
    }
    Ok(())
}

#[tokio::test]
async fn trace_page_joins_the_console_shell() -> TestResult {
    // Reachable at both paths the session cards and old links use.
    for path in ["/sessions/abc123", "/sessions/abc123/trace"] {
        let (status, content_type, body) = get(path).await?;
        assert_eq!(status, StatusCode::OK, "{path} should be reachable");
        assert!(
            content_type.starts_with("text/html"),
            "{path} was {content_type}"
        );
        assert!(
            body.contains("/ui/app.css"),
            "{path} missing the shell styles"
        );
        assert!(
            body.contains("<evot-rail class=\"sidenav\"></evot-rail>"),
            "{path} missing the shared rail"
        );
        assert!(body.contains("/ui/rail.js"), "{path} missing rail.js");
    }
    let (_, _, body) = get("/sessions/abc123/trace").await?;
    assert!(body.contains("/ui/theme.css"));
    assert!(body.contains("/ui/theme.js"));
    assert!(body.contains("/ui/trace-theme.css"));
    // The page scrolls normally rather than filling the viewport like chat.
    assert!(body.contains("<div class=\"shell\">"));
    // The iframe height protocol existed only for the SPA shell.
    assert!(
        !body.contains("postHeight"),
        "trace still reports iframe height"
    );
    assert!(
        !body.contains("postMessage"),
        "trace still posts to a parent frame"
    );
    Ok(())
}

/// The Models page renders the Cloud section from `cloud_tiers` (never the
/// per-protocol provider names). Catalog rank picks the serving model, and a
/// chip pins one explicitly.
// Same as above: the lock must survive every awaited request, since GET
/// /api/models re-reads the real home directory.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn models_api_groups_cloud_by_tier_and_chip_pins_a_model() -> TestResult {
    let _guard = crate::conf_load_test::env_lock().lock().unwrap();
    let original_home = std::env::var_os("HOME");
    let env_home =
        std::env::temp_dir().join(format!("evot-models-tier-grouping-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&env_home);
    let root = env_home.join(".evotai");
    std::fs::create_dir_all(&root)?;
    std::fs::write(
        root.join("auth.json"),
        r#"{"version":1,"server_base_url":"http://localhost:8787",
            "user":{"id":"u1","name":"bo","email":"bo@test.dev"},
            "cli_token":"tok","refresh_token":"ref","models_synced_at":0}"#,
    )?;
    // Two tiers worth of data: base hosts two models under one provider, and
    // the server default is NOT the model a chip would pick.
    std::fs::write(
        root.join("models.cache.json"),
        r#"{"synced_at":1,"response":{"version":3,
          "providers":[{"name":"evot-free","protocol":"anthropic",
            "base_url":"http://localhost:8787/v1/llm","api_key":"evot.key",
            "default_model":"gpt-5.6-luna",
            "models":["gpt-5.6-luna","glm-5.3-flash"]}],
          "models":[
            {"id":"gpt-5.6-luna","display_name":"Luna","protocol":"anthropic","tier":"base",
             "sort_order":1},
            {"id":"glm-5.3-flash","display_name":"GLM 5.3 Flash","protocol":"anthropic","tier":"base",
             "thinking_level":"max","sort_order":5}],
          "notices":[]}}"#,
    )?;
    std::env::set_var("HOME", &env_home);
    // HOME stays pointed at the hermetic home until every assertion lands:
    // GET /api/models reloads config from disk and would otherwise re-read
    // the real account cache and overwrite the cloud providers.
    // Keep the env file inside the hermetic home: settings writes are a
    // transaction against the revision loaded from disk, so pointing the path
    // elsewhere makes the first POST look like a concurrent edit and fail.
    let config = Config::load()?;

    let agent = Agent::new(&config, "/work")?;
    let app = Server::new(agent, config).router();

    let (status, _, body) = read(
        app.clone(),
        Request::builder().uri("/api/models").body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let snapshot: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(snapshot["active_provider"], "evot-free");
    assert_eq!(snapshot["cloud_tiers"].as_array().map(Vec::len), Some(1));
    let group = &snapshot["cloud_tiers"][0];
    assert_eq!(group["tier"], "base");
    // Rank decides both the order and the serving model: glm's 5 beats luna's
    // 1, so it shows first and is active even though luna is `default_model`.
    assert_eq!(group["models"][0]["id"], "glm-5.3-flash");
    assert_eq!(group["models"][0]["provider"], "evot-free");
    assert_eq!(group["models"][0]["active"], true);
    assert_eq!(group["models"][1]["id"], "gpt-5.6-luna");
    assert_eq!(group["models"][1]["active"], false);

    // A chip pins a lower-ranked model; the order it renders in is unchanged.
    let (status, _, body) = post(
        app,
        "/api/models",
        serde_json::json!({
            "active_provider": "evot-free",
            "active_model": "gpt-5.6-luna",
            "providers": []
        }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let updated: serde_json::Value = serde_json::from_str(&body)?;
    let group = &updated["models"]["cloud_tiers"][0];
    assert_eq!(group["models"][0]["id"], "glm-5.3-flash");
    assert_eq!(group["models"][0]["active"], false);
    assert_eq!(group["models"][1]["id"], "gpt-5.6-luna");
    assert_eq!(group["models"][1]["active"], true);

    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let _ = std::fs::remove_dir_all(&env_home);
    Ok(())
}

/// A Premium account's New-chat lands on a `special` model even if the
/// leftover live selection was Free. Existing sessions keep their own stamp.
#[tokio::test]
async fn chat_new_prefers_premium_when_the_account_has_it() -> TestResult {
    let mut config = test_config();
    config
        .providers
        .insert("evot-free".into(), ProviderProfile {
            protocol: Protocol::Anthropic,
            api_key: "evot.key".into(),
            base_url: "https://api.anthropic.com".into(),
            models: vec!["gpt-5.6-luna".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.providers.insert("evot-pro".into(), ProviderProfile {
        protocol: Protocol::Anthropic,
        api_key: "evot.key".into(),
        base_url: "https://api.anthropic.com".into(),
        models: vec!["claude-opus-5".into(), "glm-5.3-flash".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.cloud_providers.insert("evot-free".into());
    config.cloud_providers.insert("evot-pro".into());
    config
        .cloud_model_tiers
        .insert("gpt-5.6-luna".into(), "base".into());
    config
        .cloud_model_tiers
        .insert("claude-opus-5".into(), "special".into());
    config
        .cloud_model_tiers
        .insert("glm-5.3-flash".into(), "special".into());
    // Leftover Free selection from the previous session.
    config.llm.provider = "evot-free".into();

    let agent = Agent::new(&config, "/work")?;
    let app = Server::new(agent, config).router();
    let (status, _, body) = post(app, "/api/chat/new", serde_json::json!({})).await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["provider"], "evot-pro");
    assert_eq!(json["model"], "claude-opus-5");
    Ok(())
}

/// New-chat commits a blank session up front: the response carries the id the
/// composer then owns, an optional workspace binds at creation, and bad paths
/// are rejected before any session lands.
#[tokio::test]
async fn chat_new_creates_bound_blank_sessions() -> TestResult {
    let app = router()?;
    let (status, _, body) = post(app.clone(), "/api/chat/new", serde_json::json!({})).await?;
    assert_eq!(status, StatusCode::OK);
    let first: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(first["cwd"], "/work");
    let first_id = first["session_id"]
        .as_str()
        .ok_or("missing session_id")?
        .to_string();

    let (status, _, body) = post(app.clone(), "/api/chat/new", serde_json::json!({})).await?;
    assert_eq!(status, StatusCode::OK);
    let second: serde_json::Value = serde_json::from_str(&body)?;
    let second_id = second["session_id"].as_str().ok_or("missing session_id")?;
    assert_ne!(first_id, second_id);

    // An explicit workspace binds at creation and survives a reload.
    let dir = std::env::temp_dir().join(format!("evot-chat-new-ws-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let (status, _, body) = post(
        app.clone(),
        "/api/chat/new",
        serde_json::json!({ "cwd": dir.to_string_lossy() }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let bound: serde_json::Value = serde_json::from_str(&body)?;
    let expected = std::fs::canonicalize(&dir)?.to_string_lossy().into_owned();
    assert_eq!(bound["cwd"], expected);
    let _ = std::fs::remove_dir_all(&dir);

    // Unusable directories are refused before a session is created.
    let (status, _, body) = post(
        app,
        "/api/chat/new",
        serde_json::json!({ "cwd": "/definitely-not-a-real-evot-dir" }),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body)?["ok"],
        false
    );
    Ok(())
}

/// The sidebar pages lightweight rows, and New-chat drafts (zero turns)
/// never appear in any listing — resume-by-id still reaches them.
#[tokio::test]
async fn sessions_api_pages_lightweight_rows() -> TestResult {
    let config = test_config();
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let agent = Agent::new_with_provider_for_test(
        &config,
        "/work",
        storage.clone(),
        BlockingChatProvider {
            started: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
        },
    )?;
    let app = Server::new(agent, config).router();

    // New-chat drafts are persisted for the composer but stay out of lists.
    for _ in 0..3 {
        let (status, _, _) = post(app.clone(), "/api/chat/new", serde_json::json!({})).await?;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, _, body) = read(
        app.clone(),
        Request::builder()
            .uri("/api/sessions?limit=10&offset=0")
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let empty: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(empty["items"].as_array().map(Vec::len), Some(0));

    // A conversation with durable transcript activity shows up without
    // waiting for the final turns/title metadata save.
    let session = evot::sessions::Session::new(
        "seed-visible".into(),
        "/work".into(),
        "claude-sonnet-4-6".into(),
        storage.clone(),
    )
    .await?;
    session
        .write_items(vec![evot::types::TranscriptItem::User {
            provenance: None,
            text: "seed the listing".into(),
            content: vec![],
        }])
        .await?;
    // Transcript persistence can win the race with the final metadata save.
    // The row must already be visible while turns/title retain draft values.
    let meta = session.meta().await;
    assert_eq!(meta.turns, 0);
    assert!(meta.title.is_none());

    // A later New-chat click invalidates the snapshot cache, exactly what a
    // real session finishing does for the running console.
    let (status, _, _) = post(app.clone(), "/api/chat/new", serde_json::json!({})).await?;
    assert_eq!(status, StatusCode::OK);

    let (status, _, body) = read(
        app.clone(),
        Request::builder()
            .uri("/api/sessions?limit=10&offset=0")
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let page: serde_json::Value = serde_json::from_str(&body)?;
    let items = page["items"].as_array().ok_or("missing items")?;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["session_id"], "seed-visible");
    assert_eq!(items[0]["turns"], 0);
    assert!(items[0]["title"].is_null());
    assert!(items[0].get("search_text").is_none());

    // The full index carries text for the visible row only.
    let (status, _, body) = read(
        app,
        Request::builder()
            .uri("/api/sessions?full=true")
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let full: serde_json::Value = serde_json::from_str(&body)?;
    let items = full["items"].as_array().ok_or("missing full items")?;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["session_id"], "seed-visible");
    assert!(items[0].get("search_text").is_some());
    Ok(())
}

#[tokio::test]
async fn workspace_api_validates_directories() -> TestResult {
    let (status, _, body) = get("/api/workspace").await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["cwd"], "/work");
    assert_eq!(json["label"], "work");

    let (status, _, body) = post(
        router()?,
        "/api/workspace",
        serde_json::json!({ "path": "/definitely-not-a-real-evot-dir" }),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["ok"], false);
    Ok(())
}

#[tokio::test]
async fn session_detail_replays_transcript_nodes() -> TestResult {
    let config = test_config();
    let agent = Agent::new_with_provider_for_test(
        &config,
        "/work",
        Arc::new(MemoryStorage::new()),
        evot_engine::provider::MockProvider::text("ok"),
    )?;
    let session = agent.create_session("http").await?;
    let loaded = agent
        .load_session(&session.session_id)
        .await?
        .ok_or("missing session")?;
    loaded
        .write_items(vec![
            evot::types::TranscriptItem::User {
                provenance: None,
                text: "hello".into(),
                content: vec![],
            },
            evot::types::TranscriptItem::Assistant {
                content: vec![
                    evot::types::AssistantBlock::Thinking {
                        text: "plan".into(),
                        metadata: None,
                    },
                    evot::types::AssistantBlock::Text {
                        text: "done".into(),
                    },
                ],
                stop_reason: "stop".into(),
                usage: evot::observability::UsageSummary::default(),
                model: "claude-sonnet-4-6".into(),
                provider: "anthropic".into(),
                timestamp: 1_700_000_000_000,
                error_message: None,
            },
            // Stats never replay as nodes, so the readings must be folded
            // server-side from the raw entries instead.
            evot::observability::TranscriptStats::LlmCallCompleted(
                evot::observability::LlmCallCompletedStats {
                    turn: 1,
                    attempt: 1,
                    usage: evot::observability::UsageSummary {
                        input: 900,
                        output: 300,
                        cache_read: 100,
                        cache_write: 0,
                    },
                    metrics: Some(evot::observability::LlmCallMetrics {
                        duration_ms: 4_000,
                        ttfb_ms: 200,
                        ttft_ms: 400,
                        streaming_ms: 3_000,
                        chunk_count: 42,
                    }),
                    error: None,
                    context_window: 10_000,
                    stop_reason: "stop".into(),
                },
            )
            .to_item(),
            evot::observability::TranscriptStats::ToolFinished(
                evot::observability::ToolFinishedStats {
                    tool_call_id: "tc-1".into(),
                    tool_name: "read".into(),
                    result_tokens: 12,
                    duration_ms: 80,
                    is_error: false,
                },
            )
            .to_item(),
        ])
        .await?;
    let app = Server::new(agent, config).router();
    let (status, _, body) = read(
        app,
        Request::builder()
            .uri(format!("/api/sessions/{}", session.session_id))
            .body(Body::empty())?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body)?;
    assert_eq!(json["session"]["cwd"], "/work");
    assert_eq!(json["nodes"][0]["type"], "user");
    assert_eq!(json["nodes"][0]["text"], "hello");
    assert_eq!(json["nodes"][1]["type"], "assistant");
    assert_eq!(json["nodes"][1]["blocks"][0]["kind"], "thinking");
    assert_eq!(json["nodes"][1]["blocks"][1]["kind"], "text");
    // The message clock survives replay.
    assert_eq!(json["nodes"][1]["time"], 1_700_000_000_000u64);
    assert_eq!(json["nodes"][1]["model"], "claude-sonnet-4-6");
    // Session readings folded from the Stats entries.
    assert_eq!(json["stats"]["steps"], 1);
    assert_eq!(json["stats"]["turns"], 1);
    assert_eq!(json["stats"]["llm_ms"], 4_000);
    assert_eq!(json["stats"]["tool_ms"], 80);
    assert_eq!(json["stats"]["ttft_steps"], 1);
    assert_eq!(json["stats"]["decode_tokens"], 300);
    assert_eq!(json["stats"]["usage"]["input"], 900);
    assert_eq!(json["stats"]["context"]["percent"], 13);
    Ok(())
}

/// The account endpoints under a fake HOME: signed out by default, logout is
/// idempotent, and the notices slot stays empty without a synced catalog.
// Holding env_lock across the awaits IS the point: auth.json reads/writes
// and HOME must stay pinned for the whole request run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn auth_endpoints_report_signed_out_state() -> TestResult {
    let _guard = crate::conf_load_test::env_lock().lock().unwrap();
    let original_home = std::env::var_os("HOME");
    let env_home = std::env::temp_dir().join(format!("evot-console-auth-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&env_home);
    std::fs::create_dir_all(env_home.join(".evotai"))?;
    std::env::set_var("HOME", &env_home);
    // HOME must survive every awaited request: the endpoints read auth.json.
    let result = async {
        let (status, _, body) = get("/api/auth/session").await?;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body)?;
        assert_eq!(json["logged_in"], false);

        let (status, _, body) = get("/api/notices").await?;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body)?;
        assert_eq!(json["items"].as_array().map(Vec::len), Some(0));

        let (status, _, body) =
            post(app_for_auth()?, "/api/auth/logout", serde_json::json!({})).await?;
        assert_eq!(status, StatusCode::OK, "logout body: {body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body)?["ok"],
            true
        );

        let (status, _, body) = get("/api/auth/session").await?;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body)?;
        assert_eq!(json["logged_in"], false);
        Ok(())
    }
    .await;
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let _ = std::fs::remove_dir_all(&env_home);
    result
}

/// A router whose env file stays out of the shared default path.
fn app_for_auth() -> TestResult2<axum::Router> {
    let path = std::env::temp_dir().join(format!("console_auth_{}.env", std::process::id()));
    let config = test_config_at(path);
    let agent = Agent::new(&config, "/work")?;
    Ok(Server::new(agent, config).router())
}
