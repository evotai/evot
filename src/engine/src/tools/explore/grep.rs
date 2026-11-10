//! `grep` — recursive file-content search returning `path:line: text`.
//!
//! Walks the tree in parallel with the `ignore` crate (gitignore-aware) and
//! searches each file with ripgrep's own engine (`grep-searcher` +
//! `grep-regex`), which brings binary-file detection, encoding handling, and
//! line counting. Always returns line numbers, so the agent can jump straight
//! to a location without re-reading the file to locate code.

use async_trait::async_trait;

use super::finalize_output;
use super::parallel_collect;
use crate::types::*;

/// Max matches surfaced in one response, across all files.
const MAX_MATCHES: usize = 200;
/// Per-file match cap (multi-file searches) so one hot file can't crowd out
/// diverse hits from other files. Single-file searches bypass this.
const PER_FILE_MATCHES: usize = 20;

/// Content search across files.
#[derive(Default)]
pub struct GrepTool;

impl GrepTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentTool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "Grep".into())]
    }

    fn label(&self) -> &str {
        "Search Contents"
    }

    fn description(&self) -> &str {
        "Search file contents recursively for a regex pattern. Always returns line numbers; \
         output format is `path:line: matching text`. Respects .gitignore by default (set \
         `gitignore` false to search ignored files like build outputs). There is no need to use \
         bash grep or rg — this tool already provides line numbers, scans in parallel, and is \
         faster. Use `context` to include surrounding lines (like grep -C). Use \
         `files_with_matches` to list only matching paths, `fixed_strings` to match literally, \
         and `multiline` for patterns that span lines (use `(?s)` to let `.` cross newlines). \
         `include` accepts one or more globs to filter files. Use `skip` to paginate past a \
         capped result. Output is truncated to 200 matches or 50KB."
    }

    fn prompt_snippet(&self) -> Option<&str> {
        Some("Search file contents by regex (returns path:line: text)")
    }

    fn prefer_over(&self) -> Option<(&str, &str)> {
        Some(("search file contents", "bash grep or rg"))
    }

    fn parameter_aliases(&self) -> Option<crate::types::AliasMap> {
        Some(&[
            ("pattern", &["query", "regex", "search"] as &[&str]),
            ("path", &["dir", "directory", "file"] as &[&str]),
            ("include", &["glob", "filter", "include_pattern"]
                as &[&str]),
        ])
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for."
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file to search in. Defaults to the working directory."
                },
                "include": {
                    "oneOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ],
                    "description": "File glob filter(s), e.g. '*.rs' or ['*.rs', '*.toml']. Optional."
                },
                "ignore_case": {
                    "type": "boolean",
                    "description": "Case-insensitive search. Defaults to false."
                },
                "context": {
                    "type": "number",
                    "description": "Context lines before and after each match (like grep -C). Context lines use 'path-line- text' (hyphen); blocks are separated by '--'. Defaults to 0."
                },
                "fixed_strings": {
                    "type": "boolean",
                    "description": "Treat the pattern as a literal string instead of a regex (like grep -F). Defaults to false."
                },
                "multiline": {
                    "type": "boolean",
                    "description": "Allow the pattern to match across line boundaries. Pair with '(?s)' so '.' matches newlines. Defaults to false."
                },
                "files_with_matches": {
                    "type": "boolean",
                    "description": "List only the paths of files containing a match (like grep -l). Defaults to false."
                },
                "gitignore": {
                    "type": "boolean",
                    "description": "Respect .gitignore and hidden-file rules. Set false to search ignored/hidden files. Defaults to true."
                },
                "skip": {
                    "type": "number",
                    "description": "Number of matches (or files, for files_with_matches) to skip before collecting — paginate past a capped result. Defaults to 0."
                },
                "reason": {
                    "type": "string",
                    "description": "Briefly explain why you chose this pattern and what you expect to find."
                }
            },
            "required": ["pattern"]
        })
    }

    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        let pattern = params["pattern"].as_str()?;
        let path = params["path"].as_str().unwrap_or(".");
        let mut args: Vec<String> = vec!["rg".into(), "--line-number".into()];
        if params["ignore_case"].as_bool().unwrap_or(false) {
            args.push("-i".into());
        }
        if params["fixed_strings"].as_bool().unwrap_or(false) {
            args.push("-F".into());
        }
        if params["multiline"].as_bool().unwrap_or(false) {
            args.push("-U".into());
        }
        if params["files_with_matches"].as_bool().unwrap_or(false) {
            args.push("-l".into());
        }
        if !params["gitignore"].as_bool().unwrap_or(true) {
            args.push("-uu".into());
        }
        if let Some(n) = params["context"].as_u64().filter(|n| *n > 0) {
            args.push(format!("-C{n}"));
        }
        for g in collect_includes(&params["include"]) {
            args.push("-g".into());
            args.push(g);
        }
        args.push(format!("{pattern:?}"));
        args.push(path.to_string());
        Some(args.join(" "))
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let pattern = params["pattern"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'pattern' parameter".into()))?
            .to_string();
        if pattern.is_empty() {
            return Err(ToolError::InvalidArgs("'pattern' must not be empty".into()));
        }
        let includes = collect_includes(&params["include"]);
        let opts = SearchOptions {
            ignore_case: params["ignore_case"].as_bool().unwrap_or(false),
            fixed_strings: params["fixed_strings"].as_bool().unwrap_or(false),
            multiline: params["multiline"].as_bool().unwrap_or(false),
            files_with_matches: params["files_with_matches"].as_bool().unwrap_or(false),
            context: params["context"].as_u64().unwrap_or(0) as usize,
            gitignore: params["gitignore"].as_bool().unwrap_or(true),
            skip: params["skip"].as_u64().unwrap_or(0) as usize,
        };

        let search_root = ctx
            .path_guard
            .resolve_optional_path(&ctx.cwd, params["path"].as_str())?;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let output = run_search(&search_root, &pattern, &includes, opts, &ctx).await?;
        let output = finalize_output(
            output,
            ", refine the pattern or use skip to paginate",
            &ctx,
            &format!("grep-{}", ctx.tool_call_id),
        )
        .await;

        Ok(ToolResult {
            content: vec![Content::Text { text: output }],
            details: serde_json::json!({ "pattern": pattern }),
            retention: Retention::Normal,
        })
    }
}

