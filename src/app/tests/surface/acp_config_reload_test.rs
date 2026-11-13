//! A long-lived ACP process must follow catalog and login changes that other
//! evot processes write to disk, instead of rejecting models its startup
//! snapshot lacked until the client restarts it.

use std::path::Path;

use evot::agent::ToolMode;
use evot::conf::Config;
use evot_engine::provider::MockProvider;
use serde_json::json;
use serde_json::Value;
use tempfile::TempDir;

use super::acp_test::Client;
use super::acp_test::TestResult;
use crate::conf_load_test::env_lock;

const AUTH: &str = r#"{"version":1,"server_base_url":"http://127.0.0.1:1",
  "user":{"id":"u1","name":"User","email":"user@example.test"},
  "cli_token":"token","refresh_token":"refresh","models_synced_at":0}"#;

fn catalog(group: &str, models: &[&str]) -> Value {
    json!({
        "schema_version": 1,
        "synced_at": 1,
        "response": {
            "version": 7,
            "default_model": "",
            "providers": [{
                "name": group, "label": group, "sort_order": 0,
                "protocol": "anthropic", "base_url": "http://127.0.0.1:1/v1/llm",
                "api_key": "evot.fixture.key", "default_model": models[0],
                "models": models,
            }],
            "models": models.iter().map(|id| json!({
                "id": id, "protocol": "anthropic", "tier": "special", "provider": group,
            })).collect::<Vec<_>>(),
            "notices": [],
        }
    })
}

fn write_catalog(root: &Path, group: &str, models: &[&str]) -> TestResult {
    write_catalog_value(root, &catalog(group, models))
}

fn write_catalog_value(root: &Path, value: &Value) -> TestResult {
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    temporary.write_all(&serde_json::to_vec(value)?)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(root.join("models.cache.json"))?;
    Ok(())
}

fn choices(response: &Value) -> Vec<String> {
    response["result"]["configOptions"][0]["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| option["value"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn select(
    client: &mut Client,
    session_id: &str,
    spec: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    let (response, _) = client
        .request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "model", "value": spec}),
        )
        .await?;
    Ok(response)
}

async fn new_session(
    client: &mut Client,
    cwd: &Path,
) -> Result<(String, Value), Box<dyn std::error::Error>> {
    let (response, _) = client
        .request("session/new", json!({"cwd": cwd, "mcpServers": []}))
        .await?;
    let session_id = response["result"]["sessionId"]
        .as_str()
        .ok_or("sessionId")?
        .to_string();
    Ok((session_id, response))
}

// HOME must stay pinned while the server reloads config from disk.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn acp_follows_catalog_changes_without_restart() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let original_home = std::env::var_os("HOME");
    let home = TempDir::new()?;
    std::env::set_var("HOME", home.path());

    let result = async {
        let root = home.path().join(".evotai");
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join("auth.json"), AUTH)?;
        // Startup snapshot: the catalog briefly publishes no `evot-pro`
        // group (account tier or catalog reshuffle), so evot cannot resolve
        // `evot-pro:evot-fast`. evot rejects an unknown provider, not an
        // unlisted model under a known one.
        write_catalog(&root, "evot-free", &["claude-opus-5.5"])?;
        let config = Config::load()?;
        assert!(!config.providers.contains_key("evot-pro"));

        let workspace = TempDir::new()?;
        let (mut client, agent) = Client::start_config(
            &workspace,
            config,
            ToolMode::Chat,
            false,
            MockProvider::text("ok"),
        )?;
        let (session_id, _) = new_session(&mut client, workspace.path()).await?;

        // What T3 reports as "The agent did not accept the model".
        let rejected = select(&mut client, &session_id, "evot-pro:evot-fast").await?;
        assert_eq!(rejected["error"]["code"], -32602, "{rejected}");

        // Another evot process (REPL catalog sync, login, key recovery)
        // refreshes the cache while this ACP process keeps running.
        write_catalog(&root, "evot-pro", &["claude-opus-5.5", "evot-fast"])?;

        let accepted = select(&mut client, &session_id, "evot-pro:evot-fast").await?;
        assert_eq!(
            accepted["result"]["configOptions"][0]["currentValue"], "evot-pro:evot-fast",
            "{accepted}"
        );
        let (_, fresh) = new_session(&mut client, workspace.path()).await?;
        assert!(
            choices(&fresh)
                .iter()
                .any(|value| value == "evot-pro:evot-fast"),
            "{fresh}"
        );

        // A group the catalog drops is rejected again, on the same process.
        write_catalog(&root, "evot-free", &["claude-opus-5.5"])?;
        let removed = select(&mut client, &session_id, "evot-pro:evot-fast").await?;
        assert_eq!(removed["error"]["code"], -32602, "{removed}");
        // The live agent selection follows the shared reload rule onto the
        // group that still serves its model.
        assert_eq!(agent.llm().provider, "evot-free");
        assert_eq!(agent.llm().model, "claude-opus-5.5");

        // A broken cache keeps the last good config instead of failing requests.
        std::fs::write(root.join("models.cache.json"), "{not json")?;
        let kept = select(&mut client, &session_id, "evot-free:claude-opus-5.5").await?;
        assert_eq!(
            kept["result"]["configOptions"][0]["currentValue"], "evot-free:claude-opus-5.5",
            "{kept}"
        );

        client.close().await
    }
    .await;

    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    result
}

