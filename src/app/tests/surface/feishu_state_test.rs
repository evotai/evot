use evot::conf::channels::FeishuChannelConfig;
use evot::surface::gateway::channels::feishu::state::DirectChatStore;
use evot::surface::gateway::channels::feishu::target::expand_broadcast;
use evot::surface::gateway::channels::feishu::target::resolve_targets;
use evot::surface::gateway::channels::feishu::target::BROADCAST_TARGET;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn channel(default_chat_id: &str) -> FeishuChannelConfig {
    FeishuChannelConfig {
        app_id: "cli_app".into(),
        app_secret: "app_secret".into(),
        mention_only: false,
        allow_from: vec![],
        default_chat_id: default_chat_id.into(),
    }
}

#[test]
fn omitted_target_uses_the_configured_default_chat() -> TestResult {
    assert_eq!(resolve_targets(&channel("oc_daily_report"), "")?, vec![
        "oc_daily_report".to_string()
    ]);
    Ok(())
}

#[test]
fn omitted_target_without_a_default_chat_is_a_clear_error() {
    let error = match resolve_targets(&channel(""), "") {
        Ok(targets) => panic!("expected an error, resolved {targets:?}"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("default notification chat ID"), "{error}");
}

#[test]
fn explicit_chat_target_is_used_verbatim() -> TestResult {
    assert_eq!(
        resolve_targets(&channel("oc_default"), "oc_explicit")?,
        vec!["oc_explicit".to_string()]
    );
    Ok(())
}

#[test]
fn a_target_that_is_not_a_chat_id_is_rejected() {
    assert!(resolve_targets(&channel("oc_default"), "ou_user").is_err());
}

/// Broadcast never happens implicitly: only this explicit target fans out.
#[test]
fn broadcast_is_opt_in_and_deduplicates_direct_chats() -> TestResult {
    assert_eq!(
        expand_broadcast(vec![
            "oc_second".to_string(),
            "oc_first".to_string(),
            "oc_second".to_string(),
            "invalid".to_string(),
        ])?,
        vec!["oc_first".to_string(), "oc_second".to_string()]
    );
    assert_ne!(BROADCAST_TARGET, "");
    Ok(())
}

#[test]
fn broadcast_without_known_direct_chats_is_a_clear_error() {
    let error = match expand_broadcast(Vec::new()) {
        Ok(targets) => panic!("expected an error, resolved {targets:?}"),
        Err(error) => error.to_string(),
    };
    assert!(
        error.contains("no known direct conversations yet"),
        "{error}"
    );
}

#[test]
fn remembered_conversations_are_deduplicated_per_app() -> TestResult {
    let root = tempfile::tempdir()?;
    let store = DirectChatStore::new(root.path());

    assert!(store.direct_chats("cli_app")?.is_empty());
    store.remember("cli_app", "ou_user_one", "oc_direct_one")?;
    store.remember("cli_app", "ou_user_alias", "oc_direct_one")?;
    store.remember("cli_app", "ou_user_two", "oc_direct_two")?;

    assert_eq!(store.direct_chats("cli_app")?, vec![
        "oc_direct_one".to_string(),
        "oc_direct_two".to_string()
    ]);
    Ok(())
}

#[test]
fn sender_chat_updates_are_atomic_and_app_scoped() -> TestResult {
    let root = tempfile::tempdir()?;
    let store = DirectChatStore::new(root.path());
    store.remember("cli_app", "ou_user_one", "oc_direct_old")?;
    store.remember("cli_app", "ou_user_one", "oc_direct_new")?;

    assert_eq!(store.direct_chats("cli_app")?, vec![
        "oc_direct_new".to_string()
    ]);
    assert!(store.direct_chats("another_app")?.is_empty());
    assert!(store
        .remember("cli_app", "ou_user_one", "not-a-chat")
        .is_err());
    Ok(())
}

/// State files written before `schema_version` existed must stay readable.
#[test]
fn legacy_state_without_a_version_is_readable() -> TestResult {
    let root = tempfile::tempdir()?;
    let store = DirectChatStore::new(root.path());
    store.remember("cli_app", "ou_user_one", "oc_direct_one")?;

    let dir = root.path().join("channels").join("feishu");
    let file = std::fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "json"))
        .ok_or("no state file written")?;
    std::fs::write(
        &file,
        include_bytes!("../fixtures/feishu-direct-chats-v0.json"),
    )?;

    assert_eq!(
        store.direct_chats("cli_app")?,
        vec!["oc_legacy".to_string()]
    );
    store.remember("cli_app", "ou_new", "oc_new")?;
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct V1Reader {
        schema_version: u32,
        chats_by_sender: std::collections::BTreeMap<String, String>,
    }
    let written: V1Reader = serde_json::from_slice(&std::fs::read(&file)?)?;
    assert_eq!(written.schema_version, 1);
    assert_eq!(
        written.chats_by_sender.get("ou_legacy").map(String::as_str),
        Some("oc_legacy")
    );
    let future = br#"{"schema_version":999,"chats_by_sender":{}}"#;
    std::fs::write(&file, future)?;
    assert!(store.remember("cli_app", "ou_new", "oc_new").is_err());
    assert_eq!(std::fs::read(&file)?, future);
    Ok(())
}