/// Normalize the `include` value into a list of globs. Accepts a single string
/// or an array of strings, dropping empties.
fn collect_includes(v: &serde_json::Value) -> Vec<String> {
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

// SEARCH_IMPL

use std::path::Path;

use grep::regex::RegexMatcher;
use grep::searcher::BinaryDetection;
use grep::searcher::Searcher;
use grep::searcher::SearcherBuilder;
use grep::searcher::Sink;
use grep::searcher::SinkContext;
use grep::searcher::SinkMatch;

/// Options controlling a single grep run.
#[derive(Clone, Copy)]
struct SearchOptions {
    ignore_case: bool,
    fixed_strings: bool,
    multiline: bool,
    files_with_matches: bool,
    context: usize,
    gitignore: bool,
    skip: usize,
}

/// One file's collected output lines, kept separate so results can be ordered
/// deterministically (by path) after the parallel walk.
struct FileHits {
    rel: String,
    lines: Vec<String>,
    matched: bool,
}

/// Parallel gitignore-aware walk + ripgrep's own search engine, run off the
/// async runtime. Using grep-searcher gives binary-file detection, encoding
/// handling, and line counting for free — the same machinery ripgrep uses.
async fn run_search(
    root: &Path,
    pattern: &str,
    includes: &[String],
    opts: SearchOptions,
    ctx: &ToolContext,
) -> Result<String, ToolError> {
    // Validate the regex once on the async side so a bad pattern surfaces as
    // InvalidArgs before we spin up the walk.
    grep::regex::RegexMatcherBuilder::new()
        .case_insensitive(opts.ignore_case)
        .fixed_strings(opts.fixed_strings)
        .multi_line(opts.multiline)
        .dot_matches_new_line(opts.multiline)
        .build(pattern)
        .map_err(|e| ToolError::InvalidArgs(format!("invalid regex: {e}")))?;

    let mut glob_set = None;
    if !includes.is_empty() {
        let mut b = globset::GlobSetBuilder::new();
        for g in includes {
            b.add(
                globset::Glob::new(g)
                    .map_err(|e| ToolError::InvalidArgs(format!("invalid include glob: {e}")))?,
            );
        }
        glob_set = Some(
            b.build()
                .map_err(|e| ToolError::InvalidArgs(format!("invalid include set: {e}")))?,
        );
    }

    let root = root.to_path_buf();
    let pattern = pattern.to_string();
    let cancel = ctx.cancel.clone();
    let on_progress = ctx.on_progress.clone();
    tokio::task::spawn_blocking(move || {
        search_tree(
            &root,
            &pattern,
            glob_set.as_ref(),
            opts,
            &cancel,
            on_progress,
        )
    })
    .await
    .map_err(|e| ToolError::Failed(format!("search task panicked: {e}")))?
}

fn search_tree(
    root: &Path,
    pattern: &str,
    glob: Option<&globset::GlobSet>,
    opts: SearchOptions,
    cancel: &tokio_util::sync::CancellationToken,
    on_progress: Option<ProgressFn>,
) -> Result<String, ToolError> {
    let matcher = grep::regex::RegexMatcherBuilder::new()
        .case_insensitive(opts.ignore_case)
        .fixed_strings(opts.fixed_strings)
        .multi_line(opts.multiline)
        .dot_matches_new_line(opts.multiline)
        .build(pattern)
        .map_err(|e| ToolError::InvalidArgs(format!("invalid regex: {e}")))?;

    // Per-file searches have no diversity concern, so they get the full budget;
    // multi-file searches cap each file to keep results varied.
    let per_file_cap = if opts.files_with_matches {
        usize::MAX
    } else {
        PER_FILE_MATCHES
    };
    // -l mode reports paths only, so context lines are irrelevant there.
    let context = if opts.files_with_matches {
        0
    } else {
        opts.context
    };

    let roots = [root.to_path_buf()];
    let mut per_file: Vec<FileHits> =
        parallel_collect(&roots, opts.gitignore, !opts.gitignore, cancel, |entry| {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return None;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(path);
            if let Some(g) = glob {
                if !g.is_match(rel) {
                    return None;
                }
            }
            let rel = rel.to_string_lossy().into_owned();
            search_one_file(path, &rel, &matcher, opts, context, per_file_cap)
        });

    // Deterministic order regardless of which worker finished first.
    per_file.sort_by(|a, b| a.rel.cmp(&b.rel));

    if let Some(progress) = &on_progress {
        let files = per_file.iter().filter(|f| f.matched).count();
        progress(format!("grep: scanned, {files} file(s) with matches"));
    }

    if opts.files_with_matches {
        return Ok(render_file_list(per_file, opts.skip));
    }
    Ok(render_matches(per_file, opts.skip, context > 0))
}

/// Search a single file, returning its hits (or `None` when nothing matched and
/// it's not needed). For `-l` mode we only record whether the file matched.
fn search_one_file(
    path: &Path,
    rel: &str,
    matcher: &RegexMatcher,
    opts: SearchOptions,
    context: usize,
    per_file_cap: usize,
) -> Option<FileHits> {
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .multi_line(opts.multiline)
        .before_context(context)
        .after_context(context)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .build();

    if opts.files_with_matches {
        let mut matched = false;
        let sink = FilesWithMatchesSink {
            matched: &mut matched,
        };
        let _ = searcher.search_path(matcher, path, sink);
        return matched.then(|| FileHits {
            rel: rel.to_string(),
            lines: Vec::new(),
            matched: true,
        });
    }

    let mut lines: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut last_line: Option<u64> = None;
    let sink = GrepSink {
        rel,
        lines: &mut lines,
        count: &mut count,
        per_file_cap,
        last_line: &mut last_line,
        context_gap: context > 0,
    };
    let _ = searcher.search_path(matcher, path, sink);
    if lines.is_empty() {
        return None;
    }
    Some(FileHits {
        rel: rel.to_string(),
        lines,
        matched: true,
    })
}

/// Render `-l` output: bare matching paths, honoring `skip` and the cap.
fn render_file_list(per_file: Vec<FileHits>, skip: usize) -> String {
    let paths: Vec<String> = per_file
        .into_iter()
        .filter(|f| f.matched)
        .map(|f| f.rel)
        .skip(skip)
        .collect();
    if paths.is_empty() {
        return "(no matches)".into();
    }
    let capped = paths.len() > MAX_MATCHES;
    let mut lines: Vec<String> = paths.into_iter().take(MAX_MATCHES).collect();
    if capped {
        lines.push(format!(
            "... (capped at {MAX_MATCHES} files — use skip to paginate)"
        ));
    }
    lines.join("\n")
}

/// Render match lines across files, honoring `skip` and the global cap, with
/// `--` separators between files (and between context blocks within a file).
fn render_matches(per_file: Vec<FileHits>, skip: usize, has_context: bool) -> String {
    let total: usize = per_file.iter().map(|f| f.lines.len()).sum();
    if total == 0 {
        return "(no matches)".into();
    }
    let mut out: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    let mut emitted = 0usize;
    let mut capped = false;
    let mut first_file = true;
    'outer: for file in per_file {
        if file.lines.is_empty() {
            continue;
        }
        let mut file_started = false;
        for line in file.lines {
            if skipped < skip {
                skipped += 1;
                continue;
            }
            if emitted >= MAX_MATCHES {
                capped = true;
                break 'outer;
            }
            if has_context && !file_started && !first_file {
                out.push("--".into());
            }
            file_started = true;
            first_file = false;
            out.push(line);
            emitted += 1;
        }
    }
    if out.is_empty() {
        return "(no matches)".into();
    }
    if capped {
        out.push(format!(
            "... (capped at {MAX_MATCHES} matches — refine the pattern or use skip to paginate)"
        ));
    }
    out.join("\n")
}

