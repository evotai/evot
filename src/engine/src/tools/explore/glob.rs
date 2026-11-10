//! `glob` — find file paths matching one or more glob patterns.
//!
//! Walks the tree in parallel with the `ignore` crate (gitignore-aware) and
//! matches names with `globset` — the same engine fd is built on. Accepts
//! arrays of patterns and paths, unioned in a single call, so the agent can
//! locate many file kinds in one round-trip. Results are ordered by recency
//! (most recently modified first), matching how fd/ripgrep surface "what did I
//! touch lately" during exploration.

use async_trait::async_trait;

use super::finalize_output;
use super::parallel_collect;
use crate::types::*;

const DEFAULT_MAX_RESULTS: usize = 200;
const MAX_MAX_RESULTS: usize = 1000;
const DEFAULT_TIMEOUT_SECS: f64 = 5.0;
const MIN_TIMEOUT_SECS: f64 = 0.5;
const MAX_TIMEOUT_SECS: f64 = 60.0;

/// File-name search by glob pattern.
#[derive(Default)]
pub struct GlobTool;

impl GlobTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentTool for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "Glob".into())]
    }

    fn label(&self) -> &str {
        "Find Files"
    }

    fn description(&self) -> &str {
        "Find file paths matching one or more glob patterns. Returns paths sorted by modification \
         time (most recent first), deduplicated, relative to the search root. Respects .gitignore \
         by default (set `gitignore` false to find ignored files like .env or build outputs; set \
         `hidden` true to include dotfiles). There is no need to use bash find or ls — prefer one \
         call with several patterns over multiple calls. Use '**' to recurse, '*' to match one \
         path segment. Examples: ['**/*.rs'], ['Cargo.toml', 'src/**/*.rs']. Output is truncated \
         to 200 results (raise `max_results` up to 1000) or 50KB; the walk stops after `timeout` \
         seconds and returns partial results."
    }

    fn prompt_snippet(&self) -> Option<&str> {
        Some("Find files by glob pattern (recency-sorted; one call, many patterns)")
    }

    fn prompt_guidelines(&self) -> Vec<&str> {
        vec![
            "When using glob, pass several patterns in one call rather than making separate calls.",
        ]
    }

    fn prefer_over(&self) -> Option<(&str, &str)> {
        Some(("find files by name", "bash find or ls"))
    }

    fn parameter_aliases(&self) -> Option<crate::types::AliasMap> {
        Some(&[
            ("pattern", &["patterns", "glob", "query"] as &[&str]),
            ("path", &["paths", "dir", "directory"] as &[&str]),
        ])
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "description": "Glob pattern(s), unioned. Use '**' to recurse. Always an array, even for one pattern, e.g. ['**/*.rs']."
                },
                "path": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Base directories to search within. Defaults to the working directory."
                },
                "type": {
                    "type": "string",
                    "enum": ["f", "d", "any"],
                    "description": "Filter by entry type: 'f' files, 'd' directories, 'any' both. Defaults to 'f'."
                },
                "gitignore": {
                    "type": "boolean",
                    "description": "Respect .gitignore. Set false to surface ignored files like build outputs or .env. Defaults to true."
                },
                "hidden": {
                    "type": "boolean",
                    "description": "Include hidden (dotfile) entries. Defaults to false."
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Maximum number of results (clamped to 1-1000). Defaults to 200."
                },
                "timeout": {
                    "type": "number",
                    "description": "Walk timeout in seconds (clamped 0.5-60). On timeout, partial results are returned. Defaults to 5."
                },
                "reason": {
                    "type": "string",
                    "description": "Briefly explain which patterns you chose and what you expect to find."
                }
            },
            "required": ["pattern"]
        })
    }

    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        let pats = collect_strings(&params["pattern"]);
        if pats.is_empty() {
            return None;
        }
        let mut args: Vec<String> = vec!["fd".into()];
        if !params["gitignore"].as_bool().unwrap_or(true) {
            args.push("--no-ignore".into());
        }
        if params["hidden"].as_bool().unwrap_or(false) {
            args.push("--hidden".into());
        }
        match params["type"].as_str().unwrap_or("f") {
            "d" => args.push("--type=d".into()),
            "any" => {}
            _ => args.push("--type=f".into()),
        }
        args.push("--glob".into());
        // fd takes one pattern; show the first and note the union.
        args.push(format!("{:?}", pats[0]));
        if pats.len() > 1 {
            args.push(format!("# (+{} more patterns, unioned)", pats.len() - 1));
        }
        Some(args.join(" "))
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let patterns = collect_strings(&params["pattern"]);
        if patterns.is_empty() {
            return Err(ToolError::InvalidArgs(
                "'pattern' is required (a non-empty array of glob strings)".into(),
            ));
        }
        let type_filter = params["type"].as_str().unwrap_or("f").to_string();
        let max_results = params["max_results"]
            .as_u64()
            .map(|n| (n as usize).clamp(1, MAX_MAX_RESULTS))
            .unwrap_or(DEFAULT_MAX_RESULTS);
        let gitignore = params["gitignore"].as_bool().unwrap_or(true);
        let hidden = params["hidden"].as_bool().unwrap_or(false);
        let timeout_secs = params["timeout"]
            .as_f64()
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS);

        // Resolve base dirs; default to cwd when none given.
        let raw_paths = collect_strings(&params["path"]);
        let mut roots = Vec::new();
        if raw_paths.is_empty() {
            roots.push(ctx.path_guard.resolve_optional_path(&ctx.cwd, None)?);
        } else {
            for p in &raw_paths {
                roots.push(ctx.path_guard.resolve_path(&ctx.cwd, p)?);
            }
        }

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let opts = GlobOptions {
            type_filter,
            max_results,
            gitignore,
            hidden,
        };
        let output = run_glob(&roots, &patterns, opts, timeout_secs, &ctx).await?;
        let output = finalize_output(
            output,
            ", narrow the pattern for more",
            &ctx,
            &format!("glob-{}", ctx.tool_call_id),
        )
        .await;

        Ok(ToolResult {
            content: vec![Content::Text { text: output }],
            details: serde_json::json!({ "patterns": patterns }),
            retention: Retention::Normal,
        })
    }
}

