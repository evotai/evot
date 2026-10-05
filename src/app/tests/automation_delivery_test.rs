use std::time::Duration;

use evot::automation::delivery::deliver;
use evot::automation::delivery::validate;
use evot::automation::delivery::NOT_REQUESTED;
use evot::automation::dispatcher::effective_timeout;
use evot::automation::dispatcher::MAX_TIMEOUT_SECONDS;
use evot::automation::dispatcher::MIN_TIMEOUT_SECONDS;
use evot::automation::executor::eligible_tasks;
use evot::automation::executor::error_with_executor;
use evot::automation::model::Task;
use evot::automation::ExecutorCapabilities;
use evot::conf::channels::FeishuChannelConfig;
use evot::conf::ChannelsConfig;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn channels(default_chat_id: Option<&str>) -> ChannelsConfig {
    ChannelsConfig {
        feishu: default_chat_id.map(|chat| FeishuChannelConfig {
            app_id: "cli_app".into(),
            app_secret: "app_secret".into(),
            mention_only: false,
            allow_from: vec![],
            default_chat_id: chat.into(),
        }),
    }
}

/// A task with no delivery channel must never touch the network.
#[tokio::test]
async fn no_channel_reports_not_requested() -> TestResult {
    assert_eq!(
        deliver(&channels(None), "", "", "result").await?,
        NOT_REQUESTED
    );
    assert_eq!(
        deliver(&channels(Some("oc_default")), "  ", "oc_x", "result").await?,
        NOT_REQUESTED
    );
    Ok(())
}