struct ReviewHome {
    original: Option<std::ffi::OsString>,
    directory: TempDir,
}

impl ReviewHome {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let original = std::env::var_os("HOME");
        let directory = TempDir::new()?;
        std::env::set_var("HOME", directory.path());
        let result = Self {
            original,
            directory,
        };
        let root = result.root();
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join("auth.json"), AUTH)?;
        Ok(result)
    }

    fn root(&self) -> std::path::PathBuf {
        self.directory.path().join(".evotai")
    }
}

impl Drop for ReviewHome {
    fn drop(&mut self) {
        match &self.original {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
    }
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn review_catalog_changed_between_config_load_and_server_start_is_not_lost() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let home = ReviewHome::new()?;
    write_catalog(&home.root(), "evot-free", &["claude-opus-5.5"])?;
    let config = Config::load()?;

    // Catalog refresh races the async agent bootstrap between Config::load
    // and serve(): the server receives the old snapshot but stamps new files.
    write_catalog(&home.root(), "evot-pro", &["claude-opus-5.5", "evot-fast"])?;
    let workspace = TempDir::new()?;
    let (mut client, _) = Client::start_config(
        &workspace,
        config,
        ToolMode::Chat,
        false,
        MockProvider::text("ok"),
    )?;
    let (session_id, _) = new_session(&mut client, workspace.path()).await?;
    let response = select(&mut client, &session_id, "evot-pro:evot-fast").await?;
    client.close().await?;
    drop(home);
    drop(_guard);
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"], "evot-pro:evot-fast",
        "{response}"
    );
    Ok(())
}

