use std::path::PathBuf;

use super::run::runtime;
use super::tools::ToolMode;
use crate::error::EvotError;
use crate::error::Result;
use crate::observability::PromptDump;
use crate::observability::SectionDump;
use crate::observability::SystemPromptDump;
use crate::observability::TokenTotals;
use crate::observability::ToolDump;

fn rough_tokens(s: &str) -> usize {
    let chars = s.chars().count();
    chars.div_ceil(4)
}

fn mode_label(mode: ToolMode) -> &'static str {
    match mode {
        ToolMode::Interactive => "Interactive",
        ToolMode::Headless => "Headless",
        ToolMode::Planning => "Planning",
        ToolMode::Readonly => "Readonly",
        ToolMode::Chat => "Chat",
    }
}

pub(super) fn build_prompt_dump(mode: ToolMode, turn: &runtime::TurnInput) -> PromptDump {
    let opts = &turn.options;

    let section_dumps = if opts.system_prompt_sections.is_empty() {
        vec![SectionDump {
            name: "system_prompt".into(),
            text: opts.system_prompt.clone(),
            tokens: rough_tokens(&opts.system_prompt),
        }]
    } else {
        opts.system_prompt_sections
            .iter()
            .map(|s| SectionDump {
                name: s.name.to_string(),
                text: s.text.clone(),
                tokens: rough_tokens(&s.text),
            })
            .collect()
    };

    let system_tokens = rough_tokens(&opts.system_prompt);
    let system_prompt = SystemPromptDump {
        text: opts.system_prompt.clone(),
        tokens: system_tokens,
        sections: section_dumps,
    };

    let mut tool_dumps: Vec<ToolDump> = opts
        .tools
        .iter()
        .map(|t| {
            let name = t.name().to_string();
            let description = t.description().to_string();
            let parameters = t.parameters_schema();
            let serialized = format!("{name}\n{description}\n{parameters}");
            ToolDump {
                name,
                description,
                parameters,
                tokens: rough_tokens(&serialized),
            }
        })
        .collect();
    tool_dumps.sort_by(|a, b| a.name.cmp(&b.name));
    let tool_tokens: usize = tool_dumps.iter().map(|t| t.tokens).sum();

    PromptDump {
        evot_version: env!("CARGO_PKG_VERSION").to_string(),
        cwd: opts.cwd.display().to_string(),
        mode: mode_label(mode).into(),
        model: opts.model.clone(),
        thinking_level: opts.thinking_level.as_str().into(),
        system_prompt,
        tools: tool_dumps,
        totals: TokenTotals {
            system_prompt_tokens: system_tokens,
            tool_definition_tokens: tool_tokens,
            grand_total: system_tokens + tool_tokens,
        },
    }
}

pub(super) fn resolve_dump_path(target: Option<&str>) -> Result<PathBuf> {
    if let Some(t) = target {
        return Ok(PathBuf::from(t));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| EvotError::Agent("HOME not set; cannot pick default dump path".into()))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    Ok(PathBuf::from(home)
        .join(".evotai")
        .join("dumps")
        .join(format!("prompt-{stamp}.json")))
}
