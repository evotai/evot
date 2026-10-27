use std::path::Path;

use evot_engine::provider::SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

const PROJECT_CONTEXT_FILES: &[&str] = &["EVOT.md", "CLAUDE.md", "AGENTS.md"];

const GUIDELINES_HEADER: &str = "Guidelines:";
const BASH_EXPLORE_GUIDELINE: &str = "Use bash for file operations like ls, rg, find";
/// Parallel tool-call guidance. Named "tool calls" so models emit N independent
/// calls instead of packing several argument objects into one call.
const PARALLEL_TOOL_CALLS_GUIDELINE: &str =
    "You can call multiple tools in a single response. For independent work, emit multiple separate tool calls in the same response so they can run in parallel; never pass an array of argument objects to a tool that expects one object. If calls depend on earlier results, run them sequentially";
const GUIDELINES_TRAILER: &[&str] = &[
    "Be concise in your responses",
    "Show file paths clearly when working with files",
];

const IDENTITY_INTRO: &str =
    "You are an expert coding assistant running in evot, a coding agent harness. \
     You help users by reading files, executing commands, editing code, and writing new files.";
const CHAT_IDENTITY: &str =
    "You are evot, an AI assistant embedded in another application. \
     This session has no tools: you cannot read files, run commands, browse, or call functions. \
     Answer directly from the conversation, and say what is missing when it does not contain enough information.";
const IDENTITY_OUTRO: &str =
    "In addition to the tools above, you may have access to other custom tools depending on the project.";

/// A named section of the system prompt.
///
/// Preserved through the builder so callers (including prompt-dump tooling) can
/// see which logical chunk each piece of text came from rather than diffing one
/// big string. The final prompt is just `sections.join("\n\n")`.
#[derive(Debug, Clone)]
pub struct Section {
    pub name: &'static str,
    pub text: String,
}

pub struct SystemPrompt {
    cwd: String,
    has_bash: bool,
    /// Whether the tool set includes dedicated exploration tools (grep/glob/
    /// semantic search). When false, the prompt steers search through bash.
    has_dedicated_search: bool,
    tools_guidelines: Vec<String>,
    sections: Vec<Section>,
}

impl SystemPrompt {
    /// Build the static system-prompt base used for every turn.
    ///
    /// This is the process-constant prefix: tool-aware identity, guidelines,
    /// project context, working directory, then the cache boundary. Per-turn
    /// content (mode, sandbox, variables) is appended separately by
    /// [`super::dynamic_sections`] and lands after the boundary.
    pub fn base(
        cwd: &str,
        tools: &[Box<dyn evot_engine::AgentTool>],
        model: &str,
    ) -> (String, Vec<Section>) {
        Self::with_tool_set_for_model(cwd, tools, model)
            .with_tool_guidance()
            .with_project_context()
            .with_environment_static()
            .with_dynamic_boundary()
            .build_with_sections()
    }

    /// Base for a tool-free turn (`ToolMode::Chat`): no tool list, tool
    /// guidance, or project instructions written for a coding harness.
    pub fn chat(cwd: &str) -> (String, Vec<Section>) {
        Self {
            cwd: cwd.to_string(),
            has_bash: false,
            has_dedicated_search: false,
            tools_guidelines: Vec::new(),
            sections: vec![Section {
                name: "identity",
                text: CHAT_IDENTITY.to_string(),
            }],
        }
        .with_environment_static()
        .with_dynamic_boundary()
        .build_with_sections()
    }

    /// Construct a prompt whose identity "Available tools" list is derived from
    /// the given tools: a tool appears only when it provides a snippet, and its
    /// name is rendered using the alias the target `model` actually sees (e.g.
    /// Claude is offered `Grep`/`Glob`/`Read`, so the prompt must say the same
    /// — otherwise the advertised name won't match the tool the model can call).
    /// The guidelines section is assembled in tool order with dedup.
    pub fn with_tool_set_for_model(
        cwd: &str,
        tools: &[Box<dyn evot_engine::AgentTool>],
        model: &str,
    ) -> Self {
        let mut text = String::from(IDENTITY_INTRO);
        let listed: Vec<(String, &str)> = tools
            .iter()
            .filter_map(|tool| {
                tool.prompt_snippet()
                    .filter(|snippet| !snippet.is_empty())
                    .map(|snippet| (tool.resolve_name(model), snippet))
            })
            .collect();
        text.push_str("\n\nAvailable tools:\n");
        if listed.is_empty() {
            text.push_str("(none)");
        } else {
            for (index, (name, snippet)) in listed.iter().enumerate() {
                if index > 0 {
                    text.push('\n');
                }
                text.push_str(&format!("- {name}: {snippet}"));
            }
        }
        text.push_str("\n\n");
        text.push_str(IDENTITY_OUTRO);
        Self {
            cwd: cwd.to_string(),
            has_bash: tools.iter().any(|t| t.name() == "bash"),
            has_dedicated_search: tools.iter().any(|tool| {
                matches!(
                    tool.name(),
                    "grep" | "glob" | "find" | "ls" | "semantic_code_search"
                )
            }),
            tools_guidelines: tools
                .iter()
                .flat_map(|t| {
                    t.prompt_guidelines()
                        .into_iter()
                        .map(|g| evot_engine::tools::resolve_tool_refs(g, tools, model))
                        .collect::<Vec<_>>()
                })
                .collect(),
            sections: vec![Section {
                name: "identity",
                text,
            }],
        }
    }

