use std::path::PathBuf;
use std::process::Command;

use evot::agent::bootstrap::build_agent;
use evot::conf::Config;
use evot::session::storage::fs::FsStorage;
use evot::session::storage::Storage;
use evot::types::VariableRecord;

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Bootstrap materializes builtin skills under HOME. Run it in a child rather
/// than mutating process-global HOME/cwd alongside other integration tests.
#[test]
fn bootstrap_initializes_application_without_gateway() -> TestResult {
    const CHILD: &str = "EVOT_BOOTSTRAP_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let workspace = home.path().join("workspace");
        std::fs::create_dir(&workspace)?;
        let output = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "bootstrap_test::bootstrap_initializes_application_without_gateway",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .current_dir(workspace)
            .output()?;
        assert!(
            output.status.success(),
            "bootstrap child failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let home = PathBuf::from(std::env::var("HOME")?);
            let root = home.join(".evotai");
            let mut config = Config::new(root.clone());
            config.skills_dirs = vec![home.join("project-skills")];
            let storage = FsStorage::new(root.clone());
            storage
                .upsert_variable(VariableRecord {
                    key: "BOOTSTRAP_FIXTURE".into(),
                    value: "fixture-value".into(),
                    updated_at: "2026-01-01T00:00:00Z".into(),
                })
                .await?;

            let agent = build_agent(&config).await?;
            assert_eq!(agent.cwd(), std::env::current_dir()?.to_string_lossy());
            assert!(agent.llm().model.is_empty());
            assert!(agent.system_prompt().contains("Available tools:"));
            assert!(agent.system_prompt().contains(agent.cwd()));
            assert_eq!(agent.skills_dirs(), vec![
                root.join("builtin-skills"),
                root.join("skills"),
                home.join("project-skills"),
            ]);
            assert!(root.join("builtin-skills/memory/SKILL.md").is_file());
            let variables = agent.variables().ok_or("variables were not initialized")?;
            assert_eq!(variables.all_env_pairs(), vec![(
                "BOOTSTRAP_FIXTURE".into(),
                "fixture-value".into()
            )]);
            Ok(())
        })
}

#[test]
fn bootstrap_dependency_boundary() {
    let bootstrap = include_str!("../../src/agent/bootstrap/agent.rs");
    assert!(!bootstrap.contains("crate::surface::gateway"));
    let gateway = include_str!("../../src/surface/service.rs");
    assert!(!gateway.contains("pub use crate::agent::bootstrap::build_agent"));
    assert!(!gateway.contains("pub async fn build_agent"));
    for adapter in [
        include_str!("../../../../cli/addon/src/agent.rs"),
        include_str!("../../../../cli/addon/src/server.rs"),
    ] {
        assert!(adapter.contains("evot::api::build_agent"));
        assert!(!adapter.contains("evot::surface::service::build_agent"));
    }
}
