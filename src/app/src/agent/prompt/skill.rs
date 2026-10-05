use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Builtin skills — compiled into the binary via include_str!()
// ---------------------------------------------------------------------------

struct BuiltinDef {
    name: &'static str,
    content: &'static str,
}

// A skill is builtin only when evot itself dispatches to it by name:
// `/harden`, `/clip all`, and `/sessions <query>`. Everything else ships
// in the evot-skills catalog and is installed on demand.
const BUILTINS: &[BuiltinDef] = &[
    BuiltinDef {
        name: "harden",
        content: include_str!("prompts/harden.md"),
    },
    BuiltinDef {
        name: "memory",
        content: include_str!("prompts/memory.md"),
    },
    BuiltinDef {
        name: "session-search",
        content: include_str!("prompts/session-search.md"),
    },
];

const MAX_GROUP_DEPTH: usize = 1;

// ---------------------------------------------------------------------------
// SkillSpec
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SkillSpec {
    pub name: String,
    pub description: String,
    pub file_path: PathBuf,
    pub base_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum SkillLoadError {
    #[error("IO error reading {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("SKILL.md in {path} missing required frontmatter field: {field}")]
    MissingField { path: PathBuf, field: &'static str },
    #[error("SKILL.md in {path} has invalid frontmatter: {detail}")]
    InvalidFrontmatter { path: PathBuf, detail: String },
    #[error("cannot resolve builtin skills directory: {0}")]
    BuiltinDir(String),
    #[error("unknown skill '{name}'. Available: {available}")]
    UnknownSkill { name: String, available: String },
}

// ---------------------------------------------------------------------------
// Public loader — builtin first, then filesystem (same name overrides)
// ---------------------------------------------------------------------------

pub fn load_skills(dirs: &[impl AsRef<Path>]) -> Result<Vec<SkillSpec>, SkillLoadError> {
    let builtin_dir = ensure_builtin_skills_dir()?;
    let mut all_dirs = vec![builtin_dir];
    for dir in dirs {
        let dir = dir.as_ref().to_path_buf();
        if !all_dirs.contains(&dir) {
            all_dirs.push(dir);
        }
    }

    let mut by_name: HashMap<String, SkillSpec> = HashMap::new();
    for dir in &all_dirs {
        if !dir.exists() {
            continue;
        }
        match load_skills_from_dir_lenient(dir) {
            Ok((specs, errors)) => {
                for spec in specs {
                    by_name.insert(spec.name.clone(), spec);
                }
                for error in errors {
                    tracing::warn!("failed to load skill from {}: {error}", dir.display());
                }
            }
            Err(error) => {
                tracing::warn!("failed to scan skills directory {}: {error}", dir.display());
            }
        }
    }

    let mut specs: Vec<SkillSpec> = by_name.into_values().collect();
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(specs)
}

pub fn load_skills_by_name(
    dirs: &[impl AsRef<Path>],
    names: &[String],
) -> Result<Vec<SkillSpec>, SkillLoadError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let skills = load_skills(dirs)?;
    let available = skills
        .iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    let mut by_name: HashMap<String, SkillSpec> = skills
        .into_iter()
        .map(|skill| (skill.name.clone(), skill))
        .collect();
    let mut selected = Vec::with_capacity(names.len());
    for name in names {
        let Some(skill) = by_name.remove(name) else {
            return Err(SkillLoadError::UnknownSkill {
                name: name.clone(),
                available: available.join(", "),
            });
        };
        selected.push(skill);
    }
    selected.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(selected)
}

/// Load one named skill using the same builtin/filesystem precedence as the
/// runtime. This is used by gateway commands that pre-activate a workflow.
pub fn load_skill(dirs: &[impl AsRef<Path>], name: &str) -> Result<SkillSpec, SkillLoadError> {
    let mut selected = load_skills_by_name(dirs, &[name.to_string()])?;
    selected.pop().ok_or_else(|| SkillLoadError::UnknownSkill {
        name: name.to_string(),
        available: String::new(),
    })
}

pub fn load_skill_instructions(skill: &SkillSpec) -> Result<String, SkillLoadError> {
    let content = fs::read_to_string(&skill.file_path).map_err(|source| SkillLoadError::Io {
        path: skill.file_path.clone(),
        source,
    })?;
    Ok(strip_frontmatter(&content).to_string())
}

/// Load skills from filesystem directories only (no builtins).
pub fn load_fs_skills(dirs: &[impl AsRef<Path>]) -> Result<Vec<SkillSpec>, SkillLoadError> {
    let mut by_name: HashMap<String, SkillSpec> = HashMap::new();

    for dir in dirs {
        let dir = dir.as_ref();
        if !dir.exists() {
            continue;
        }
        let specs = load_skills_from_dir(dir)?;
        for spec in specs {
            by_name.insert(spec.name.clone(), spec);
        }
    }

    let mut specs: Vec<SkillSpec> = by_name.into_values().collect();
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(specs)
}

/// XML skill index for the system prompt. Empty when there are no skills.
pub fn format_skills_for_prompt(skills: &[SkillSpec]) -> String {
    if skills.is_empty() {
        return String::new();
    }

    let mut lines = vec![
        "The following skills provide specialized instructions for specific tasks.".to_string(),
        "Use the read tool to load a skill's file when the task matches its description.".to_string(),
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.".to_string(),
        String::new(),
        "<available_skills>".to_string(),
    ];
    for skill in skills {
        lines.push("  <skill>".into());
        lines.push(format!("    <name>{}</name>", escape_xml(&skill.name)));
        lines.push(format!(
            "    <description>{}</description>",
            escape_xml(&skill.description)
        ));
        lines.push(format!(
            "    <location>{}</location>",
            escape_xml(&skill.file_path.display().to_string())
        ));
        lines.push("  </skill>".into());
    }
    lines.push("</available_skills>".into());
    lines.join("\n")
}

pub fn ensure_builtin_skills_dir() -> Result<PathBuf, SkillLoadError> {
    let root = builtin_skills_dir()?;
    fs::create_dir_all(&root).map_err(|source| SkillLoadError::Io {
        path: root.clone(),
        source,
    })?;

    for def in BUILTINS {
        let skill_dir = root.join(def.name);
        fs::create_dir_all(&skill_dir).map_err(|source| SkillLoadError::Io {
            path: skill_dir.clone(),
            source,
        })?;
        let file_path = skill_dir.join("SKILL.md");
        write_if_changed(&file_path, def.content)?;
        parse_frontmatter(def.content, &file_path)?;
    }
    remove_stale_builtins(&root)?;
    Ok(root)
}

/// Drop directories left behind by a skill that is no longer builtin.
///
/// This directory is entirely evot-owned — `write_if_changed` already overwrites
/// edits — so a name that left `BUILTINS` must not linger. A stale copy would
/// keep loading from an upgraded binary and collide with the catalog version the
/// user installs into `~/.evotai/skills`.
fn remove_stale_builtins(root: &Path) -> Result<(), SkillLoadError> {
    let entries = fs::read_dir(root).map_err(|source| SkillLoadError::Io {
        path: root.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| SkillLoadError::Io {
            path: root.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let is_builtin = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| BUILTINS.iter().any(|def| def.name == name));
        if is_builtin {
            continue;
        }
        // A concurrent evot start may have removed it already; that is the
        // outcome we wanted either way.
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(SkillLoadError::Io {
                    path: path.clone(),
                    source,
                })
            }
        }
    }
    Ok(())
}

