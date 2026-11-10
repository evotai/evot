use std::fs;
use std::path::Path;

use evot::agent::prompt::skill::ensure_builtin_skills_dir;
use evot::agent::prompt::skill::format_skills_for_prompt;
use evot::agent::prompt::skill::load_fs_skills;
use evot::agent::prompt::skill::load_skills;
use evot::agent::prompt::skill::load_skills_by_name;
use evot::agent::prompt::skill::SkillLoadError;
use tempfile::TempDir;

fn create_skill(dir: &Path, name: &str, description: &str) {
    let skill_dir = dir.join(name);
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        format!(
            "---\nname: {name}\ndescription: {description}\n---\n\n# Instructions\n\nDo stuff.\n"
        ),
    )
    .unwrap();
}
#[test]
fn load_from_directory() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "weather", "Get weather");
    create_skill(tmp.path(), "git", "Git ops");

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[0].name, "git");
    assert_eq!(specs[1].name, "weather");
    assert_eq!(specs[1].description, "Get weather");
    assert!(std::fs::read_to_string(&specs[1].file_path)?.contains("# Instructions"));
    Ok(())
}

#[test]
fn loads_folded_yaml_description() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let skill_dir = tmp.path().join("folded");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: folded\ndescription: >-\n  Search prior incidents and\n  recall durable findings.\n---\n\nBody.\n",
    )?;

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    assert_eq!(
        specs[0].description,
        "Search prior incidents and recall durable findings."
    );
    Ok(())
}

#[test]
fn handles_crlf_frontmatter() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let skill_dir = tmp.path().join("crlf");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\r\nname: crlf\r\ndescription: CRLF skill\r\n---\r\n\r\n# Body\r\n",
    )?;

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    assert_eq!(specs[0].description, "CRLF skill");
    assert_eq!(
        evot::agent::prompt::skill::load_skill_instructions(&specs[0])?,
        "\r\n# Body\r\n"
    );
    Ok(())
}

#[test]
fn name_comes_from_directory_not_frontmatter() {
    let tmp = TempDir::new().unwrap();
    let skill_dir = tmp.path().join("my-tool");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: different-name\ndescription: A tool\n---\n\nBody.\n",
    )
    .unwrap();

    let specs = load_fs_skills(&[tmp.path().to_path_buf()]).unwrap();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].name, "my-tool");
}

#[test]
fn later_dirs_override_earlier() {
    let dir1 = TempDir::new().unwrap();
    let dir2 = TempDir::new().unwrap();
    create_skill(dir1.path(), "weather", "Old weather");
    create_skill(dir2.path(), "weather", "New weather");

    let specs = load_fs_skills(&[dir1.path().to_path_buf(), dir2.path().to_path_buf()]).unwrap();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].description, "New weather");
}

#[test]
fn skips_nonexistent_dirs() {
    let specs = load_fs_skills(&[std::path::PathBuf::from("/nonexistent/path")]).unwrap();
    assert!(specs.is_empty());
}

#[test]
fn skips_dirs_without_skill_md() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("empty-skill")).unwrap();

    let specs = load_fs_skills(&[tmp.path().to_path_buf()]).unwrap();
    assert!(specs.is_empty());
}

#[test]
fn error_on_missing_frontmatter() {
    let tmp = TempDir::new().unwrap();
    let skill_dir = tmp.path().join("bad");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "No frontmatter here.").unwrap();

    let err = load_fs_skills(&[tmp.path().to_path_buf()]).unwrap_err();
    assert!(matches!(err, SkillLoadError::InvalidFrontmatter { .. }));
}

#[test]
fn error_on_missing_description() {
    let tmp = TempDir::new().unwrap();
    let skill_dir = tmp.path().join("bad");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "---\nname: bad\n---\n\nBody.\n").unwrap();

    let err = load_fs_skills(&[tmp.path().to_path_buf()]).unwrap_err();
    assert!(matches!(err, SkillLoadError::MissingField { .. }));
}