    /// Append pi-aligned tool guidelines, deduplicated in tool order.
    pub fn with_tool_guidance(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        let mut lines: Vec<String> = vec![GUIDELINES_HEADER.to_string()];
        let mut add = |s: &str| {
            let s = s.trim();
            if !s.is_empty() && seen.insert(s.to_string()) {
                lines.push(format!("- {s}"));
            }
        };

        if self.has_bash && !self.has_dedicated_search {
            add(BASH_EXPLORE_GUIDELINE);
        }
        for guideline in &self.tools_guidelines {
            add(guideline);
        }
        add(PARALLEL_TOOL_CALLS_GUIDELINE);
        for guideline in GUIDELINES_TRAILER {
            add(guideline);
        }

        self.sections.push(Section {
            name: "guidelines",
            text: lines.join("\n"),
        });
        self
    }

    /// Append the static/dynamic prompt boundary marker used by prompt-cache aware providers.
    pub fn with_dynamic_boundary(mut self) -> Self {
        self.sections.push(Section {
            name: "dynamic_boundary",
            text: SYSTEM_PROMPT_DYNAMIC_BOUNDARY.into(),
        });
        self
    }

    /// Append the stable working-directory line.
    pub fn with_environment_static(mut self) -> Self {
        self.sections.push(Section {
            name: "environment",
            text: Self::environment_text(&self.cwd),
        });
        self
    }

    pub fn environment_text(cwd: &str) -> String {
        format!("Current working directory: {cwd}")
    }

    /// Load project context from well-known files and preserve each source path.
    pub fn with_project_context(mut self) -> Self {
        if let Some(text) = Self::project_context_text(&self.cwd) {
            self.sections.push(Section {
                name: "project_context",
                text,
            });
        }
        self
    }

    pub fn project_context_text(cwd: &str) -> Option<String> {
        let mut files = Vec::new();
        for name in PROJECT_CONTEXT_FILES {
            let path = Path::new(cwd).join(name);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let content = content.trim();
                if !content.is_empty() {
                    files.push((path, content.to_string()));
                }
            }
        }
        if files.is_empty() {
            return None;
        }
        let mut context =
            String::from("<project_context>\n\nProject-specific instructions and guidelines:\n\n");
        for (index, (path, content)) in files.iter().enumerate() {
            if index > 0 {
                context.push('\n');
            }
            context.push_str(&format!(
                "<project_instructions path=\"{}\">\n{}\n</project_instructions>\n",
                path.display(),
                content
            ));
        }
        context.push_str("\n</project_context>");
        Some(context)
    }

    /// Consume the builder and produce the final prompt string.
    pub fn build(self) -> String {
        self.build_with_sections().0
    }

    /// Consume the builder and return both the joined prompt string and the
    /// per-section breakdown.
    pub fn build_with_sections(self) -> (String, Vec<Section>) {
        let sections: Vec<Section> = self
            .sections
            .into_iter()
            .filter(|s| !s.text.is_empty())
            .collect();
        let text = sections
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        (text, sections)
    }
}

pub(crate) fn bind_workspace_sections(sections: &mut Vec<Section>, cwd: &str) {
    for section in sections.iter_mut() {
        match section.name {
            "environment" => section.text = SystemPrompt::environment_text(cwd),
            "project_context" => {
                section.text = SystemPrompt::project_context_text(cwd).unwrap_or_default();
            }
            _ => {}
        }
    }
    if !sections.iter().any(|section| section.name == "environment") {
        let insert_at = sections
            .iter()
            .position(|section| section.name == "dynamic_boundary")
            .unwrap_or(sections.len());
        sections.insert(insert_at, Section {
            name: "environment",
            text: SystemPrompt::environment_text(cwd),
        });
    }
    if let Some(text) = SystemPrompt::project_context_text(cwd) {
        if let Some(section) = sections
            .iter_mut()
            .find(|section| section.name == "project_context")
        {
            if section.text.is_empty() {
                section.text = text;
            }
        } else {
            let insert_at = sections
                .iter()
                .position(|section| matches!(section.name, "environment" | "dynamic_boundary"))
                .unwrap_or(sections.len());
            sections.insert(insert_at, Section {
                name: "project_context",
                text,
            });
        }
    }
    sections.retain(|section| !(section.name == "project_context" && section.text.is_empty()));
}