fn builtin_skills_dir() -> Result<PathBuf, SkillLoadError> {
    crate::conf::paths::state_root_dir()
        .map(|root| root.join("builtin-skills"))
        .map_err(|error| SkillLoadError::BuiltinDir(error.to_string()))
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), SkillLoadError> {
    if fs::read_to_string(path).is_ok_and(|current| current == content) {
        return Ok(());
    }

    let temp_path = path.with_extension(format!(
        "tmp-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    fs::write(&temp_path, content).map_err(|source| SkillLoadError::Io {
        path: temp_path.clone(),
        source,
    })?;
    fs::rename(&temp_path, path).map_err(|source| SkillLoadError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn load_skills_from_dir(dir: &Path) -> Result<Vec<SkillSpec>, SkillLoadError> {
    let (specs, errors) = load_skills_from_dir_lenient(dir)?;
    match errors.into_iter().next() {
        Some(error) => Err(error),
        None => Ok(specs),
    }
}

fn load_skills_from_dir_lenient(
    dir: &Path,
) -> Result<(Vec<SkillSpec>, Vec<SkillLoadError>), SkillLoadError> {
    let mut specs = Vec::new();
    let mut errors = Vec::new();
    scan_dir(dir, 0, &mut specs, &mut errors)?;
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((specs, errors))
}

fn scan_dir(
    dir: &Path,
    depth: usize,
    specs: &mut Vec<SkillSpec>,
    errors: &mut Vec<SkillLoadError>,
) -> Result<(), SkillLoadError> {
    let read = fs::read_dir(dir).map_err(|e| SkillLoadError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    let mut paths = Vec::new();
    for entry in read {
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(source) => errors.push(SkillLoadError::Io {
                path: dir.to_path_buf(),
                source,
            }),
        }
    }
    paths.sort();

    for path in paths {
        if !path.is_dir() || is_hidden(&path) {
            continue;
        }

        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            if depth < MAX_GROUP_DEPTH {
                if let Err(error) = scan_dir(&path, depth + 1, specs, errors) {
                    errors.push(error);
                }
            }
            continue;
        }

        match load_skill_spec(&path, &skill_md) {
            Ok(spec) => {
                if let Some(previous) = specs.iter().find(|existing| existing.name == spec.name) {
                    tracing::warn!(
                        "duplicate skill '{}': {} overrides {}",
                        spec.name,
                        spec.base_dir.display(),
                        previous.base_dir.display(),
                    );
                }
                specs.retain(|existing| existing.name != spec.name);
                specs.push(spec);
            }
            Err(error) => errors.push(error),
        }
    }

    Ok(())
}

fn load_skill_spec(dir: &Path, skill_md: &Path) -> Result<SkillSpec, SkillLoadError> {
    let content = fs::read_to_string(skill_md).map_err(|source| SkillLoadError::Io {
        path: skill_md.to_path_buf(),
        source,
    })?;
    let description = parse_frontmatter(&content, skill_md)?;
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(SkillSpec {
        name,
        description,
        file_path: fs::canonicalize(skill_md).unwrap_or_else(|_| skill_md.to_path_buf()),
        base_dir: fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()),
    })
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    description: Option<String>,
}

