//! Exercises the console's HTTP surface against the real router: the page
//! documents, their static assets, and the split models/channel APIs.
//!
//! These run through `Server::router`, so a route that is declared but not
//! reachable (or an asset served with the wrong content type, which a browser
//! silently refuses to execute as a module) fails here rather than in a browser.

use axum::body::Body;
use axum::http::Request;
use axum::http::StatusCode;
use evot::agent::Agent;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::surface::gateway::channels::http::Server;
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
    for path in ["/models", "/feishu"] {
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
    let html = include_str!("../../assets/console/ui/models.html");
    let js = include_str!("../../assets/console/ui/models.js");

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

#[tokio::test]
async fn root_redirects_to_models_and_the_chat_is_gone() -> TestResult {
    // The console is settings only: conversations live in the TUI and /remote.
    // Its chat page, session list and their APIs are gone; the trace viewer stays.
    let response = router()?
        .oneshot(Request::builder().uri("/").body(Body::empty())?)
        .await?;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok()),
        Some("/models")
    );
    for path in [
        "/chat",
        "/sessions",
        "/ui/chat.js",
        "/ui/chat.css",
        "/ui/sessions.js",
        "/api/chat/options",
        "/api/sessions",
        "/api/auth/session",
        "/api/notices",
        "/api/workspace",
    ] {
        let (status, _, _) = get(path).await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} should be gone");
    }

    let (status, content_type, body) = get("/sessions/abc123/trace").await?;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/html"), "was {content_type}");
    assert!(!body.contains("/chat"), "trace links to the removed chat");
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
// Holding env_lock across the awaits is the point: GET /api/models re-reads
// the home directory, so HOME must stay pinned for every request.
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