struct ReviewRecordingProvider {
    keys: std::sync::Arc<parking_lot::Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl evot_engine::provider::StreamProvider for ReviewRecordingProvider {
    async fn stream(
        &self,
        config: evot_engine::provider::StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<evot_engine::provider::StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<evot_engine::provider::StreamOutcome, evot_engine::provider::ProviderError> {
        self.keys.lock().push(config.api_key.clone());
        evot_engine::provider::StreamProvider::stream(&MockProvider::text("ok"), config, tx, cancel)
            .await
    }
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn review_existing_acp_session_gets_rotated_key_after_catalog_reload() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let home = ReviewHome::new()?;
    write_catalog(&home.root(), "evot-pro", &["evot-fast"])?;
    let config = Config::load()?;
    let keys = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
    let provider = ReviewRecordingProvider { keys: keys.clone() };
    let workspace = TempDir::new()?;
    let (mut client, agent) =
        Client::start_config(&workspace, config, ToolMode::Chat, false, provider)?;
    let (old_session, _) = new_session(&mut client, workspace.path()).await?;

    let mut fresh = catalog("evot-pro", &["evot-fast"]);
    fresh["response"]["providers"][0]["api_key"] = json!("evot.fixture.rotated");
    write_catalog_value(&home.root(), &fresh)?;

    // Another session forces a successful reload, so neither change detection
    // nor a missing prompt-time refresh explains a stale key in this test.
    let _ = new_session(&mut client, workspace.path()).await?;
    assert_eq!(agent.llm().api_key, "evot.fixture.rotated");
    let (response, _) = client
        .request(
            "session/prompt",
            super::acp_test::text_prompt(&old_session, "hello"),
        )
        .await?;
    client.close().await?;
    drop(home);
    drop(_guard);
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(*keys.lock(), vec!["evot.fixture.rotated".to_string()]);
    Ok(())
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn acp_retries_bad_toml_and_refreshes_explicit_env_without_touching_user_data() -> TestResult
{
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let home = ReviewHome::new()?;
    let env = home.root().join("custom.env");
    let content = "# user preamble\nFOREIGN=keep\nEVOT_LLM_PROVIDER=custom\nEVOT_LLM_CUSTOM_PROTOCOL=openai\nEVOT_LLM_CUSTOM_BASE_URL=http://127.0.0.1:1\nEVOT_LLM_CUSTOM_MODEL=alpha,beta\nEVOT_LLM_CUSTOM_API_KEY=fixture-original\n";
    std::fs::write(&env, content)?;
    let config = Config::load_with_env_file(env.to_str())?;
    let keys = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
    let workspace = TempDir::new()?;
    let (mut client, _) = Client::start_config(
        &workspace,
        config,
        ToolMode::Chat,
        false,
        ReviewRecordingProvider { keys: keys.clone() },
    )?;
    let (session, _) = new_session(&mut client, workspace.path()).await?;
    std::fs::write(home.root().join("evot.toml"), "[broken")?;
    std::fs::write(&env, content.replace("fixture-original", "fixture-rotated"))?;
    let retained = select(&mut client, &session, "custom:beta").await?;
    assert_eq!(
        retained["result"]["configOptions"][0]["currentValue"], "custom:beta",
        "{retained}"
    );
    let (response, _) = client
        .request(
            "session/prompt",
            super::acp_test::text_prompt(&session, "old config"),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    // Repair only TOML. The failed refresh must not have accepted the new env
    // stamp, and the live session's explicit model choice must survive retry.
    std::fs::write(home.root().join("evot.toml"), "")?;
    let (response, _) = client
        .request(
            "session/prompt",
            super::acp_test::text_prompt(&session, "new config"),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(*keys.lock(), ["fixture-original", "fixture-rotated"]);
    assert_eq!(
        std::fs::read_to_string(&env)?,
        content.replace("fixture-original", "fixture-rotated")
    );
    client.close().await
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn acp_cancel_is_not_lost_while_reload_waits_for_an_external_env_writer() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let home = ReviewHome::new()?;
    write_catalog(&home.root(), "evot-pro", &["evot-fast"])?;
    let config = Config::load()?;
    let keys = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
    let workspace = TempDir::new()?;
    let (mut client, _) = Client::start_config(
        &workspace,
        config,
        ToolMode::Chat,
        false,
        ReviewRecordingProvider { keys: keys.clone() },
    )?;
    let (session, _) = new_session(&mut client, workspace.path()).await?;
    // Force refresh, then hold the same sidecar lock as settings/cloud writes.
    std::fs::write(home.root().join("evot.env"), "# external writer\n")?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(home.root().join("evot.env.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    client.send(json!({"jsonrpc":"2.0", "id":100, "method":"session/prompt", "params":super::acp_test::text_prompt(&session, "hello")})).await?;
    let (barrier, _) = client
        .request("initialize", json!({"protocolVersion":1}))
        .await?;
    assert!(barrier.get("result").is_some(), "{barrier}");
    client
        .send(json!({"jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId":session}}))
        .await?;
    let (barrier, _) = client
        .request("initialize", json!({"protocolVersion":1}))
        .await?;
    assert!(barrier.get("result").is_some(), "{barrier}");
    drop(lock);
    let response = client.frame().await?;
    assert_eq!(response["id"], 100, "{response}");
    assert_eq!(response["result"]["stopReason"], "cancelled", "{response}");
    assert!(
        keys.lock().is_empty(),
        "a cancelled prompt must not reach the provider"
    );
    client.close().await
}

struct BlockFirstProvider {
    seen: std::sync::Arc<parking_lot::Mutex<Vec<(String, String)>>>,
    started: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl evot_engine::provider::StreamProvider for BlockFirstProvider {
    async fn stream(
        &self,
        config: evot_engine::provider::StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<evot_engine::provider::StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<evot_engine::provider::StreamOutcome, evot_engine::provider::ProviderError> {
        let first = {
            let mut seen = self.seen.lock();
            seen.push((config.model.clone(), config.api_key.clone()));
            seen.len() == 1
        };
        if first {
            self.started.notify_one();
            tokio::select! {
                _ = self.release.notified() => {},
                _ = cancel.cancelled() => return Err(evot_engine::provider::ProviderError::Cancelled),
            }
        }
        evot_engine::provider::StreamProvider::stream(&MockProvider::text("ok"), config, tx, cancel)
            .await
    }
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn acp_reload_keeps_admitted_run_snapshot_and_independent_session_models() -> TestResult {
    let _guard = env_lock()
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let home = ReviewHome::new()?;
    write_catalog(&home.root(), "evot-pro", &["evot-fast", "claude-opus-5.5"])?;
    let seen = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let workspace = TempDir::new()?;
    let (mut client, _) = Client::start_config(
        &workspace,
        Config::load()?,
        ToolMode::Chat,
        false,
        BlockFirstProvider {
            seen: seen.clone(),
            started: started.clone(),
            release: release.clone(),
        },
    )?;
    let (first, _) = new_session(&mut client, workspace.path()).await?;
    let (second, _) = new_session(&mut client, workspace.path()).await?;
    select(&mut client, &second, "evot-pro:claude-opus-5.5").await?;
    client.send(json!({"jsonrpc":"2.0", "id":100, "method":"session/prompt", "params":super::acp_test::text_prompt(&first, "first")})).await?;
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified()).await?;

    let mut fresh = catalog("evot-paid", &["evot-fast", "claude-opus-5.5"]);
    fresh["response"]["providers"][0]["api_key"] = json!("fixture-rotated");
    write_catalog_value(&home.root(), &fresh)?;
    new_session(&mut client, workspace.path()).await?;
    let (response, _) = client
        .request(
            "session/prompt",
            super::acp_test::text_prompt(&second, "second"),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    release.notify_one();
    loop {
        let frame = client.frame().await?;
        if frame["id"] == 100 {
            assert_eq!(frame["result"]["stopReason"], "end_turn", "{frame}");
            break;
        }
    }
    let (response, _) = client
        .request(
            "session/prompt",
            super::acp_test::text_prompt(&first, "next"),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(*seen.lock(), [
        ("evot-fast".to_string(), "evot.fixture.key".to_string()),
        ("claude-opus-5.5".to_string(), "fixture-rotated".to_string()),
        ("evot-fast".to_string(), "fixture-rotated".to_string()),
    ]);
    client.close().await
}
