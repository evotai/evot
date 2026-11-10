//! `SearchTool` — the `AgentTool` implementation and result formatting.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;

use super::super::cap_output;
use super::index::Bm25Index;
use super::index::{self};
use crate::types::*;

const DEFAULT_TOP_K: usize = 5;
const MAX_TOP_K: usize = 20;
/// Lines of code preview shown per hit.
const PREVIEW_LINES: usize = 8;

/// Semantic code search tool. Caches one BM25 index per searched root.
#[derive(Default)]
pub struct SearchTool {
    cache: Arc<Mutex<HashMap<PathBuf, Arc<Bm25Index>>>>,
}

impl SearchTool {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl AgentTool for SearchTool {
    fn name(&self) -> &str {
        "semantic_code_search"
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        // Match the sibling explore tools' convention: present a PascalCase
        // name on Claude (Read, Grep, Glob, ...) so the tool list reads
        // consistently. The canonical snake_case name is used everywhere else.
        vec![("claude".into(), "SemanticCodeSearch".into())]
    }

    fn label(&self) -> &str {
        "Search Code"
    }

    fn description(&self) -> &str {
        "Find code by what it means, not just exact keywords. Describe a concept, behavior, or \
         identifier (e.g. \"where are retries handled\") and get back ranked function/class/struct \
         snippets with file paths and line ranges. No setup or index step is needed — the \
         workspace is indexed automatically on first use. Reach for this instead of guessing \
         keywords for {{grep}} when exploring unfamiliar code; pair with {{read}} to view a full \
         definition once located. Searches the working directory by default."
    }

    fn prompt_snippet(&self) -> Option<&str> {
        Some("Find code by meaning, not keywords (ranked snippets, zero setup)")
    }

    fn prompt_guidelines(&self) -> Vec<&str> {
        vec![
            "Use {{semantic_code_search}} to explore unfamiliar code by concept or behavior; use \
             {{grep}} for exact string or symbol-reference matches when you already know the term.",
            "Pick one of {{semantic_code_search}} or {{grep}} per target — do not run both for the \
             same symbol or concept. If {{semantic_code_search}} already returned the location, go \
             straight to {{read}} instead of re-searching with {{grep}}.",
        ]
    }

    fn prefer_over(&self) -> Option<(&str, &str)> {
        Some((
            "explore unfamiliar code by concept",
            "grep when you don't know the exact keyword",
        ))
    }

    fn parameter_aliases(&self) -> Option<crate::types::AliasMap> {
        Some(&[
            ("query", &["q", "question", "pattern"] as &[&str]),
            ("path", &["dir", "directory", "root"] as &[&str]),
            ("top_k", &["limit", "k", "max_results"] as &[&str]),
        ])
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language description or identifier(s) to search for."
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search. Defaults to the working directory."
                },
                "top_k": {
                    "type": "number",
                    "description": "Max results to return (default 5, max 20)."
                }
            },
            "required": ["query"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let query = params["query"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'query' parameter".into()))?
            .to_string();
        if query.trim().is_empty() {
            return Err(ToolError::InvalidArgs("'query' must not be empty".into()));
        }
        let top_k = params["top_k"]
            .as_u64()
            .map(|v| (v as usize).clamp(1, MAX_TOP_K))
            .unwrap_or(DEFAULT_TOP_K);

        let root = ctx
            .path_guard
            .resolve_optional_path(&ctx.cwd, params["path"].as_str())?;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Resolve the index for this root, refreshing it against on-disk
        // changes. Walking + parsing is blocking, so it runs off the async
        // runtime. The cache is keyed by root; the lock is held only for the
        // brief get/insert, never across the build.
        let cached = self.cache.lock().get(&root).cloned();
        let cancel = ctx.cancel.clone();
        let build_root = root.clone();
        // `fresh` is true only when a new index was produced (full build or a
        // refresh that found changes), so the unchanged common path performs
        // zero cache writes and cannot overwrite a concurrently-stored index.
        let (index, fresh) = tokio::task::spawn_blocking(move || match cached {
            Some(idx) => match idx.refreshed(&build_root, &cancel) {
                Some(updated) => (Arc::new(updated), true),
                None => (idx, false),
            },
            None => (Arc::new(Bm25Index::build(&build_root, &cancel)), true),
        })
        .await
        .map_err(|e| ToolError::Failed(format!("index build panicked: {e}")))?;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        // Only store when we built a new index. Last-writer-wins under
        // concurrent searches of the same root is fine: a stale write is
        // corrected by the next search's refresh.
        if fresh {
            self.cache.lock().insert(root.clone(), index.clone());
        }

        let hits = index.search(&query, top_k);
        let scores: Vec<f32> = hits
            .iter()
            .map(|h| (h.score * 1000.0).round() / 1000.0)
            .collect();
        let output = format_hits(&hits, &root, index.chunk_count());

        Ok(ToolResult {
            content: vec![Content::Text { text: output }],
            details: serde_json::json!({
                "query": query,
                "hits": hits.len(),
                "scores": scores,
            }),
            retention: Retention::Normal,
        })
    }
}

/// Render hits as ranked, line-numbered snippets relative to the search root.
fn format_hits(hits: &[index::Hit<'_>], root: &std::path::Path, chunk_count: usize) -> String {
    if hits.is_empty() {
        if chunk_count == 0 {
            return "(no indexable source files found)".into();
        }
        return "(no matches)".into();
    }

    let mut out = String::new();
    for (i, hit) in hits.iter().enumerate() {
        let chunk = hit.chunk;
        let rel = std::path::Path::new(&chunk.file_path)
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| chunk.file_path.clone());

        let scope = chunk
            .defines
            .as_deref()
            .map(|n| format!("  defines `{n}`"))
            .unwrap_or_default();

        out.push_str(&format!(
            "[{}] {}:{}-{}{}\n",
            i + 1,
            rel,
            chunk.start_line,
            chunk.end_line,
            scope
        ));

        // Preview: first PREVIEW_LINES of the chunk, with a trailing marker.
        let total = chunk.end_line - chunk.start_line + 1;
        for (li, line) in chunk.content.lines().take(PREVIEW_LINES).enumerate() {
            out.push_str(&format!("{:>5} | {}\n", chunk.start_line + li, line));
        }
        if total > PREVIEW_LINES {
            out.push_str(&format!(
                "      … (+{} more lines, use read to see the full definition)\n",
                total - PREVIEW_LINES
            ));
        }
        out.push('\n');
    }

    cap_output(out.trim_end().to_string(), ", narrow the query for fewer")
}
