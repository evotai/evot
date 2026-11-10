//! Tests for Variables (agent/variables.rs).

use std::sync::Arc;

use evot::agent::Variables;
use evot::session::storage::fs::FsStorage;
use evot::session::storage::Storage;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

async fn make_variables(dir: &std::path::Path) -> Arc<Variables> {
    let storage: Arc<dyn Storage> = Arc::new(FsStorage::new(dir.to_path_buf()));
    Arc::new(Variables::new(storage, Vec::new()))
}

async fn make_variables_with_storage(dir: &std::path::Path) -> (Arc<Variables>, Arc<dyn Storage>) {
    let storage: Arc<dyn Storage> = Arc::new(FsStorage::new(dir.to_path_buf()));
    let vars = Arc::new(Variables::new(storage.clone(), Vec::new()));
    (vars, storage)
}

// ---------------------------------------------------------------------------
// set / list / delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_and_list_global() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("API_KEY".into(), "abc".into()).await?;
    vars.set_global("DB_HOST".into(), "localhost".into())
        .await?;

    let items = vars.list_global();
    let keys: Vec<&str> = items.iter().map(|i| i.key.as_str()).collect();
    assert!(keys.contains(&"API_KEY"));
    assert!(keys.contains(&"DB_HOST"));
    assert_eq!(items.len(), 2);
    Ok(())
}

#[tokio::test]
async fn list_global_sorted_by_key() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("GAMMA".into(), "3".into()).await?;
    vars.set_global("ALPHA".into(), "1".into()).await?;
    vars.set_global("BETA".into(), "2".into()).await?;

    let items = vars.list_global();
    let keys: Vec<&str> = items.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(keys, vec!["ALPHA", "BETA", "GAMMA"]);
    Ok(())
}

#[tokio::test]
async fn list_global_includes_value() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("KEY".into(), "my-value".into()).await?;

    let items = vars.list_global();
    assert_eq!(items[0].key, "KEY");
    assert_eq!(items[0].value, "my-value");
    Ok(())
}

#[tokio::test]
async fn set_overwrites_existing() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("KEY".into(), "old".into()).await?;
    vars.set_global("KEY".into(), "new".into()).await?;

    let items = vars.list_global();
    assert_eq!(items.len(), 1);
    Ok(())
}

#[tokio::test]
async fn delete_existing_key() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("KEY".into(), "val".into()).await?;
    let removed = vars.delete_global("KEY").await?;
    assert!(removed);
    assert!(vars.list_global().is_empty());
    Ok(())
}

#[tokio::test]
async fn delete_nonexistent_key() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    let removed = vars.delete_global("NOPE").await?;
    assert!(!removed);
    Ok(())
}

#[tokio::test]
async fn has_variables() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    assert!(!vars.has_variables());
    vars.set_global("K".into(), "V".into()).await?;
    assert!(vars.has_variables());
    Ok(())
}

// ---------------------------------------------------------------------------
// import via set_global (simulating REPL flow)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn import_env_via_set_global() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    let pairs = vec![
        ("API_KEY".to_string(), "abc123".to_string()),
        ("DB_HOST".to_string(), "localhost".to_string()),
        ("QUOTED".to_string(), "hello world".to_string()),
    ];
    for (key, value) in pairs {
        vars.set_global(key, value).await?;
    }

    let keys: Vec<String> = vars.list_global().iter().map(|i| i.key.clone()).collect();
    assert!(keys.contains(&"API_KEY".to_string()));
    assert!(keys.contains(&"DB_HOST".to_string()));
    assert!(keys.contains(&"QUOTED".to_string()));
    assert_eq!(keys.len(), 3);
    Ok(())
}

// ---------------------------------------------------------------------------
// all_env_pairs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn all_env_pairs_returns_all_sorted() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("BETA".into(), "2".into()).await?;
    vars.set_global("ALPHA".into(), "1".into()).await?;

    let pairs = vars.all_env_pairs();
    assert_eq!(pairs, vec![
        ("ALPHA".to_string(), "1".to_string()),
        ("BETA".to_string(), "2".to_string()),
    ]);
    Ok(())
}

#[tokio::test]
async fn all_env_pairs_empty_when_no_variables() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    assert!(vars.all_env_pairs().is_empty());
    Ok(())
}

// ---------------------------------------------------------------------------
// secret_values
// ---------------------------------------------------------------------------

