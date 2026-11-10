//! Module layering: a module may only use modules below its own layer.

use std::path::Path;

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Lowest layer first. Modules on the same line may not use each other.
const LAYERS: &[&[&str]] = &[
    &["base"],
    &["types"],
    &["auth"],
    &["conf"],
    &["observability", "privacy"],
    &["session"],
    &["cloud"],
    &["agent"],
    &["suggestion"],
    &["surface"],
    &["api"],
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
        let Some(owner) = relative.iter().next().and_then(|part| part.to_str()) else {
            continue;
        };
        let owner = owner.trim_end_matches(".rs");
        let Some(owner_layer) = layer_of(owner) else {
            continue;
        };
        let text = std::fs::read_to_string(&file)?;
        for line in text.lines() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for (at, _) in line.match_indices("crate::") {
                let used: String = line[at + "crate::".len()..]
                    .chars()
                    .take_while(|ch| ch.is_ascii_lowercase() || *ch == '_')
                    .collect();
                let Some(used_layer) = layer_of(&used) else {
                    continue;
                };
                if used != owner && used_layer >= owner_layer {
                    violations.push(format!("{} uses crate::{used}", relative.display()));
                }
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
