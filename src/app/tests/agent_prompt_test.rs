use evot::agent::prompt::dynamic_sections;
use evot::agent::prompt::DynamicContext;
use evot::agent::prompt::PromptMode;
use evot::agent::prompt::Section;
use evot::agent::prompt::SystemPrompt;
use evot::agent::Agent;
use evot::conf::Config;

/// Default coding tool set (read, bash, edit, write), mirroring production.
fn coding_tools() -> Vec<Box<dyn evot_engine::AgentTool>> {
    use evot_engine::tools::BashTool;
    use evot_engine::tools::EditFileTool;
    use evot_engine::tools::ReadFileTool;
    use evot_engine::tools::WriteFileTool;
    vec![
        Box::new(ReadFileTool::default()),
        Box::new(BashTool::default()),
        Box::new(EditFileTool::new()),
        Box::new(WriteFileTool::new()),
    ]
}

fn base_prompt(cwd: &str) -> String {
    SystemPrompt::base(cwd, &coding_tools(), "").0
}

fn names(sections: &[Section]) -> Vec<&'static str> {
    sections.iter().map(|s| s.name).collect()
}

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[test]
fn base_prompt_matches_pi_structure() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let prompt = base_prompt(&tmp.path().to_string_lossy());
    assert!(prompt.starts_with(
        "You are an expert coding assistant running in evot, a coding agent harness."
    ));
    assert!(prompt.contains("Available tools:"));
    assert!(prompt.contains("Guidelines:"));
    assert!(prompt.contains("Be concise in your responses"));
    assert!(prompt.contains("Current working directory:"));
    assert!(!prompt.contains("Current date:"));
    assert!(!prompt.contains("<project_context>"));
}

#[test]
fn base_prompt_uses_pi_conciseness_guideline_only() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let prompt = base_prompt(&tmp.path().to_string_lossy());

    assert!(prompt.contains("Be concise in your responses"));
    assert!(!prompt.contains("concise, direct, and proportional to the task"));
    assert!(!prompt.contains("Lead with the outcome, not a chronological account"));
    assert!(!prompt.contains("Your responses render as GitHub-flavored markdown"));
}

#[test]
fn base_prompt_includes_parallel_tool_calls_guideline() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let prompt = base_prompt(&tmp.path().to_string_lossy());

    let parallel_pos = prompt
        .find("emit multiple separate tool calls in the same response")
        .expect("missing parallel tool-calls guideline");
    let concise_pos = prompt
        .find("Be concise in your responses")
        .expect("missing conciseness guideline");
    assert!(
        parallel_pos < concise_pos,
        "parallel guideline should precede the trailer guidelines"
    );
    assert!(
        prompt
            .contains("never pass an array of argument objects to a tool that expects one object"),
        "parallel guidance must explicitly reject array-batched arguments"
    );
    assert!(
        !prompt.contains("make them together in one response"),
        "ambiguous 'together' wording invites array-batched arguments"
    );
}

#[test]
fn reads_single_context_file() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    std::fs::write(tmp.path().join("EVOT.md"), "# My Project\nDo X.")
        .expect("failed to write file");
    let prompt = base_prompt(&tmp.path().to_string_lossy());
    assert!(prompt.contains("<project_context>"));
    assert!(prompt.contains("Project-specific instructions and guidelines:"));
    assert!(prompt.contains(&format!(
        "<project_instructions path=\"{}\">",
        tmp.path().join("EVOT.md").display()
    )));
    assert!(prompt.contains("My Project"));
    assert!(prompt.contains("</project_context>"));
}

#[test]
fn concatenates_multiple_context_files() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    std::fs::write(tmp.path().join("EVOT.md"), "part one").expect("failed to write file");
    std::fs::write(tmp.path().join("CLAUDE.md"), "part two").expect("failed to write file");
    let prompt = base_prompt(&tmp.path().to_string_lossy());
    assert!(prompt.contains("part one"));
    assert!(prompt.contains("part two"));
}

