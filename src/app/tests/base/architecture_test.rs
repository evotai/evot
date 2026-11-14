//! Module layering: a module may only use modules below its own layer, at the
//! crate root and inside the layered modules. The NAPI addon reaches this
//! crate only through `evot::api`.

use std::path::Path;
use std::path::PathBuf;

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Modules on one `Peers` line may not use each other. A `Group` is one unit
/// whose files use each other freely.
enum Layer {
    Peers(&'static [&'static str]),
    Group(&'static [&'static str]),
}

use Layer::Group;
use Layer::Peers;

/// A layered module: its path below `src` (empty for the crate root) and its
/// layers, lowest first. Mirrors the Layering section of AGENTS.md.
struct Scope {
    path: &'static [&'static str],
    layers: &'static [Layer],
}

const SCOPES: &[Scope] = &[
    Scope {
        path: &[],
        layers: &[
            Peers(&["base"]),
            Peers(&["types"]),
            Peers(&["auth"]),
            Peers(&["conf"]),
            Peers(&["observability", "privacy"]),
            Peers(&["session"]),
            Peers(&["cloud"]),
            Peers(&["agent"]),
            Peers(&["suggestion"]),
            Peers(&["surface"]),
            Peers(&["api"]),
        ],
    },
    Scope {
        path: &["session"],
        layers: &[
            Peers(&["conversation"]),
            Peers(&["storage"]),
            Peers(&["search"]),
            // Session state (`Session`, `SessionService`, ...).
            Group(&[
                "gates", "locator", "queries", "replay", "service", "session",
            ]),
            Peers(&["compact"]),
        ],
    },
    Scope {
        path: &["cloud"],
        layers: &[Peers(&["compute", "share"]), Peers(&["sync"])],
    },
    Scope {
        path: &["surface"],
        layers: &[
            Peers(&["delivery"]),
            Peers(&["gateway"]),
            Peers(&["automation", "acp", "contracts"]),
            Peers(&["service"]),
        ],
    },
];

impl Scope {
    /// Layer index and unit name of a direct child module.
    fn place(&self, module: &str) -> Option<(usize, &'static str)> {
        self.layers
            .iter()
            .enumerate()
            .find_map(|(index, layer)| match layer {
                Peers(names) => names
                    .iter()
                    .find(|name| **name == module)
                    .map(|name| (index, *name)),
                Group(names) => names
                    .contains(&module)
                    .then(|| (index, names.first().copied().unwrap_or_default())),
            })
    }

    fn display(&self) -> String {
        if self.path.is_empty() {
            "crate".into()
        } else {
            format!("crate::{}", self.path.join("::"))
        }
    }
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
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

/// Module path of a source file relative to its scope: `a.rs` and `a/mod.rs`
/// are `[a]`, `a/b.rs` is `[a, b]`.
fn module_path(relative: &Path) -> Vec<String> {
    let mut parts: Vec<String> = relative
        .iter()
        .filter_map(|part| part.to_str())
        .map(|part| part.trim_end_matches(".rs").to_string())
        .collect();
    if parts.last().is_some_and(|last| last == "mod") {
        parts.pop();
    }
    parts
}

fn ident(text: &str) -> String {
    text.chars()
        .take_while(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '_')
        .collect()
}

/// Direct children of the scope that `line` names, via `crate::<scope>::x`
/// or a `super::` chain that climbs back to the scope.
fn used_children(line: &str, scope: &Scope, module: &[String]) -> Vec<String> {
    let mut used = Vec::new();
    let prefix = format!("{}::", scope.display());
    for (at, _) in line.match_indices(&prefix) {
        let before = line[..at].chars().next_back();
        if before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ':') {
            continue;
        }
        used.push(ident(&line[at + prefix.len()..]));
    }
    for (at, _) in line.match_indices("super::") {
        let before = line[..at].chars().next_back();
        if before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ':') {
            continue;
        }
        let mut rest = &line[at..];
        let mut depth = 0;
        while let Some(next) = rest.strip_prefix("super::") {
            depth += 1;
            rest = next;
        }
        // `super` of a scope child is the scope itself.
        if depth == module.len() {
            used.push(ident(rest));
        }
    }
    used.retain(|name| !name.is_empty());
    used
}

#[test]
fn modules_only_depend_downward() -> TestResult {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    for scope in SCOPES {
        let root = scope
            .path
            .iter()
            .fold(src.clone(), |dir, part| dir.join(part));
        let mut files = Vec::new();
        collect(&root, &mut files)?;
        for file in files {
            let relative = file.strip_prefix(&root)?;
            let module = module_path(relative);
            let Some(owner) = module.first() else {
                continue;
            };
            let Some((owner_layer, owner_unit)) = scope.place(owner) else {
                continue;
            };
            let text = std::fs::read_to_string(&file)?;
            for line in text.lines() {
                let trimmed = line.trim_start();
                if trimmed.starts_with("//") {
                    continue;
                }
                for used in used_children(line, scope, &module) {
                    let Some((used_layer, used_unit)) = scope.place(&used) else {
                        continue;
                    };
                    if used_unit != owner_unit && used_layer >= owner_layer {
                        violations.push(format!(
                            "{}/{} uses {}::{used}",
                            scope.display(),
                            relative.display(),
                            scope.display()
                        ));
                    }
                }
            }
        }
    }
    violations.sort();
    violations.dedup();
    assert!(
        violations.is_empty(),
        "upward or sideways dependencies:\n{}",
        violations.join("\n")
    );
    Ok(())
}

#[test]
fn every_layered_child_is_declared() -> TestResult {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut undeclared = Vec::new();
    for scope in SCOPES {
        let root = scope
            .path
            .iter()
            .fold(src.clone(), |dir, part| dir.join(part));
        for entry in std::fs::read_dir(&root)? {
            let path = entry?.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let module = name.trim_end_matches(".rs");
            let is_module = path.is_dir() || name.ends_with(".rs");
            if !is_module || matches!(module, "mod" | "lib") {
                continue;
            }
            if scope.place(module).is_none() {
                undeclared.push(format!("{}::{module}", scope.display()));
            }
        }
    }
    assert!(
        undeclared.is_empty(),
        "modules missing from the layer table:\n{}",
        undeclared.join("\n")
    );
    Ok(())
}

#[test]
fn addon_uses_only_the_api_facade() -> TestResult {
    let addon = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cli/addon/src");
    let mut files = Vec::new();
    collect(&addon, &mut files)?;
    assert!(!files.is_empty(), "addon sources not found at {addon:?}");
    let mut bypasses = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file)?;
        for (number, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for (at, _) in line.match_indices("evot::") {
                let before = line[..at].chars().next_back();
                if before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ':') {
                    continue;
                }
                if !line[at..].starts_with("evot::api::") {
                    bypasses.push(format!(
                        "{}:{}: {}",
                        file.strip_prefix(&addon)?.display(),
                        number + 1,
                        line.trim()
                    ));
                }
            }
        }
    }
    assert!(
        bypasses.is_empty(),
        "addon must reach the app through evot::api:\n{}",
        bypasses.join("\n")
    );
    Ok(())
}
