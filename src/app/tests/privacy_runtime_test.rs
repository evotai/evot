//! Compatibility and cache tests through public production entry points.
//! Filesystem/service tests run in a child with a disposable HOME.
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use evot::privacy::GuardedTool;
use evot::privacy::Masker;
use evot::privacy::PrivacySettings;
use evot::privacy::Target;
use evot::privacy::{self};
use evot_engine::AgentTool;
use evot_engine::ToolError;
use serde_json::json;

use crate::privacy_egress_test::context;
use crate::privacy_egress_test::Recorder;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn cancelled_guards_never_execute_the_inner_tool() -> TestResult {
    let dir = tempfile::tempdir()?;
    let ran = Arc::new(AtomicBool::new(false));
    for fixed in [false, true] {
        let inner = Box::new(Recorder {
            name: "read",
            ran: ran.clone(),
        });
        let tool = if fixed {
            GuardedTool::with_masker(
                inner,
                Arc::new(Masker::new(&PrivacySettings::default(), [7; 32])?),
            )
        } else {
            GuardedTool::new(inner, None)
        };
        let ctx = context("read", dir.path());
        ctx.cancel.cancel();
        let result = tool.execute(json!({"path":"README.md"}), ctx).await;
        assert!(matches!(result, Err(ToolError::Cancelled)));
        assert!(!ran.load(Ordering::SeqCst));
    }
    Ok(())
}

#[test]
fn shadow_counts_do_not_change_allowed_calls_or_audit_records() -> TestResult {
    let dir = tempfile::tempdir()?;
    let masker = Masker::new(&PrivacySettings::default(), [8; 32])?;
    let fixture = "runtime-fixture-only-1680924";
    masker.remember_secret(fixture);
    let args = json!({"command":format!("echo {fixture}")});
    let report = masker.check_call("bash", &args, dir.path());
    assert!(report.is_empty());
    assert!(report.record(Target::Egress).values.is_empty());
    assert_eq!(masker.shadow_summary().sensitive_shell_unclassified, 1);
    assert_eq!(masker.shadow_summary().text_derived_destination, 0);
    // A local endpoint keeps its existing behavior; candidate stricter
    // authorization is counted but not applied or persisted.
    let args = json!({"url":"http://localhost:8080/health", "headers":{"x-fixture":fixture}});
    let before = args.clone();
    assert!(masker.check_call("web_fetch", &args, dir.path()).is_empty());
    assert_eq!(args, before);
    assert_eq!(masker.shadow_summary().text_derived_destination, 1);
    Ok(())
}

#[test]
fn cached_taint_index_preserves_old_paths_and_known_value_restoration() -> TestResult {
    let dir = tempfile::tempdir()?;
    let masker = Masker::new(&PrivacySettings::default(), [9; 32])?;
    let fixture = "index-fixture-only-8497610";
    masker.remember_secret(fixture);
    for i in 0..1000 {
        assert!(masker
            .check_call(
                "write",
                &json!({"path":format!("dir/file-{i}.txt"),"content":fixture}),
                dir.path()
            )
            .is_empty());
    }
    for i in [0, 500, 999] {
        let args = json!({"path":format!("dir/file-{i}.txt")});
        assert!(masker.check_call("mcp_upload", &args, dir.path()).blocked());
        let args = json!({"path":format!("other/file-{i}.txt")});
        assert!(masker
            .check_call("mcp_upload", &args, dir.path())
            .is_empty());
    }
    // Read-only calls and duplicate taint updates must not erase the index.
    for _ in 0..10 {
        masker.check_call(
            "write",
            &json!({"path":"dir/file-0.txt","content":fixture}),
            dir.path(),
        );
        assert!(masker
            .check_call("read", &json!({"path":"dir/file-0.txt"}), dir.path())
            .is_empty());
    }
    assert!(masker
        .check_call(
            "mcp_upload",
            &json!({"path":"dir/file-999.txt"}),
            dir.path()
        )
        .blocked());
    Ok(())
}

fn pack(kind: &str) -> serde_json::Value {
    json!({"schema_version":1,"id":"runtime-fixture","kinds":[{"name":kind,"category":"secret"}],
        "rules":[{"id":"runtime.marker","kind":kind,"regex":"RUNTIME_FIXTURE_[0-9]{10}"}]})
}