#[test]
fn skips_empty_context_files() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    std::fs::write(tmp.path().join("EVOT.md"), "   ").expect("failed to write file");
    let prompt = base_prompt(&tmp.path().to_string_lossy());
    assert!(!prompt.contains("<project_context>"));
}

#[test]
fn base_sections_are_ordered_static_then_dynamic_boundary() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let prompt = base_prompt(&tmp.path().to_string_lossy());
    let guidelines_pos = prompt.find("Guidelines:").expect("missing Guidelines:");
    let cwd_pos = prompt
        .find("Current working directory:")
        .expect("missing Current working directory:");
    let boundary_pos = prompt
        .find("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")
        .expect("missing dynamic boundary");

    assert!(guidelines_pos < cwd_pos, "guidelines should precede cwd");
    assert!(cwd_pos < boundary_pos, "cwd should precede boundary");
    assert!(!prompt.contains("Current date:"));
}

#[test]
fn tool_set_drives_identity_list_and_guidelines() {
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let prompt = base_prompt(&tmp.path().to_string_lossy());

    // Identity "Available tools" list is derived from each tool's snippet.
    assert!(prompt.contains("Available tools:"));
    assert!(prompt.contains("- read: Read file contents"));
    assert!(prompt.contains("- write: Create or overwrite files"));

    // With the pi-aligned default coding set (read/bash/edit/write and no
    // dedicated search tools), file exploration is steered through bash rather
    // than discouraged. Mirrors pi's "Use bash for file operations" guideline.
    assert!(prompt.contains("Use bash for file operations like ls, rg, find"));
    // The anti-bash framing only applies when dedicated search tools exist, so
    // it must NOT appear here.
    assert!(!prompt.contains("Do not run a bash command when a dedicated tool exists"));
    assert!(!prompt.contains("fall back to bash only when necessary"));

    // Per-tool mechanics come from each tool's own guidelines, matching pi.
    assert!(prompt.contains("Use read to examine files instead of cat or sed."));
    assert!(prompt.contains("Use edit for precise changes"));
    assert!(prompt.contains("Use write only for new files or complete rewrites."));
    assert!(prompt.contains("Be concise in your responses"));
    assert!(prompt.contains("Show file paths clearly when working with files"));
    assert!(!prompt.contains("To edit files, use `edit` instead of sed or awk."));
}

#[test]
fn appended_instructions_precede_project_context_and_cwd() -> TestResult {
    let tmp = tempfile::TempDir::new()?;
    std::fs::write(tmp.path().join("EVOT.md"), "project rules")?;
    let cwd = tmp.path().to_string_lossy();
    let (text, sections) = SystemPrompt::base(&cwd, &coding_tools(), "");
    let config = Config::new(tmp.path().join("config"));
    let agent = Agent::new(&config, cwd.as_ref())?;
    agent
        .with_system_prompt_sections(text, sections)
        .append_system_prompt("first appended rule");
    let before_empty_append = agent.system_prompt();
    agent.append_system_prompt("");
    assert_eq!(agent.system_prompt(), before_empty_append);
    agent.append_system_prompt("second appended rule");

    let prompt = agent.system_prompt();
    let first_append_pos = prompt
        .find("first appended rule")
        .ok_or_else(|| std::io::Error::other("missing first appended rule"))?;
    let second_append_pos = prompt
        .find("second appended rule")
        .ok_or_else(|| std::io::Error::other("missing second appended rule"))?;
    let context_pos = prompt
        .find("<project_context>")
        .ok_or_else(|| std::io::Error::other("missing project context"))?;
    let cwd_pos = prompt
        .find("Current working directory:")
        .ok_or_else(|| std::io::Error::other("missing working directory"))?;

    assert!(first_append_pos < second_append_pos);
    assert!(second_append_pos < context_pos);
    assert!(context_pos < cwd_pos);

    agent
        .with_system_prompt("")
        .append_system_prompt("raw append");
    assert_eq!(agent.system_prompt(), "raw append");
    Ok(())
}