#[tokio::test]
async fn unknown_channel_is_rejected_before_sending() {
    let error = match deliver(&channels(None), "telegram", "chat", "result").await {
        Ok(status) => panic!("expected an error, got {status}"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("unsupported delivery channel"), "{error}");
}

#[tokio::test]
async fn feishu_delivery_without_the_channel_configured_is_rejected() {
    let error = match deliver(&channels(None), "feishu", "oc_chat", "result").await {
        Ok(status) => panic!("expected an error, got {status}"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("not configured"), "{error}");
}

/// Target resolution happens before any request, so a task that asks for
/// delivery with no reachable chat fails fast rather than half-sending.
#[tokio::test]
async fn feishu_delivery_without_a_target_is_rejected_before_sending() {
    let error = match deliver(&channels(Some("")), "feishu", "", "result").await {
        Ok(status) => panic!("expected an error, got {status}"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("default notification chat ID"), "{error}");
}

#[test]
fn run_timeouts_stay_inside_the_advertised_range() {
    assert_eq!(effective_timeout(900), Duration::from_secs(900));
    assert_eq!(
        effective_timeout(1),
        Duration::from_secs(MIN_TIMEOUT_SECONDS as u64)
    );
    assert_eq!(
        effective_timeout(7_200),
        Duration::from_secs(MAX_TIMEOUT_SECONDS as u64)
    );
    assert_eq!(
        effective_timeout(0),
        Duration::from_secs(MIN_TIMEOUT_SECONDS as u64)
    );
}

#[test]
fn delivery_preflight_rejects_missing_and_incomplete_credentials() -> TestResult {
    validate(&channels(None), "", "")?;
    assert!(validate(&channels(None), "feishu", "oc_chat").is_err());
    validate(&channels(Some("oc_chat")), "feishu", "")?;
    let mut incomplete = channels(Some("oc_chat"));
    if let Some(feishu) = &mut incomplete.feishu {
        feishu.app_secret.clear();
    }
    let error = match validate(&incomplete, "feishu", "oc_chat") {
        Ok(()) => panic!("incomplete credentials passed preflight"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("credentials are incomplete"), "{error}");
    assert!(error.contains("executor"), "{error}");
    Ok(())
}

#[test]
fn unconfigured_devices_leave_feishu_tasks_to_capable_executors() -> TestResult {
    let task: Task = serde_json::from_value(serde_json::json!({
        "id": "task", "revision": 1, "name": "Digest", "cron": "0 * * * *",
        "timezone": "UTC", "instruction": "Summarize", "executor_id": "shared",
        "enabled": true, "next_run_at": 0, "delivery_channel": "feishu"
    }))?;
    assert!(eligible_tasks(&channels(None), std::slice::from_ref(&task)).is_empty());
    assert_eq!(
        eligible_tasks(&channels(Some("oc_chat")), std::slice::from_ref(&task)).get("task"),
        Some(&1)
    );
    // A configured bot without a target is still incapable of delivery.
    assert!(eligible_tasks(&channels(Some("")), std::slice::from_ref(&task)).is_empty());
    let mut incomplete = channels(Some("oc_chat"));
    if let Some(feishu) = &mut incomplete.feishu {
        feishu.app_id.clear();
    }
    assert!(eligible_tasks(&incomplete, std::slice::from_ref(&task)).is_empty());
    let paused = Task {
        enabled: false,
        ..task.clone()
    };
    assert_eq!(
        eligible_tasks(&channels(Some("oc_chat")), &[paused]).get("task"),
        Some(&1)
    );
    let explicit = Task {
        delivery_target: "oc_explicit".into(),
        ..task.clone()
    };
    assert_eq!(
        eligible_tasks(&channels(Some("")), &[explicit]).get("task"),
        Some(&1)
    );
    let local = Task {
        id: "local".into(),
        revision: 4,
        delivery_channel: String::new(),
        ..task.clone()
    };
    let unsupported = Task {
        id: "unsupported".into(),
        delivery_channel: "telegram".into(),
        ..task.clone()
    };
    assert!(eligible_tasks(&channels(Some("oc_chat")), &[unsupported]).is_empty());
    let invalid_target = Task {
        delivery_target: "not-a-chat".into(),
        ..task.clone()
    };
    assert!(eligible_tasks(&channels(Some("oc_chat")), &[invalid_target]).is_empty());
    let eligible = eligible_tasks(&channels(None), &[local, task]);
    assert_eq!(eligible.len(), 1);
    assert_eq!(eligible.get("local"), Some(&4));
    assert!(eligible_tasks(&channels(None), &[]).is_empty());
    Ok(())
}

#[test]
fn failure_reports_record_the_actual_host_without_changing_the_wire_contract() {
    let legacy_error = "run error: Feishu channel is not configured";
    assert_eq!(
        error_with_executor(legacy_error, "build-server"),
        "run error: Feishu channel is not configured\nExecutor: build-server"
    );
    assert_eq!(error_with_executor("", "build-server"), "");
    assert_eq!(
        error_with_executor("model unavailable", " laptop\n\u{1b} "),
        "model unavailable\nExecutor: laptop"
    );
    assert_eq!(
        error_with_executor("failed", "\n"),
        "failed\nExecutor: Unknown host"
    );
}

#[tokio::test]
async fn claim_sends_local_task_revisions_and_propagates_rejection() -> TestResult {
    use evot::auth::AuthState;
    use evot::automation::client::claim;
    use serde_json::json;
    use wiremock::matchers::body_json;
    use wiremock::matchers::header;
    use wiremock::matchers::method;
    use wiremock::matchers::path;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;

    let server = MockServer::start().await;
    let auth: AuthState = serde_json::from_value(json!({
        "version": 1, "server_base_url": server.uri(),
        "user": {"id": "user", "name": "User", "email": "test@example.dev"},
        "cli_token": "test-token", "refresh_token": "", "models_synced_at": 0
    }))?;
    let eligible = std::collections::BTreeMap::from([("local".to_string(), 4)]);
    Mock::given(method("POST"))
        .and(path("/v1/task-runs/claim"))
        .and(header("authorization", "Bearer test-token"))
        .and(body_json(json!({
            "executor_id": "shared", "request_id": "request", "eligible_tasks": {"local": 4}
        })))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    assert!(claim(&auth, "shared", "request", &eligible)
        .await?
        .is_none());
    Mock::given(method("POST"))
        .and(path("/v1/task-runs/claim"))
        .and(body_json(json!({
            "executor_id": "shared", "request_id": "rejected", "eligible_tasks": {"local": 4}
        })))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "invalid_claim", "message": "rejected claim"
        })))
        .expect(1)
        .mount(&server)
        .await;
    assert!(claim(&auth, "shared", "rejected", &eligible).await.is_err());
    server.verify().await;
    Ok(())
}

/// Capability changes must produce a new fingerprint, or the dispatcher would
/// keep advertising a stale channel set after the console is edited.
#[test]
fn capability_fingerprint_tracks_channel_changes() {
    let linked = ExecutorCapabilities::from_channels(&channels(Some("oc_default")));
    let unlinked = ExecutorCapabilities::from_channels(&channels(None));
    assert!(linked.feishu_ready);
    assert!(!unlinked.feishu_ready);
    assert_ne!(
        linked.fingerprint("user", "exec_1", "host"),
        unlinked.fingerprint("user", "exec_1", "host")
    );
    assert_eq!(
        linked.fingerprint("user", "exec_1", "host"),
        ExecutorCapabilities::from_channels(&channels(Some("oc_other")))
            .fingerprint("user", "exec_1", "host")
    );
    assert_ne!(
        linked.fingerprint("user", "exec_1", "host"),
        linked.fingerprint("user", "exec_2", "host")
    );
}