#[test]
fn error_on_empty_description() {
    let tmp = TempDir::new().unwrap();
    let skill_dir = tmp.path().join("bad");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: bad\ndescription:\n---\n\nBody.\n",
    )
    .unwrap();

    let err = load_fs_skills(&[tmp.path().to_path_buf()]).unwrap_err();
    assert!(matches!(err, SkillLoadError::MissingField { .. }));
}

#[test]
fn strips_frontmatter_from_instructions() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "test-skill", "A test");

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    let instructions = evot::agent::prompt::skill::load_skill_instructions(&specs[0])?;
    assert!(!instructions.contains("---"));
    assert!(instructions.contains("# Instructions"));
    Ok(())
}

#[test]
fn handles_quoted_description() {
    let tmp = TempDir::new().unwrap();
    let skill_dir = tmp.path().join("quoted");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: quoted\ndescription: \"A quoted desc\"\n---\n\nBody.\n",
    )
    .unwrap();

    let specs = load_fs_skills(&[tmp.path().to_path_buf()]).unwrap();
    assert_eq!(specs[0].description, "A quoted desc");
}

// ---------------------------------------------------------------------------
// Nested group tests
// ---------------------------------------------------------------------------

#[test]
fn nested_group_skill_loads() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(&tmp.path().join("lark"), "lark-im", "Lark IM");

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].name, "lark-im");
    assert!(specs[0].base_dir.ends_with("lark/lark-im"));
    assert!(specs[0].file_path.ends_with("lark/lark-im/SKILL.md"));
    Ok(())
}

#[test]
fn group_dir_is_not_a_skill() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let group = tmp.path().join("lark");
    create_skill(&group, "lark-im", "Lark IM");
    fs::write(group.join("README.md"), "group readme")?;

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["lark-im"]);
    Ok(())
}

#[test]
fn third_level_is_not_scanned() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(&tmp.path().join("a").join("b"), "deep", "Too deep");

    assert!(load_fs_skills(&[tmp.path().to_path_buf()])?.is_empty());
    Ok(())
}

#[test]
fn hidden_dirs_are_skipped() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), ".weather.install-123", "Staging copy");
    create_skill(&tmp.path().join(".staging"), "nested", "Hidden group");

    assert!(load_fs_skills(&[tmp.path().to_path_buf()])?.is_empty());
    Ok(())
}

#[test]
fn flat_and_nested_mixed() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "databend-cloud", "Databend");
    create_skill(&tmp.path().join("lark"), "lark-im", "Lark IM");
    create_skill(&tmp.path().join("lark"), "lark-shared", "Lark shared");

    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["databend-cloud", "lark-im", "lark-shared"]);
    Ok(())
}

#[test]
fn nested_name_collision_later_dir_wins() -> Result<(), Box<dyn std::error::Error>> {
    let dir1 = TempDir::new()?;
    let dir2 = TempDir::new()?;
    create_skill(dir1.path(), "lark-im", "Flat old");
    create_skill(&dir2.path().join("lark"), "lark-im", "Grouped new");

    let specs = load_fs_skills(&[dir1.path().to_path_buf(), dir2.path().to_path_buf()])?;
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].description, "Grouped new");
    Ok(())
}

#[test]
fn same_root_collision_resolves_by_sorted_path() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(&tmp.path().join("a"), "dup", "From a");
    create_skill(&tmp.path().join("b"), "dup", "From b");

    for _ in 0..5 {
        let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].description, "From b");
        assert!(specs[0].base_dir.ends_with("b/dup"));
    }
    Ok(())
}

