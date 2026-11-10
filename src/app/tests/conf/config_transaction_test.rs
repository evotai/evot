use std::process::Command;

use evot::conf::env_writer::write_grouped;
use evot::conf::env_writer::EnvGroup;
use evot::conf::update_config;
use evot::conf::Config;
use evot_engine::ThinkingLevel;

type TestResult = Result<(), Box<dyn std::error::Error>>;

// Config loading reads HOME/TOML/auth as well as the supplied env path. Isolate
// the whole scenario in a child, never change the test runner's environment.
#[test]
fn config_transactions_reject_stale_snapshots_and_preserve_user_data() -> TestResult {
    const CHILD: &str = "EVOT_CONFIG_TRANSACTION_HOME";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let output = Command::new(std::env::current_exe()?)
            .args(["--exact", "config_transaction_test::config_transactions_reject_stale_snapshots_and_preserve_user_data", "--nocapture"])
            .env_clear()
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env(CHILD, home.path())
            .output()?;
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }
    let home = std::path::PathBuf::from(std::env::var(CHILD)?);
    let path = home.join("evot.env");
    let mut group = EnvGroup::new("Provider: test");
    group.push("EVOT_LLM_PROVIDER", "test");
    group.push("EVOT_LLM_TEST_PROTOCOL", "openai");
    group.push("EVOT_LLM_TEST_API_KEY", "fixture-secret");
    group.push("EVOT_LLM_TEST_BASE_URL", "https://example.invalid/v1");
    group.push("EVOT_LLM_TEST_MODEL", "fixture-model");
    std::fs::write(&path, "# personal preamble\nUNRELATED=value\n")?;
    write_grouped(&path, &[group])?;
    let path_arg = path.to_str().ok_or("non-UTF8 fixture path")?;
    let mut first = Config::load_with_env_file(Some(path_arg))?;
    let mut stale = Config::load_with_env_file(Some(path_arg))?;
    update_config(&mut first, |config| {
        config
            .providers
            .get_mut("test")
            .ok_or("missing test provider")
            .map_err(|e| evot::base::error::EvotError::Conf(e.into()))?
            .api_key = "rotated-fixture-secret".into();
        Ok(())
    })?;
    let written = std::fs::read(&path)?;
    let before = stale.llm.thinking_level;
    let error = evot::conf::persist_default_thinking_level(&mut stale, "test", ThinkingLevel::Low);
    assert!(error.is_err());
    assert_eq!(stale.llm.thinking_level, before);
    assert_eq!(std::fs::read(&path)?, written);
    let mut refreshed = Config::load_with_env_file(Some(path_arg))?;
    evot::conf::persist_default_thinking_level(&mut refreshed, "test", ThinkingLevel::Low)?;
    let persisted = std::fs::read_to_string(&path)?;
    assert!(persisted.contains("rotated-fixture-secret"));
    assert!(persisted.contains("# personal preamble\nUNRELATED=value"));
    assert!(persisted.contains("EVOT_LLM_THINKING_LEVEL=low"));
    // An editor that ignores our lock is still detected when it changed bytes
    // before the transaction began. We cannot protect changes during a write.
    std::fs::write(&path, format!("{persisted}\nEDITOR_NOTE=keep\n"))?;
    assert!(evot::conf::persist_default_thinking_level(
        &mut refreshed,
        "test",
        ThinkingLevel::High
    )
    .is_err());
    assert!(std::fs::read_to_string(&path)?.contains("EDITOR_NOTE=keep"));
    #[cfg(unix)]
    {
        let alias = home.join("alias.env");
        std::os::unix::fs::symlink(&path, &alias)?;
        let mut via_alias = Config::load_with_env_file(alias.to_str())?;
        let mut via_target = Config::load_with_env_file(Some(path_arg))?;
        evot::conf::persist_default_thinking_level(&mut via_alias, "test", ThinkingLevel::Medium)?;
        assert!(std::fs::symlink_metadata(&alias)?.file_type().is_symlink());
        assert!(evot::conf::persist_default_thinking_level(
            &mut via_target,
            "test",
            ThinkingLevel::High
        )
        .is_err());
        assert!(std::fs::read_to_string(&path)?.contains("EVOT_LLM_THINKING_LEVEL=medium"));
    }
    Ok(())
}

