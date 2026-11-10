use evot::types::is_valid_id;
use evot::types::new_id;

// Session/run IDs are joined into filesystem paths at the storage layer, so a
// valid ID must never contain path separators or traversal sequences. These
// tests lock in the rule that closes the dashboard path-traversal hole.

#[test]
fn accepts_generated_uuid_v7() {
    let id = new_id();
    assert!(is_valid_id(&id), "generated id should be valid: {id}");
}

#[test]
fn accepts_legacy_short_hex() {
    assert!(is_valid_id("0089abd1"));
}

#[test]
fn rejects_empty() {
    assert!(!is_valid_id(""));
}

#[test]
fn rejects_path_traversal() {
    assert!(!is_valid_id("../../../etc/passwd"));
    assert!(!is_valid_id("..%2f..%2fetc"));
    assert!(!is_valid_id("foo/bar"));
    assert!(!is_valid_id("foo\\bar"));
    assert!(!is_valid_id(".."));
    assert!(!is_valid_id("a.b"));
}

#[test]
fn rejects_overlong() {
    assert!(!is_valid_id(&"a".repeat(65)));
}