#[test]
fn empty_tool_set_is_rendered_as_none() -> TestResult {
    let tmp = tempfile::TempDir::new()?;
    let tools: Vec<Box<dyn evot_engine::AgentTool>> = Vec::new();
    let prompt = SystemPrompt::base(&tmp.path().to_string_lossy(), &tools, "").0;

    assert!(prompt.contains("Available tools:\n(none)"));
    assert!(prompt
        .contains("In addition to the tools above, you may have access to other custom tools"));
    Ok(())
}

#[test]
fn available_tools_list_uses_model_resolved_alias_names() {
    use evot_engine::tools::GrepTool;
    use evot_engine::tools::ReadFileTool;
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let tools: Vec<Box<dyn evot_engine::AgentTool>> =
        vec![Box::new(ReadFileTool::default()), Box::new(GrepTool::new())];

    // Claude models are offered the capitalized aliases, so the advertised
    // names in the prompt must match what the model can actually call.
    let claude = SystemPrompt::base(&tmp.path().to_string_lossy(), &tools, "claude-opus-4-6").0;
    assert!(claude.contains("- Read: "), "expected Read alias: {claude}");
    assert!(claude.contains("- Grep: "), "expected Grep alias: {claude}");
    assert!(!claude.contains("- read: "), "base name leaked: {claude}");

    // Non-Claude models keep the base names.
    let other = SystemPrompt::base(&tmp.path().to_string_lossy(), &tools, "gpt-4o").0;
    assert!(other.contains("- read: "), "expected base name: {other}");
}

#[test]
fn dedicated_search_tools_suppress_bash_exploration_guideline() {
    use evot_engine::tools::BashTool;
    use evot_engine::tools::GrepTool;
    use evot_engine::tools::ReadFileTool;
    let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
    let tools: Vec<Box<dyn evot_engine::AgentTool>> = vec![
        Box::new(ReadFileTool::default()),
        Box::new(BashTool::default()),
        Box::new(GrepTool::new()),
    ];
    let prompt = SystemPrompt::base(&tmp.path().to_string_lossy(), &tools, "").0;

    assert!(!prompt.contains("Use bash for file operations like ls, rg, find"));
    assert!(!prompt.contains("Do not run a bash command when a dedicated tool exists"));
    assert!(!prompt.contains("fall back to bash only when necessary"));
}

fn ctx(mode: PromptMode) -> DynamicContext {
    DynamicContext {
        mode,
        sandbox: false,
        variables: Vec::new(),
    }
}

#[test]
fn interactive_mode_adds_language_section_only() {
    let sections = dynamic_sections(&ctx(PromptMode::Interactive));
    assert_eq!(names(&sections), vec!["language"]);
    let language = &sections[0].text;
    assert!(language.contains("language established by the user's requests and preferences"));
    assert!(language.contains("Runtime notifications and tool output do not change that language"));
}

#[test]
fn planning_mode_adds_planning_section_only() {
    let sections = dynamic_sections(&ctx(PromptMode::Planning));
    assert_eq!(names(&sections), vec!["planning_mode"]);
}

#[test]
fn headless_and_readonly_add_no_mode_section() {
    assert!(dynamic_sections(&ctx(PromptMode::Headless)).is_empty());
    assert!(dynamic_sections(&ctx(PromptMode::Readonly)).is_empty());
}

#[test]
fn sandbox_and_variables_layer_onto_mode_section() {
    let sections = dynamic_sections(&DynamicContext {
        mode: PromptMode::Headless,
        sandbox: true,
        variables: vec!["TOKEN".to_string(), "REGION".to_string()],
    });
    // Headless contributes no mode section; runtime state still applies.
    assert_eq!(names(&sections), vec!["sandbox", "variables"]);
    let vars = &sections[1].text;
    assert!(vars.contains("TOKEN"));
    assert!(vars.contains("REGION"));
}

#[test]
fn interactive_with_sandbox_orders_mode_before_runtime_state() {
    let sections = dynamic_sections(&DynamicContext {
        mode: PromptMode::Interactive,
        sandbox: true,
        variables: Vec::new(),
    });
    assert_eq!(names(&sections), vec!["language", "sandbox"]);
}