#[test]
fn config_transactions_serialize_competing_writers() -> TestResult {
    const ROOT: &str = "EVOT_CONFIG_RACE_HOME";
    const ID: &str = "EVOT_CONFIG_RACE_ID";
    if let Some(root) = std::env::var_os(ROOT) {
        let root = std::path::PathBuf::from(root);
        let id = std::env::var(ID)?;
        let path = root.join("evot.env");
        let mut config = Config::load_with_env_file(path.to_str())?;
        std::fs::write(root.join(format!("ready-{id}")), "")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("go").exists() {
            if std::time::Instant::now() > deadline {
                return Err("race barrier timed out".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let result = evot::conf::persist_default_thinking_level(
            &mut config,
            "test",
            if id == "0" {
                ThinkingLevel::Low
            } else {
                ThinkingLevel::High
            },
        );
        std::fs::write(
            root.join(format!("result-{id}")),
            if result.is_ok() { "saved" } else { "conflict" },
        )?;
        return Ok(());
    }
    let home = tempfile::tempdir()?;
    std::fs::write(home.path().join("evot.env"), "EVOT_LLM_PROVIDER=test\nEVOT_LLM_TEST_PROTOCOL=openai\nEVOT_LLM_TEST_API_KEY=fixture\nEVOT_LLM_TEST_BASE_URL=https://example.invalid/v1\nEVOT_LLM_TEST_MODEL=test\n")?;
    let mut children = Vec::new();
    for id in 0..2 {
        children.push(
            Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "config_transaction_test::config_transactions_serialize_competing_writers",
                ])
                .env_clear()
                .env("HOME", home.path())
                .env("USERPROFILE", home.path())
                .env(ROOT, home.path())
                .env(ID, id.to_string())
                .stdout(std::process::Stdio::null())
                .spawn()?,
        );
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !(home.path().join("ready-0").exists() && home.path().join("ready-1").exists()) {
        if std::time::Instant::now() > deadline {
            for child in &mut children {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err("workers did not reach barrier".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    std::fs::write(home.path().join("go"), "")?;
    for mut child in children {
        assert!(child.wait()?.success());
    }
    let mut outcomes = vec![
        std::fs::read_to_string(home.path().join("result-0"))?,
        std::fs::read_to_string(home.path().join("result-1"))?,
    ];
    outcomes.sort();
    assert_eq!(outcomes, ["conflict", "saved"]);
    Ok(())
}

#[test]
fn config_without_loaded_revision_cannot_overwrite_existing_file() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.env_file_path = dir.path().join("evot.env");
    std::fs::write(&config.env_file_path, "USER_DATA=keep\n")?;
    let result = update_config(&mut config, |_| Ok(()));
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(&config.env_file_path)?,
        "USER_DATA=keep\n"
    );
    Ok(())
}

#[test]
fn config_transaction_cannot_publish_a_different_destination() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mut config = Config::new(dir.path().to_path_buf());
    let original = dir.path().join("original.env");
    let other = dir.path().join("other.env");
    config.env_file_path = original.clone();
    assert!(update_config(&mut config, |candidate| {
        candidate.env_file_path = other.clone();
        Ok(())
    })
    .is_err());
    assert_eq!(config.env_file_path, original);
    assert!(!original.exists());
    assert!(!other.exists());
    Ok(())
}

#[test]
fn config_mutation_failure_does_not_publish_or_write() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mut config = Config::new(dir.path().to_path_buf());
    config.env_file_path = dir.path().join("evot.env");
    let result: evot::base::error::Result<()> = update_config(&mut config, |candidate| {
        candidate.llm.thinking_level = Some(ThinkingLevel::High);
        Err(evot::base::error::EvotError::Conf(
            "fixture rejected".into(),
        ))
    });
    assert!(result.is_err());
    assert!(config.llm.thinking_level.is_none());
    assert!(!config.env_file_path.exists());
    Ok(())
}