fn split_frontmatter(content: &str) -> Result<(&str, &str), &'static str> {
    let trimmed = content.trim_start();
    let after_open = trimmed
        .strip_prefix("---\r\n")
        .or_else(|| trimmed.strip_prefix("---\n"))
        .ok_or("missing opening ---")?;

    let mut offset = 0;
    for segment in after_open.split_inclusive('\n') {
        let line = segment.trim_end_matches(['\r', '\n']);
        if line == "---" {
            return Ok((&after_open[..offset], &after_open[offset + segment.len()..]));
        }
        offset += segment.len();
    }

    Err("missing closing ---")
}

fn parse_frontmatter(content: &str, path: &Path) -> Result<String, SkillLoadError> {
    let (yaml_block, _) =
        split_frontmatter(content).map_err(|detail| SkillLoadError::InvalidFrontmatter {
            path: path.to_path_buf(),
            detail: detail.into(),
        })?;
    let frontmatter: SkillFrontmatter =
        serde_yaml::from_str(yaml_block).map_err(|error| SkillLoadError::InvalidFrontmatter {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
    let description = frontmatter
        .description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(SkillLoadError::MissingField {
            path: path.to_path_buf(),
            field: "description",
        })?;

    Ok(description)
}

fn strip_frontmatter(content: &str) -> &str {
    split_frontmatter(content)
        .map(|(_, body)| body)
        .unwrap_or(content)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(crate) fn load_turn_skills(
    dirs: &[PathBuf],
    names: Option<&[String]>,
) -> crate::error::Result<Vec<SkillSpec>> {
    match names {
        Some(names) => load_skills_by_name(dirs, names),
        None => load_skills(dirs),
    }
    .map_err(|error| crate::error::EvotError::Agent(format!("failed to load skills: {error}")))
}

pub(crate) fn skills_prompt_section(skills: &[SkillSpec]) -> Option<super::Section> {
    let text = format_skills_for_prompt(skills);
    if text.is_empty() {
        None
    } else {
        Some(super::Section {
            name: "skills",
            text,
        })
    }
}
