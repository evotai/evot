//! Compatibility and cache tests through public production entry points.
//! Filesystem/service tests run in a child with a disposable HOME.
use std::path::Path;
use std::process::Command;

use evot::privacy::PrivacySettings;
use evot::privacy::{self};
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn pack(kind: &str) -> serde_json::Value {
    json!({"schema_version":1,"id":"runtime-fixture","kinds":[{"name":kind,"category":"secret"}],
        "rules":[{"id":"runtime.marker","kind":kind,"regex":"RUNTIME_FIXTURE_[0-9]{10}"}]})
}

#[test]
fn production_cache_reloads_and_settings_survive_broken_packs() -> TestResult {
    const CHILD: &str = "EVOT_PRIVACY_RUNTIME_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let output = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "privacy_runtime_test::production_cache_reloads_and_settings_survive_broken_packs",
                "--nocapture",
            ])
            .env_clear()
            .env(CHILD, "1")
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .output()?;
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }
    tokio::runtime::Runtime::new()?.block_on(async {
        let home = std::env::var_os("HOME").ok_or("missing child HOME")?;
        let root = Path::new(&home).join(".evotai/privacy");
        let rules = root.join("rules");
        privacy::save_settings(PrivacySettings::default()).await?;
        privacy::rules_status().await?; // prime the no-user-pack cache
        std::fs::write(&rules, "not a directory")?;
        assert!(
            privacy::rules_status().await.is_err(),
            "an unreadable directory reused an empty cached stamp"
        );
        std::fs::remove_file(&rules)?;
        std::fs::create_dir(&rules)?;
        let path = rules.join("fixture.json");
        std::fs::write(&path, serde_json::to_vec(&pack("FIXTURE_A"))?)?;
        assert!(privacy::rules_status()
            .await?
            .0
            .iter()
            .any(|k| k.kind == "FIXTURE_A"));
        // Same-size atomic replacement; retain mtime to exercise identity,
        // rather than accidentally relying on a clock tick.
        let modified = std::fs::metadata(&path)?.modified()?;
        let tmp = rules.join("replacement.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&pack("FIXTURE_B"))?)?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&tmp)?
            .set_times(std::fs::FileTimes::new().set_modified(modified))?;
        std::fs::rename(&tmp, &path)?;
        #[cfg(unix)]
        assert!(privacy::rules_status()
            .await?
            .0
            .iter()
            .any(|k| k.kind == "FIXTURE_B"));
        std::fs::write(&path, "{ invalid pack")?;
        assert!(privacy::rules_status().await.is_err());
        // Saving/reading settings remains available without valid packs.
        privacy::save_settings(PrivacySettings::default()).await?;
        assert!(privacy::settings().await?.enabled);
        std::fs::remove_file(&path)?;
        assert!(!privacy::rules_status()
            .await?
            .0
            .iter()
            .any(|k| k.kind == "FIXTURE_A" || k.kind == "FIXTURE_B"));
        Ok::<_, Box<dyn std::error::Error>>(())
    })
}