#[tokio::test]
async fn secret_values_returns_all_values() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("KEY_A".into(), "val-a".into()).await?;
    vars.set_global("KEY_B".into(), "val-b".into()).await?;

    let mut secrets = vars.secret_values();
    secrets.sort();
    assert_eq!(secrets, vec!["val-a", "val-b"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// variable_names
// ---------------------------------------------------------------------------

#[tokio::test]
async fn variable_names_returns_sorted_unique() -> Result {
    let tmp = tempfile::tempdir()?;
    let vars = make_variables(tmp.path()).await;

    vars.set_global("GAMMA".into(), "3".into()).await?;
    vars.set_global("ALPHA".into(), "1".into()).await?;

    let names = vars.variable_names();
    assert_eq!(names, vec!["ALPHA", "GAMMA"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// persistence roundtrip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn persistence_roundtrip() -> Result {
    let tmp = tempfile::tempdir()?;
    let (vars, storage) = make_variables_with_storage(tmp.path()).await;

    vars.set_global("A".into(), "1".into()).await?;
    vars.set_global("B".into(), "2".into()).await?;

    // Reload from storage
    let records = storage.load_variables().await?;
    assert_eq!(records.len(), 2);

    let keys: Vec<&str> = records.iter().map(|r| r.key.as_str()).collect();
    assert!(keys.contains(&"A"));
    assert!(keys.contains(&"B"));
    Ok(())
}

#[tokio::test]
async fn a_stale_writer_does_not_drop_another_process_variables() -> Result {
    let tmp = tempfile::tempdir()?;

    // First process stores three credentials.
    let (first, storage) = make_variables_with_storage(tmp.path()).await;
    for key in ["DSN_A", "DSN_B", "DSN_C"] {
        first
            .set_global(key.into(), format!("secret-{key}"))
            .await?;
    }

    // Second process started earlier and never saw them: its snapshot is empty.
    let stale = make_variables(tmp.path()).await;
    stale.set_global("a".into(), "1".into()).await?;

    let keys: Vec<String> = storage
        .load_variables()
        .await?
        .into_iter()
        .map(|record| record.key)
        .collect();
    assert!(
        keys.contains(&"DSN_A".to_string())
            && keys.contains(&"DSN_B".to_string())
            && keys.contains(&"DSN_C".to_string()),
        "stale writer clobbered existing variables, kept only {keys:?}"
    );
    assert!(keys.contains(&"a".to_string()));
    assert_eq!(keys.len(), 4);

    // The stale writer also refreshes its own view instead of staying blind.
    assert_eq!(stale.variable_names().len(), 4);
    Ok(())
}

#[tokio::test]
async fn a_stale_delete_only_removes_its_target() -> Result {
    let tmp = tempfile::tempdir()?;
    let (first, storage) = make_variables_with_storage(tmp.path()).await;
    first.set_global("KEEP".into(), "1".into()).await?;
    first.set_global("DROP".into(), "2".into()).await?;

    let stale = make_variables(tmp.path()).await;
    assert!(!stale.delete_global("MISSING").await?);
    assert!(stale.delete_global("DROP").await?);

    let keys: Vec<String> = storage
        .load_variables()
        .await?
        .into_iter()
        .map(|record| record.key)
        .collect();
    assert_eq!(keys, vec!["KEEP".to_string()]);
    Ok(())
}

#[tokio::test]
async fn concurrent_writers_all_survive() -> Result {
    let tmp = tempfile::tempdir()?;
    let storage: std::sync::Arc<dyn evot::session::storage::Storage> = std::sync::Arc::new(
        evot::session::storage::fs::FsStorage::new(tmp.path().to_path_buf()),
    );

    // Each writer has its own empty snapshot, as separate processes would.
    let mut handles = Vec::new();
    for index in 0..8 {
        let vars = std::sync::Arc::new(evot::agent::Variables::new(storage.clone(), Vec::new()));
        handles.push(tokio::spawn(async move {
            vars.set_global(format!("K{index}"), format!("v{index}"))
                .await
        }));
    }
    for handle in handles {
        handle.await??;
    }

    let mut keys: Vec<String> = storage
        .load_variables()
        .await?
        .into_iter()
        .map(|record| record.key)
        .collect();
    keys.sort();
    assert_eq!(keys.len(), 8, "concurrent writers lost variables: {keys:?}");
    Ok(())
}

#[tokio::test]
async fn variables_file_is_private_to_the_owner() -> Result {
    let tmp = tempfile::tempdir()?;
    let (vars, _storage) = make_variables_with_storage(tmp.path()).await;

    vars.set_global(
        "BENDCLOUD_DSN".into(),
        "bendcloud://org:secret@api.databend.com/default".into(),
    )
    .await?;

    let path = tmp.path().join("variables.json");
    assert!(path.is_file());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "variables.json holds secrets; mode was {mode:o}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn rewriting_variables_keeps_the_file_private_and_complete() -> Result {
    let tmp = tempfile::tempdir()?;
    let (vars, storage) = make_variables_with_storage(tmp.path()).await;
    let path = tmp.path().join("variables.json");

    for index in 0..4 {
        vars.set_global(format!("K{index}"), format!("v{index}"))
            .await?;

        let text = std::fs::read_to_string(&path)?;
        serde_json::from_str::<serde_json::Value>(&text)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "rewrite {index} left mode {mode:o}");
        }
    }

    assert_eq!(storage.load_variables().await?.len(), 4);

    // No temporary files left beside the destination. The lock file is
    // deliberate and persists, like transcript.lock.
    let leftovers: Vec<String> = std::fs::read_dir(tmp.path())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name != "variables.json" && name != "variables.lock")
        .collect();
    assert!(leftovers.is_empty(), "unexpected leftovers: {leftovers:?}");
    Ok(())
}
