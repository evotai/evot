//! Module layering: a module may only use modules at or below its own layer.

use std::path::Path;

#[path = "support/dependency_paths.rs"]
mod dependency_paths;

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Lowest layer first. Modules on the same line may not use each other.
const LAYERS: &[&[&str]] = &[
    &["time", "media", "spill"],
    &["types"],
    &["provider"],
    &["context", "retry"],
    &["event", "tools", "host"],
    &["runner"],
    &["agent"],
];

fn layer_of(module: &str) -> Option<usize> {
    LAYERS.iter().position(|layer| layer.contains(&module))
}

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(&path, out)?;
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

#[test]
fn modules_only_depend_downward() -> TestResult {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect(&src, &mut files)?;
    let mut violations = Vec::new();
    for file in files {
        let relative = file.strip_prefix(&src)?;
        let module = dependency_paths::module_path(relative);
        let Some(owner) = module.first() else {
            continue;
        };
        let Some(owner_layer) = layer_of(owner) else {
            violations.push(format!("undeclared module: {owner}"));
            continue;
        };
        let text = std::fs::read_to_string(&file)?;
        for path in dependency_paths::dependencies(&text, &module)? {
            let Some(used) = path.first() else { continue };
            if used != owner && layer_of(used).is_some_and(|layer| layer >= owner_layer) {
                violations.push(format!("{} uses crate::{used}", relative.display()));
            }
        }
    }
    violations.sort();
    violations.dedup();
    assert!(
        violations.is_empty(),
        "upward dependencies:\n{}",
        violations.join("\n")
    );
    Ok(())
}