/// Sink that emits `path:line: text` for matches and `path-line- text` for
/// context lines, capping per-file output and inserting `--` between
/// non-adjacent context blocks (mirroring ripgrep).
struct GrepSink<'a> {
    rel: &'a str,
    lines: &'a mut Vec<String>,
    count: &'a mut usize,
    per_file_cap: usize,
    last_line: &'a mut Option<u64>,
    context_gap: bool,
}

impl GrepSink<'_> {
    fn push(&mut self, sep: char, line_no: Option<u64>, bytes: &[u8]) -> bool {
        if *self.count >= self.per_file_cap {
            return false;
        }
        // Insert a `--` divider when there's a gap between this line and the
        // previous one, so overlapping/adjacent context blocks stay readable.
        if self.context_gap {
            if let (Some(prev), Some(cur)) = (*self.last_line, line_no) {
                if cur > prev + 1 {
                    self.lines.push("--".into());
                }
            }
        }
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_end();
        match line_no {
            Some(n) => self.lines.push(format!("{}{sep}{n}{sep} {text}", self.rel)),
            None => self.lines.push(format!("{}{sep} {text}", self.rel)),
        }
        *self.last_line = line_no;
        *self.count += 1;
        true
    }
}

impl Sink for GrepSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch) -> Result<bool, std::io::Error> {
        // A multi-line match can carry several lines; emit each with its number.
        let start = mat.line_number();
        let mut keep_going = true;
        for (i, line) in mat.lines().enumerate() {
            let n = start.map(|s| s + i as u64);
            keep_going = self.push(':', n, line);
            if !keep_going {
                break;
            }
        }
        Ok(keep_going)
    }

    fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext) -> Result<bool, std::io::Error> {
        Ok(self.push('-', ctx.line_number(), ctx.bytes()))
    }
}

/// Sink for `-l` mode: flips a flag on the first match and stops the file scan.
struct FilesWithMatchesSink<'a> {
    matched: &'a mut bool,
}

impl Sink for FilesWithMatchesSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, _mat: &SinkMatch) -> Result<bool, std::io::Error> {
        *self.matched = true;
        Ok(false) // one match is enough; stop scanning this file
    }
}
