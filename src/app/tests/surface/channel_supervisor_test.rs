use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use evot::surface::gateway::registry::PreparedChannel;
use evot::surface::gateway::supervisor::ChannelSupervisor;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;
type Events = Arc<Mutex<Vec<String>>>;

fn events(events: &Events) -> Vec<String> {
    match events.lock() {
        Ok(value) => value.clone(),
        Err(error) => panic!("events lock poisoned: {error}"),
    }
}

fn record(events: &Events, value: String) {
    match events.lock() {
        Ok(mut events) => events.push(value),
        Err(error) => panic!("events lock poisoned: {error}"),
    }
}

fn adapter(name: &'static str, revision: &str, events: &Events) -> PreparedChannel {
    let log = events.clone();
    let revision = revision.to_owned();
    PreparedChannel {
        name,
        revision: revision.clone(),
        start: Box::new(move |cancel| {
            record(&log, format!("start:{name}:{revision}"));
            tokio::spawn(async move {
                cancel.cancelled().await;
                record(&log, format!("stop:{name}:{revision}"));
            })
        }),
    }
}

#[tokio::test]
async fn registry_channels_mount_replace_and_remove_independently() {
    let log = Events::default();
    let cancel = CancellationToken::new();
    let mut supervisor = ChannelSupervisor::default();
    supervisor
        .reconcile(
            vec![adapter("alpha", "1", &log), adapter("beta", "1", &log)],
            &cancel,
        )
        .await;
    supervisor
        .reconcile(
            vec![adapter("alpha", "1", &log), adapter("beta", "1", &log)],
            &cancel,
        )
        .await;
    assert_eq!(events(&log), vec!["start:alpha:1", "start:beta:1"]);
    supervisor
        .reconcile(
            vec![adapter("alpha", "2", &log), adapter("beta", "1", &log)],
            &cancel,
        )
        .await;
    assert_eq!(events(&log), vec![
        "start:alpha:1",
        "start:beta:1",
        "stop:alpha:1",
        "start:alpha:2"
    ]);
    supervisor
        .reconcile(vec![adapter("alpha", "2", &log)], &cancel)
        .await;
    assert_eq!(events(&log).last().map(String::as_str), Some("stop:beta:1"));
    supervisor.shutdown().await;
    assert_eq!(
        events(&log).last().map(String::as_str),
        Some("stop:alpha:2")
    );
}

#[tokio::test]
async fn finished_transport_is_replaced_without_a_configuration_edit() {
    let cancel = CancellationToken::new();
    let log = Events::default();
    let mut supervisor = ChannelSupervisor::default();
    supervisor
        .reconcile(
            vec![PreparedChannel {
                name: "alpha",
                revision: "1".into(),
                start: Box::new(|_| tokio::spawn(async {})),
            }],
            &cancel,
        )
        .await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    supervisor
        .reconcile(vec![adapter("alpha", "1", &log)], &cancel)
        .await;
    assert_eq!(events(&log), vec!["start:alpha:1"]);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn cancelled_supervisor_never_starts_new_transports() {
    let log = Events::default();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut supervisor = ChannelSupervisor::default();
    supervisor
        .reconcile(vec![adapter("alpha", "1", &log)], &cancel)
        .await;
    assert!(events(&log).is_empty());
}

#[tokio::test]
async fn dropping_supervisor_cancels_children() -> TestResult {
    let cancel = CancellationToken::new();
    let (sent, received) = tokio::sync::oneshot::channel();
    let mut supervisor = ChannelSupervisor::default();
    supervisor
        .reconcile(
            vec![PreparedChannel {
                name: "alpha",
                revision: "1".into(),
                start: Box::new(move |child| {
                    let _ = sent.send(child.clone());
                    tokio::spawn(async move { child.cancelled().await })
                }),
            }],
            &cancel,
        )
        .await;
    let child = received.await?;
    drop(supervisor);
    tokio::time::timeout(Duration::from_secs(1), child.cancelled()).await?;
    Ok(())
}

#[test]
fn feishu_transport_revision_includes_secret_rotation_not_delivery_defaults() {
    use evot::conf::channels::FeishuChannelConfig;
    use evot::surface::gateway::channels::feishu::registration::revision;
    let config = FeishuChannelConfig {
        app_id: "test_app".into(),
        app_secret: "test_secret".into(),
        mention_only: true,
        allow_from: vec![],
        default_chat_id: String::new(),
    };
    let original = revision(&config);
    let mut changed = config.clone();
    changed.app_secret = "rotated_test_secret".into();
    assert_ne!(revision(&changed), original);
    changed = config.clone();
    changed.allow_from.push("sender".into());
    assert_ne!(revision(&changed), original);
    changed = config;
    changed.default_chat_id = "oc_default".into();
    assert_eq!(revision(&changed), original);
}