#[test]
fn nested_frontmatter_error_keeps_valid_siblings() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let group = tmp.path().join("lark");
    create_skill(&group, "lark-im", "Lark IM");
    let bad = group.join("lark-bad");
    fs::create_dir_all(&bad)?;
    fs::write(bad.join("SKILL.md"), "no frontmatter")?;

    let specs = load_skills(&[tmp.path().to_path_buf()])?;
    assert!(specs.iter().any(|s| s.name == "lark-im"));
    assert!(specs.iter().any(|s| s.name == "harden"));
    assert!(specs.iter().all(|s| s.name != "lark-bad"));
    Ok(())
}

// ---------------------------------------------------------------------------
// Builtin skill tests
// ---------------------------------------------------------------------------

#[test]
fn builtin_directory_contains_all_builtin_skills() -> Result<(), Box<dyn std::error::Error>> {
    let root = ensure_builtin_skills_dir()?;
    for name in ["harden", "memory", "session-search"] {
        assert!(root.join(name).join("SKILL.md").is_file());
    }
    Ok(())
}

#[test]
fn all_builtin_skills_load() -> Result<(), Box<dyn std::error::Error>> {
    let empty: Vec<std::path::PathBuf> = vec![];
    let specs = load_skills(&empty)?;
    let names: Vec<&str> = specs.iter().map(|skill| skill.name.as_str()).collect();

    assert_eq!(names, vec!["harden", "memory", "session-search"]);
    assert!(specs.iter().all(|skill| !skill.description.is_empty()));
    Ok(())
}

#[test]
fn stale_builtin_dirs_are_removed() -> Result<(), Box<dyn std::error::Error>> {
    const CHILD: &str = "EVOT_STALE_BUILTIN_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let output = std::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "skill_loader_test::stale_builtin_dirs_are_removed",
                "--nocapture",
            ])
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env(CHILD, "1")
            .output()?;
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }
    // `opencli` and `humanize` moved to the evot-skills catalog. An upgraded
    // binary must clear the copies it wrote in an earlier version, or they keep
    // loading and collide with the installed ones.
    let root = ensure_builtin_skills_dir()?;
    let stale = root.join("opencli");
    fs::create_dir_all(&stale)?;
    fs::write(
        stale.join("SKILL.md"),
        "---\nname: opencli\ndescription: stale\n---\n",
    )?;

    let root = ensure_builtin_skills_dir()?;
    assert!(!stale.exists(), "stale builtin dir should be removed");
    for name in ["harden", "memory", "session-search"] {
        assert!(root.join(name).join("SKILL.md").is_file());
    }
    Ok(())
}

#[test]
fn builtin_harden_skill_loaded() -> Result<(), Box<dyn std::error::Error>> {
    let empty: Vec<std::path::PathBuf> = vec![];
    let specs = load_skills(&empty)?;
    let harden = match specs.iter().find(|s| s.name == "harden") {
        Some(skill) => skill,
        None => return Err("builtin harden skill should be present".into()),
    };
    assert!(!harden.description.is_empty());
    assert!(std::fs::read_to_string(&harden.file_path)?.contains("# Harden"));
    assert!(harden.file_path.ends_with("harden/SKILL.md"));
    Ok(())
}

#[test]
fn builtin_memory_skill_loaded() -> Result<(), Box<dyn std::error::Error>> {
    let empty: Vec<std::path::PathBuf> = vec![];
    let specs = load_skills(&empty)?;
    let memory = match specs.iter().find(|s| s.name == "memory") {
        Some(skill) => skill,
        None => return Err("builtin memory skill should be present".into()),
    };
    assert!(!memory.description.is_empty());
    assert!(memory.description.contains("/clip all"));
    let instructions = evot::agent::prompt::skill::load_skill_instructions(memory)?;
    assert!(instructions.contains("# Memory"));
    assert!(instructions.contains(".evotai/memory"));
    assert!(memory.file_path.ends_with("memory/SKILL.md"));
    Ok(())
}

