//! Internal worker tests live here, not inline with production logic.
use tokio_util::sync::CancellationToken;

use super::rules;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn cancelled_rule_scans_stop_without_a_result() -> TestResult {
    let dir = tempfile::tempdir()?;
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(rules::user_stamp(dir.path(), &cancel).is_err());
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