#[test]
fn production_cache_reloads_and_guard_factory_preserves_behavior() -> TestResult {
    const CHILD: &str = "EVOT_PRIVACY_RUNTIME_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let output = Command::new(std::env::current_exe()?)
            .args(["--exact", "privacy_runtime_test::production_cache_reloads_and_guard_factory_preserves_behavior", "--nocapture"])
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
        let ran = Arc::new(AtomicBool::new(false));
        let tools = privacy::guard_tools(
            vec![Box::new(Recorder {
                name: "read",
                ran: ran.clone(),
            })],
            Some("test-session".into()),
        );
        tools[0]
            .execute(
                json!({"path":"README.md"}),
                context("read", Path::new(&home)),
            )
            .await?;
        assert!(ran.load(Ordering::SeqCst));
        // The factory's dynamic policy follows settings between calls.
        let fixture = "factory-fixture-only-5290841";
        privacy::remember_secrets([fixture]);
        let tools = privacy::guard_tools(
            vec![Box::new(Recorder {
                name: "fixture_sender",
                ran: ran.clone(),
            })],
            Some("test-session".into()),
        );
        ran.store(false, Ordering::SeqCst);
        assert!(tools[0]
            .execute(
                json!({"text":fixture}),
                context("fixture_sender", Path::new(&home))
            )
            .await
            .is_err());
        assert!(!ran.load(Ordering::SeqCst));
        let settings = PrivacySettings {
            egress_allow: vec!["tool:fixture_sender".into()],
            ..PrivacySettings::default()
        };
        privacy::save_settings(settings).await?;
        tools[0]
            .execute(
                json!({"text":fixture}),
                context("fixture_sender", Path::new(&home)),
            )
            .await?;
        assert!(ran.load(Ordering::SeqCst));

        // Exercise the real assembler too: a source-code substring test can
        // pass when the guard call is merely present in a comment.
        privacy::save_settings(PrivacySettings::default()).await?;
        let mut config = evot::conf::Config::new(Path::new(&home).to_path_buf());
        config
            .providers
            .insert("fixture".into(), evot::conf::ProviderProfile {
                protocol: evot::conf::Protocol::OpenAi,
                api_key: "fixture-provider-key".into(),
                base_url: "https://example.invalid/v1".into(),
                models: vec!["fixture-model".into()],
                compat_caps: Default::default(),
                route_capabilities: Default::default(),
                thinking_level: None,
                context_window: None,
                max_tokens: None,
                supports_image: None,
            });
        let llm = config.build_llm("fixture", Some("fixture-model".into()))?;
        let session = evot::sessions::Session::new(
            "privacy-assembly-fixture".into(),
            Path::new(&home).to_string_lossy().into(),
            llm.model.clone(),
            Arc::new(evot::storage::MemoryStorage::new()),
        )
        .await?;
        let assembler = evot::agent::turn_assembler::TurnAssembler::new(&config);
        let turn = assembler
            .build_turn(
                &llm,
                evot::agent::ToolMode::Readonly,
                session,
                "privacy-assembly-fixture",
                evot::agent::turn_assembler::TurnBuildRequest {
                    input: vec![],
                    host_tools: None,
                    extra_tools: vec![Arc::new(Recorder {
                        name: "fixture_sender",
                        ran: ran.clone(),
                    })],
                    consume_process_notifications: false,
                    previous_llm: None,
                },
            )
            .await?;
        let tool = turn
            .options
            .tools
            .iter()
            .find(|t| t.name() == "fixture_sender")
            .ok_or("missing assembled tool")?;
        assert_eq!(tool.label(), "fixture_sender");
        assert_eq!(tool.parameters_schema(), json!({"type":"object"}));
        ran.store(false, Ordering::SeqCst);
        assert!(tool
            .execute(
                json!({"text":fixture}),
                context("fixture_sender", Path::new(&home))
            )
            .await
            .is_err());
        assert!(!ran.load(Ordering::SeqCst));
        tool.execute(
            json!({"text":"ordinary local fixture"}),
            context("fixture_sender", Path::new(&home)),
        )
        .await?;
        assert!(ran.load(Ordering::SeqCst));
        Ok::<_, Box<dyn std::error::Error>>(())
    })
}