#[test]
fn fs_skill_overrides_builtin() {
    let tmp = TempDir::new().unwrap();
    create_skill(tmp.path(), "harden", "Custom harden");

    let specs = load_skills(&[tmp.path().to_path_buf()]).unwrap();
    let harden = specs.iter().find(|s| s.name == "harden").unwrap();
    assert_eq!(harden.description, "Custom harden");
    assert!(
        harden.file_path.ends_with("harden/SKILL.md"),
        "fs skill should point at SKILL.md"
    );
}

#[test]
fn filesystem_skill_error_does_not_drop_builtins_or_valid_siblings(
) -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    let skill_dir = tmp.path().join("bad");
    fs::create_dir_all(&skill_dir)?;
    fs::write(skill_dir.join("SKILL.md"), "No frontmatter here.")?;
    create_skill(tmp.path(), "valid", "Valid sibling");

    let specs = load_skills(&[tmp.path().to_path_buf()])?;
    assert!(specs.iter().any(|s| s.name == "harden"));
    assert!(specs.iter().any(|s| s.name == "memory"));
    assert!(specs.iter().any(|s| s.name == "valid"));
    assert!(specs.iter().all(|s| s.name != "bad"));
    Ok(())
}

#[test]
fn selected_skills_can_mix_builtin_and_filesystem() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "custom", "Custom skill");
    let names = vec!["harden".to_string(), "custom".to_string()];

    let specs = load_skills_by_name(&[tmp.path().to_path_buf()], &names)?;
    let loaded: Vec<&str> = specs.iter().map(|skill| skill.name.as_str()).collect();
    assert_eq!(loaded, vec!["custom", "harden"]);
    Ok(())
}

#[test]
fn load_single_skill_uses_runtime_precedence() -> Result<(), Box<dyn std::error::Error>> {
    use evot::agent::prompt::skill::load_skill;

    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "memory", "Custom memory workflow");

    let memory = load_skill(&[tmp.path().to_path_buf()], "memory")?;
    assert_eq!(memory.description, "Custom memory workflow");
    assert!(memory.file_path.ends_with("memory/SKILL.md"));
    Ok(())
}

#[test]
fn empty_skill_selection_loads_nothing() -> Result<(), Box<dyn std::error::Error>> {
    let empty: Vec<std::path::PathBuf> = Vec::new();
    assert!(load_skills_by_name(&empty, &[])?.is_empty());
    Ok(())
}

#[test]
fn unknown_selected_skill_returns_error() {
    let empty: Vec<std::path::PathBuf> = Vec::new();
    let error = load_skills_by_name(&empty, &["missing".to_string()])
        .expect_err("missing skill should fail");
    assert!(error.to_string().contains("unknown skill 'missing'"));
}

#[test]
fn filtered_skill_index_contains_only_selected_names() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "alpha", "Alpha skill");
    create_skill(tmp.path(), "beta", "Beta skill");

    let selected = load_skills_by_name(&[tmp.path().to_path_buf()], &["beta".to_string()])?;
    let prompt = format_skills_for_prompt(&selected);
    assert!(prompt.contains("<name>beta</name>"));
    assert!(!prompt.contains("<name>alpha</name>"));
    assert!(!prompt.contains("<name>memory</name>"));
    Ok(())
}

#[test]
fn empty_skill_index_is_omitted() {
    assert!(format_skills_for_prompt(&[]).is_empty());
}

#[test]
fn formats_skill_index_for_prompt() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = TempDir::new()?;
    create_skill(tmp.path(), "weather", "Get weather");
    let specs = load_fs_skills(&[tmp.path().to_path_buf()])?;
    let prompt = format_skills_for_prompt(&specs);
    assert!(prompt.contains("<available_skills>"));
    assert!(prompt.contains("<name>weather</name>"));
    assert!(prompt.contains("<description>Get weather</description>"));
    assert!(prompt.contains("<location>"));
    assert!(prompt.contains("SKILL.md"));
    assert!(prompt.contains("Use the read tool to load a skill's file"));
    Ok(())
}
