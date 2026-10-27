//! Internal worker tests live here, not inline with production logic.
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::masker::Masker;
use super::policy::PrivacySettings;
use super::rules;
use super::state::EgressState;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn taint_index_snapshots_are_constant_time_and_immutable() {
    let state = EgressState::default();
    state.taint("/workspace/a.txt");
    let before = state.names();
    assert!(Arc::ptr_eq(&before, &state.names()));
    state.taint("/workspace/b.txt");
    let after = state.names();
    assert!(!before.contains("b.txt"));
    assert!(after.contains("a.txt") && after.contains("b.txt"));
    assert!(state.is_tainted("/workspace/a.txt") && state.is_tainted("/workspace/b.txt"));
    assert!(Arc::ptr_eq(&after, &state.names()));
    state.taint("/workspace/a.txt");
    assert!(Arc::ptr_eq(&after, &state.names()));
}

#[test]
fn cancelled_rule_scans_and_guard_checks_stop_without_a_verdict() -> TestResult {
    let dir = tempfile::tempdir()?;
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(rules::user_stamp(dir.path(), &cancel).is_err());
    let masker = Masker::new(&PrivacySettings::default(), [44; 32])?;
    let fixture = "worker-fixture-only-6120377";
    masker.remember_secret(fixture);
    let args = serde_json::json!({"path":"x.txt","content":fixture});
    assert!(masker
        .check_call_cancellable("write", &args, dir.path(), &cancel)
        .is_err());
    // A cancelled call never ran, so the file it would have written is not tainted.
    let upload = serde_json::json!({"path":"x.txt"});
    assert!(masker
        .check_call("mcp_upload", &upload, dir.path())
        .is_empty());
    assert!(masker.shadow_summary() == Default::default());
    Ok(())
}

#[test]
fn user_pack_scans_are_sorted_skip_non_json_and_propagate_errors() -> TestResult {
    let dir = tempfile::tempdir()?;
    let cancel = CancellationToken::new();
    std::fs::write(
        dir.path().join("z.json"),
        r#"{"schema_version":1,"id":"z"}"#,
    )?;
    std::fs::write(
        dir.path().join("a.json"),
        r#"{"schema_version":1,"id":"a"}"#,
    )?;
    std::fs::write(dir.path().join("partial.tmp"), "invalid pending write")?;
    let stamp = rules::user_stamp(dir.path(), &cancel)?;
    assert_eq!(stamp.len(), 2);
    assert!(stamp[0].0.ends_with("a.json"));
    assert_eq!(rules::read_user_packs(&stamp, &cancel)?.len(), 2);
    std::fs::remove_file(&stamp[0].0)?;
    assert!(rules::read_user_packs(&stamp, &cancel).is_err());
    Ok(())
}