/// Normalize a JSON value into a list of non-empty strings. Accepts a single
/// string or an array of strings, so the model can pass either form.
fn collect_strings(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::String(s) if !s.is_empty() => vec![s.clone()],
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

// GLOB_IMPL

use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;

/// Options controlling a single glob run.
struct GlobOptions {
    type_filter: String,
    max_results: usize,
    gitignore: bool,
    hidden: bool,
}

/// One matched entry plus its mtime, so results can be ordered by recency.
struct GlobHit {
    display: String,
    mtime: SystemTime,
}

/// Parallel gitignore-aware walk + globset match, run off the async runtime
/// with a wall-clock timeout. On timeout the partial result collected so far is
/// returned (flagged in the output) rather than erroring.
async fn run_glob(
    roots: &[PathBuf],
    patterns: &[String],
    opts: GlobOptions,
    timeout_secs: f64,
    ctx: &ToolContext,
) -> Result<String, ToolError> {
    let mut builder = globset::GlobSetBuilder::new();
    for pat in patterns {
        builder.add(
            globset::Glob::new(pat)
                .map_err(|e| ToolError::InvalidArgs(format!("invalid glob '{pat}': {e}")))?,
        );
    }
    let set = builder
        .build()
        .map_err(|e| ToolError::InvalidArgs(format!("invalid glob set: {e}")))?;

    let roots = roots.to_vec();
    // A dedicated cancel token lets the timeout stop the walk without
    // disturbing the caller's own cancellation.
    let walk_cancel = ctx.cancel.child_token();
    let timeout_cancel = walk_cancel.clone();
    let timeout_handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs_f64(timeout_secs)).await;
        timeout_cancel.cancel();
    });

    let outer_cancel = ctx.cancel.clone();
    let max_results = opts.max_results;
    let walk = tokio::task::spawn_blocking(move || builtin_walk(&roots, &set, &opts, &walk_cancel))
        .await
        .map_err(|e| ToolError::Failed(format!("glob task panicked: {e}")))?;
    timeout_handle.abort();

    // Distinguish a real cancellation from a timeout: if the caller cancelled,
    // propagate; otherwise the child token firing means we timed out.
    if outer_cancel.is_cancelled() {
        return Err(ToolError::Cancelled);
    }

    let (hits, timed_out) = walk;
    Ok(format_hits(hits, max_results, timed_out))
}

fn builtin_walk(
    roots: &[PathBuf],
    set: &globset::GlobSet,
    opts: &GlobOptions,
    cancel: &tokio_util::sync::CancellationToken,
) -> (Vec<GlobHit>, bool) {
    // With a single root, render paths relative to it (the common case). With
    // several roots, render absolute paths so entries stay unambiguous.
    let single_root = roots.len() == 1;
    let single_root_path = roots.first().cloned();
    let type_filter = opts.type_filter.clone();

    let hits = parallel_collect(roots, opts.gitignore, opts.hidden, cancel, |entry| {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match type_filter.as_str() {
            "f" if is_dir => return None,
            "d" if !is_dir => return None,
            _ => {}
        }
        let path = entry.path();
        // Determine which root this entry came from to relativize sensibly.
        let rel_to_root = if single_root {
            single_root_path
                .as_deref()
                .and_then(|r| path.strip_prefix(r).ok())
                .unwrap_or(path)
        } else {
            roots
                .iter()
                .find_map(|r| path.strip_prefix(r).ok())
                .unwrap_or(path)
        };
        if !set.is_match(rel_to_root) {
            return None;
        }
        let display = if single_root {
            rel_to_root.to_string_lossy().into_owned()
        } else {
            path.to_string_lossy().into_owned()
        };
        if display.is_empty() {
            return None;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        Some(GlobHit { display, mtime })
    });

    (hits, cancel.is_cancelled())
}

/// Render hits ordered by recency (newest first), deduplicated, capped at
/// `max_results`. Ties broken by path for determinism.
fn format_hits(mut hits: Vec<GlobHit>, max_results: usize, timed_out: bool) -> String {
    if hits.is_empty() {
        return if timed_out {
            "(no matches; search timed out before completing)".into()
        } else {
            "(no matches)".into()
        };
    }
    // Newest first; stable tiebreak on path so output is deterministic.
    hits.sort_by(|a, b| {
        b.mtime
            .cmp(&a.mtime)
            .then_with(|| a.display.cmp(&b.display))
    });

    let mut seen = std::collections::HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    for hit in hits {
        if seen.insert(hit.display.clone()) {
            lines.push(hit.display);
        }
    }
    let capped = lines.len() > max_results;
    lines.truncate(max_results);
    if capped {
        lines.push(format!(
            "... (capped at {max_results} results — raise max_results or narrow the pattern)"
        ));
    }
    if timed_out {
        lines.push("... (search timed out — results may be incomplete; raise timeout or narrow the pattern)".into());
    }
    lines.join("\n")
}
