//! Tests for PathGuard.

use evotengine::types::PathGuard;
use tempfile::TempDir;

fn make_restricted(dirs: &[&std::path::Path]) -> PathGuard {
    let canonical: Vec<_> = dirs.iter().map(|d| d.canonicalize().unwrap()).collect();
    PathGuard::restricted(canonical)
}

#[test]
fn open_allows_any_path() {
    let guard = PathGuard::open();
    assert!(!guard.is_restricted());
    let result = guard.resolve_path(std::path::Path::new("/tmp"), "/etc/passwd");
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), std::path::PathBuf::from("/etc/passwd"));
}

#[test]
fn open_resolves_relative_path() {
    let guard = PathGuard::open();
    let result = guard.resolve_path(std::path::Path::new("/tmp"), "relative/path");
    assert!(result.is_ok());
    assert_eq!(
        result.unwrap(),
        std::path::PathBuf::from("/tmp/relative/path")
    );
}

#[test]
fn restricted_allows_path_inside_allowed_dir() {
    let tmp = TempDir::new().unwrap();
    let sub = tmp.path().join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("file.txt"), "hello").unwrap();

    let guard = make_restricted(&[tmp.path()]);
    assert!(guard.is_restricted());
    assert!(guard
        .resolve_path(tmp.path(), &sub.join("file.txt").to_string_lossy())
        .is_ok());
}

#[test]
fn restricted_denies_path_outside_allowed_dir() {
    let allowed = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();

    let guard = make_restricted(&[allowed.path()]);
    let result = guard.resolve_path(
        allowed.path(),
        &outside.path().join("secret.txt").to_string_lossy(),
    );
    assert!(result.is_err());
    let err = format!("{}", result.unwrap_err());
    assert!(err.contains("Access denied"));
}

#[test]
fn restricted_denies_dot_dot_escape() {
    let allowed = TempDir::new().unwrap();
    let sub = allowed.path().join("sub");
    std::fs::create_dir_all(&sub).unwrap();

    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("escape.txt"), "escaped").unwrap();

    let guard = make_restricted(&[&sub]);
    let escape_path = format!(
        "{}/../../../{}/escape.txt",
        sub.display(),
        outside.path().display()
    );
    let result = guard.resolve_path(&sub, &escape_path);
    assert!(result.is_err());
}

#[test]
fn restricted_relative_path_resolved_against_base_dir() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("hello.txt"), "hi").unwrap();

    let guard = make_restricted(&[tmp.path()]);
    let result = guard.resolve_path(tmp.path(), "hello.txt");
    assert!(result.is_ok());
    // Should resolve to base_dir/hello.txt
    assert_eq!(result.unwrap(), tmp.path().join("hello.txt"));
}

#[test]
fn restricted_relative_path_outside_denied() {
    let allowed = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("nope.txt"), "no").unwrap();

    let guard = make_restricted(&[allowed.path()]);
    let result = guard.resolve_path(
        allowed.path(),
        &format!(
            "../{}/nope.txt",
            outside.path().file_name().unwrap().to_string_lossy()
        ),
    );
    assert!(result.is_err());
}

#[test]
fn resolve_optional_path_none_uses_base_dir() {
    let tmp = TempDir::new().unwrap();
    let guard = make_restricted(&[tmp.path()]);
    let result = guard.resolve_optional_path(tmp.path(), None);
    assert!(result.is_ok());
}

#[test]
fn resolve_optional_path_empty_uses_base_dir() {
    let tmp = TempDir::new().unwrap();
    let guard = make_restricted(&[tmp.path()]);
    assert!(guard.resolve_optional_path(tmp.path(), Some("")).is_ok());
}

#[test]
fn restricted_new_file_allowed_when_parent_in_allowlist() {
    let tmp = TempDir::new().unwrap();
    let guard = make_restricted(&[tmp.path()]);
    let new_file = tmp.path().join("new_file.txt");
    let result = guard.resolve_path(tmp.path(), &new_file.to_string_lossy());
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), new_file);
}

#[test]
fn restricted_new_file_multilevel_parent() {
    let tmp = TempDir::new().unwrap();
    let guard = make_restricted(&[tmp.path()]);
    let deep = tmp.path().join("a").join("b").join("c.txt");
    let result = guard.resolve_path(tmp.path(), &deep.to_string_lossy());
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), deep);
}

#[test]
fn restricted_new_file_denied_when_parent_outside() {
    let allowed = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let guard = make_restricted(&[allowed.path()]);
    let new_file = outside.path().join("new.txt");
    assert!(guard
        .resolve_path(allowed.path(), &new_file.to_string_lossy())
        .is_err());
}

#[cfg(unix)]
#[test]
fn restricted_symlink_inside_allowed() {
    let tmp = TempDir::new().unwrap();
    let real = tmp.path().join("real.txt");
    std::fs::write(&real, "content").unwrap();
    let link = tmp.path().join("link.txt");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let guard = make_restricted(&[tmp.path()]);
    assert!(guard
        .resolve_path(tmp.path(), &link.to_string_lossy())
        .is_ok());
}

#[cfg(unix)]
#[test]
fn restricted_symlink_escape_denied() {
    let allowed = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "secret").unwrap();

    let link = allowed.path().join("escape_link");
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    let guard = make_restricted(&[allowed.path()]);
    let result = guard.resolve_path(allowed.path(), &link.to_string_lossy());
    assert!(result.is_err());
}
