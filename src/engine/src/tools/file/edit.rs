//! Edit tool — surgical search/replace edits on files.
//!
//! Supports multiple disjoint edits in one call. All edits are matched against
//! the original file content, then applied in reverse position order.
//!
//! Matching strategy (tiered fallback):
//! 1. Exact match
//! 2. Unicode-normalized match (quotes + dashes + Unicode spaces → ASCII, 1:1 char mapping)
//! 3. Trailing-whitespace-insensitive line match
//! 4. Full normalization (unicode + trailing ws combined)
//! 5. NFKC-normalized line match (compatibility forms, e.g. full-width CJK
//!    punctuation / Latin → ASCII; combined with unicode + trailing ws)

use async_trait::async_trait;

use super::diff;
use super::hint;
use super::mutex::acquire_file_lock;
use super::snippet;
use super::snippet::line_at as byte_offset_to_line;
use crate::types::*;

// ─── Tool ─────────────────────────────────────────────────────────────────

/// Surgical file editing via exact text search/replace.
pub struct EditFileTool;

impl Default for EditFileTool {
    fn default() -> Self {
        Self::new()
    }
}

impl EditFileTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentTool for EditFileTool {
    fn name(&self) -> &str {
        "edit"
    }
    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "Edit".into())]
    }

    fn label(&self) -> &str {
        "Edit File"
    }

    fn description(&self) -> &str {
        "Edit a single file using exact text replacement. \
         Every edits[].oldText must match a unique, non-overlapping region of the original file. \
         If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. \
         Do not include large unchanged regions just to connect distant changes."
    }

    fn prompt_snippet(&self) -> Option<&str> {
        Some("Make precise file edits with exact text replacement, including multiple disjoint edits in one call")
    }

    fn prompt_guidelines(&self) -> Vec<&str> {
        vec![
            "Use edit for precise changes (edits[].oldText must match exactly)",
            "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
            "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
            "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
        ]
    }

    fn prefer_over(&self) -> Option<(&str, &str)> {
        Some(("edit files", "sed or awk"))
    }

    fn parameter_aliases(&self) -> Option<crate::tools::validation::AliasMap> {
        Some(&[("path", &["file_path", "filePath", "file"] as &[&str])])
    }

    fn prepare_arguments(&self, args: &serde_json::Value) -> serde_json::Value {
        crate::tools::validation::coerce_edits(args)
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to edit (relative or absolute). Emit path first, before edits."
                },
                "edits": {
                    "type": "array",
                    "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": {
                                "type": "string",
                                "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
                            },
                            "newText": {
                                "type": "string",
                                "description": "Replacement text for this targeted edit."
                            }
                        },
                        "required": ["oldText", "newText"]
                    }
                }
            },
            "required": ["path", "edits"]
        })
    }

    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        let path = params["path"].as_str()?;
        let n = params["edits"].as_array().map(|a| a.len()).unwrap_or(1);
        Some(format!("edit {path} ({n} replacement(s))"))
    }
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let path_str = params["path"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'path' parameter".into()))?;
        let path = ctx.path_guard.resolve_path(&ctx.cwd, path_str)?;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Acquire per-file lock to serialize mutations on the same file
        let _lock = acquire_file_lock(&path).await;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Read file bytes and validate UTF-8
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            ToolError::Failed(format!(
                "Cannot read {path_str}: {e}. Use Write to create new files."
            ))
        })?;
        let raw = String::from_utf8(bytes).map_err(|_| {
            ToolError::Failed(format!(
                "Cannot edit {path_str}: only UTF-8 text files are supported."
            ))
        })?;

        // Strip BOM, detect line endings, normalize to LF
        let (bom, content_raw) = strip_utf8_bom(&raw);
        let line_ending = detect_line_ending(content_raw);
        let content_lf = normalize_to_lf(content_raw);

        // Parse edits
        let edits = self.parse_edits(&params)?;

        // Resolve all matches against original content
        struct ResolvedEdit {
            edit_index: usize,
            start: usize,
            end: usize,
            new_text: String,
            kind: MatchKind,
        }

        let mut resolved: Vec<ResolvedEdit> = Vec::with_capacity(edits.len());
        for (i, (old_text_lf, new_text_lf)) in edits.iter().enumerate() {
            let rm = resolve_unique_match(&content_lf, old_text_lf)
                .map_err(|e| self.match_error(e, path_str, old_text_lf, &content_lf, i))?;
            let start = rm.byte_offset;
            let end = start + rm.actual_old_text.len();
            let final_new_text = match rm.kind {
                // All tiers that fold curly quotes via `normalize_unicode`
                // must re-apply the file's quote style to new_text, otherwise
                // the replacement silently rewrites curly quotes to straight.
                MatchKind::UnicodeNormalized
                | MatchKind::FullNormalized
                | MatchKind::NfkcNormalized => {
                    preserve_quote_style(old_text_lf, &rm.actual_old_text, new_text_lf)
                }
                _ => new_text_lf.clone(),
            };
            resolved.push(ResolvedEdit {
                edit_index: i,
                start,
                end,
                new_text: final_new_text,
                kind: rm.kind,
            });
        }

        // Check for overlaps
        resolved.sort_by_key(|r| r.start);
        for w in resolved.windows(2) {
            if w[0].end > w[1].start {
                return Err(ToolError::Failed(format!(
                    "edits[{}] and edits[{}] overlap in {path_str}. Merge them into one edit.",
                    w[0].edit_index, w[1].edit_index
                )));
            }
        }

        let match_kind = resolved
            .last()
            .map(|r| r.kind.as_str().to_string())
            .unwrap_or_else(|| "exact".to_string());
        let replacement_count = resolved.len();

        // Track where each replacement lands in the new content (forward pass),
        // then apply in reverse order so earlier offsets stay valid.
        let mut new_spans = Vec::with_capacity(resolved.len());
        let mut delta: isize = 0;
        for r in &resolved {
            let start = (r.start as isize + delta) as usize;
            new_spans.push((start, start + r.new_text.len()));
            delta += r.new_text.len() as isize - (r.end - r.start) as isize;
        }
        let mut new_content_lf = content_lf.clone();
        for r in resolved.into_iter().rev() {
            new_content_lf.replace_range(r.start..r.end, &r.new_text);
        }

        // No-change detection
        if new_content_lf == content_lf {
            return Err(ToolError::Failed(format!(
                "No changes made to {path_str}. The replacement produced identical content."
            )));
        }

        // Generate diff (for details only, not sent to LLM)
        let diff_result = diff::unified_diff(&content_lf, &new_content_lf, path_str);

        // Emit preview diff before writing (for immediate UI rendering)
        if let Some(ref on_update) = ctx.on_update {
            on_update(ToolResult {
                content: vec![],
                details: serde_json::json!({
                    "preview": true,
                    "diff": diff_result.unified,
                    "added_lines": diff_result.added_lines,
                    "removed_lines": diff_result.removed_lines,
                }),
                retention: Retention::CurrentRun,
            });
        }

        // Restore BOM + original line endings and write back
        let final_content = format!(
            "{}{}",
            bom,
            restore_line_endings(&new_content_lf, line_ending)
        );
        tokio::fs::write(&path, &final_content)
            .await
            .map_err(|e| ToolError::Failed(format!("Cannot write {path_str}: {e}")))?;

        Ok(ToolResult {
            content: vec![Content::Text {
                text: format!(
                    "Updated {path_str}.\n\n{}",
                    changed_regions(&new_content_lf, &new_spans)
                ),
            }],
            details: serde_json::json!({
                "path": path_str,
                "match_kind": match_kind,
                "replacement_count": replacement_count,
                "diff": diff_result.unified,
                "first_changed_line": diff_result.first_changed_line,
                "added_lines": diff_result.added_lines,
                "removed_lines": diff_result.removed_lines,
                "preview_rendered": ctx.on_update.is_some(),
            }),
            retention: Retention::Normal,
        })
    }
}

impl EditFileTool {
    /// Parse edits from params.
    fn parse_edits(&self, params: &serde_json::Value) -> Result<Vec<(String, String)>, ToolError> {
        let arr = params["edits"]
            .as_array()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'edits' parameter".into()))?;
        if arr.is_empty() {
            return Err(ToolError::InvalidArgs("edits[] must not be empty".into()));
        }
        let n = arr.len();
        let mut edits = Vec::with_capacity(arr.len());
        for (i, entry) in arr.iter().enumerate() {
            let old = entry
                .get("oldText")
                .or_else(|| entry.get("old_text"))
                .or_else(|| entry.get("old_string"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| ToolError::InvalidArgs(format!("edits[{i}] missing oldText")))?;
            let new = entry
                .get("newText")
                .or_else(|| entry.get("new_text"))
                .or_else(|| entry.get("new_string"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| ToolError::InvalidArgs(format!("edits[{i}] missing newText")))?;
            let old_lf = normalize_to_lf(old);
            let new_lf = normalize_to_lf(new);
            if old_lf.is_empty() {
                return Err(ToolError::Failed(format!(
                    "edits[{i}].oldText must not be empty."
                )));
            }
            if old_lf == new_lf {
                return Err(ToolError::Failed(format!(
                    "{}oldText and newText are identical; nothing to change. \
                     Put the current file content in oldText and the desired content in newText.",
                    edit_prefix(i, n)
                )));
            }
            edits.push((old_lf, new_lf));
        }
        Ok(edits)
    }

    /// Format a match error with helpful hints.
    fn match_error(
        &self,
        e: MatchError,
        path_str: &str,
        old_text_lf: &str,
        content_lf: &str,
        idx: usize,
    ) -> ToolError {
        let prefix = if idx > 0 {
            format!("edits[{idx}]: ")
        } else {
            String::new()
        };
        match e {
            MatchError::EmptyOldText => {
                ToolError::Failed(format!("{prefix}oldText must not be empty."))
            }
            MatchError::NotFound => {
                let suffix = match hint::not_found_hint(content_lf, old_text_lf) {
                    Some(h) => format!(
                        "\n\n{h}\nThe file may have changed since you last read it \
                         (including by your own earlier edits). Use the current content above as oldText."
                    ),
                    None => "\n\nTip: Use Read to see the current file contents.".into(),
                };
                ToolError::Failed(format!("{prefix}oldText not found in {path_str}.{suffix}"))
            }
            MatchError::NotUnique { lines } => {
                let count = lines.len();
                let line_list = lines
                    .iter()
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                let total = snippet::line_count(content_lf);
                let mut msg = format!(
                    "{prefix}oldText matches {count} locations in {path_str} (lines {line_list}). \
                     Include more surrounding context to make the match unique.\n"
                );
                for &line in lines.iter().take(MAX_LOCATIONS_SHOWN) {
                    let range = snippet::LineRange {
                        start: line,
                        end: line,
                    }
                    .widen(2, total);
                    msg.push_str(&format!(
                        "\nLine {line}:\n{}",
                        snippet::render(content_lf, range, &[line], 5)
                    ));
                }
                ToolError::Failed(msg)
            }
        }
    }
}

// ─── Matching ─────────────────────────────────────────────────────────────
//
// Tiered fallback strategy:
// 1. Exact match
// 2. Unicode-normalized match (quotes + dashes + Unicode spaces → ASCII)
// 3. Trailing-whitespace-insensitive line match
// 4. Full normalization (unicode + trailing ws combined)
// 5. NFKC-normalized line match (compatibility forms + unicode + trailing ws)
//
// All functions are pure — no IO, no side effects.

/// How the match was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    Exact,
    UnicodeNormalized,
    WhitespaceInsensitive,
    FullNormalized,
    NfkcNormalized,
}

impl MatchKind {
    /// Stable string representation for serialization/details.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::UnicodeNormalized => "unicode_normalized",
            Self::WhitespaceInsensitive => "whitespace_insensitive",
            Self::FullNormalized => "full_normalized",
            Self::NfkcNormalized => "nfkc_normalized",
        }
    }
}

/// A successfully resolved match — contains the actual text from the original
/// file content that can be used directly with `replace_range`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMatch {
    pub actual_old_text: String,
    pub byte_offset: usize,
    pub kind: MatchKind,
}

/// Matching errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchError {
    EmptyOldText,
    NotFound,
    /// The text matched multiple locations. `lines` holds the 1-based line
    /// number where each match begins, so the error can point the model at the
    /// exact spots that need more surrounding context.
    NotUnique {
        lines: Vec<usize>,
    },
}

/// Resolve a unique match of `old_text_lf` within `content_lf`.
///
/// Both inputs must already be LF-normalized.
/// Returns the actual text slice from `content_lf` that should be replaced.
pub fn resolve_unique_match(
    content_lf: &str,
    old_text_lf: &str,
) -> Result<ResolvedMatch, MatchError> {
    if old_text_lf.is_empty() {
        return Err(MatchError::EmptyOldText);
    }

    // Level 1: Exact match
    let count = content_lf.matches(old_text_lf).count();
    if count == 1 {
        // Safe: count == 1 guarantees find() returns the unique position
        let byte_offset = content_lf.find(old_text_lf).unwrap_or(0);
        return Ok(ResolvedMatch {
            actual_old_text: old_text_lf.to_string(),
            byte_offset,
            kind: MatchKind::Exact,
        });
    }
    if count > 1 {
        // Collect the 1-based line number of each match start.
        let mut lines = Vec::with_capacity(count);
        let mut search_from = 0;
        while let Some(rel) = content_lf[search_from..].find(old_text_lf) {
            let abs = search_from + rel;
            lines.push(byte_offset_to_line(content_lf, abs));
            search_from = abs + old_text_lf.len();
        }
        return Err(MatchError::NotUnique { lines });
    }

    // Level 2: Unicode-normalized match (1:1 char mapping)
    if let Some(result) = try_unicode_normalized(content_lf, old_text_lf) {
        return result;
    }

    // Level 3: Trailing-whitespace-insensitive line match
    if let Some(result) = try_whitespace_insensitive(content_lf, old_text_lf) {
        return result;
    }

    // Level 4: Full normalization (unicode + trailing ws combined)
    if let Some(result) = try_full_normalized(content_lf, old_text_lf) {
        return result;
    }

    // Level 5: NFKC-normalized line match (compatibility forms — full-width
    // CJK punctuation / Latin, combined with unicode + trailing ws).
    if let Some(result) = try_nfkc_normalized(content_lf, old_text_lf) {
        return result;
    }

    Err(MatchError::NotFound)
}

/// Level 2: Try matching after normalizing Unicode characters to ASCII equivalents.
///
/// Because `normalize_unicode` is a 1:1 char mapping, char indices in the
/// normalized string correspond exactly to char indices in the original.
fn try_unicode_normalized(
    content_lf: &str,
    old_text_lf: &str,
) -> Option<Result<ResolvedMatch, MatchError>> {
    let norm_content = normalize_unicode(content_lf);
    let norm_old = normalize_unicode(old_text_lf);

    // If normalization didn't change anything, skip (already tried exact)
    if norm_content == content_lf && norm_old == old_text_lf {
        return None;
    }

    let norm_old_chars: Vec<char> = norm_old.chars().collect();
    let norm_content_chars: Vec<char> = norm_content.chars().collect();
    let search_len = norm_old_chars.len();

    if search_len == 0 || norm_content_chars.len() < search_len {
        return None;
    }

    let mut matches: Vec<usize> = Vec::new();
    for i in 0..=norm_content_chars.len() - search_len {
        if norm_content_chars[i..i + search_len] == norm_old_chars[..] {
            matches.push(i);
        }
    }

    match matches.len() {
        0 => None,
        1 => {
            // Map char index to byte offset
            let start_char = matches[0];
            let byte_offset = content_lf
                .chars()
                .take(start_char)
                .map(|c| c.len_utf8())
                .sum();
            let actual: String = content_lf
                .chars()
                .skip(start_char)
                .take(search_len)
                .collect();
            Some(Ok(ResolvedMatch {
                actual_old_text: actual,
                byte_offset,
                kind: MatchKind::UnicodeNormalized,
            }))
        }
        count => {
            // Map each matching char index to a 1-based line number.
            let lines = matches
                .iter()
                .take(count)
                .map(|&start_char| {
                    let byte_offset: usize = content_lf
                        .chars()
                        .take(start_char)
                        .map(|c| c.len_utf8())
                        .sum();
                    byte_offset_to_line(content_lf, byte_offset)
                })
                .collect();
            Some(Err(MatchError::NotUnique { lines }))
        }
    }
}

/// A line span: byte range `[start, end)` within the source string.
struct LineSpan {
    start: usize,
    /// Byte offset one past the end of this line (including its `\n`, if any).
    end: usize,
    /// Byte offset of the end of the line content (excluding `\n`).
    content_end: usize,
}

/// Build a line span table for `text`. Each entry records the byte range of one line.
fn build_line_spans(text: &str) -> Vec<LineSpan> {
    let mut spans = Vec::new();
    let mut pos = 0;
    for line in text.split('\n') {
        let content_end = pos + line.len();
        let end = if content_end < text.len() {
            content_end + 1
        } else {
            content_end
        };
        spans.push(LineSpan {
            start: pos,
            end,
            content_end,
        });
        pos = end;
    }
    spans
}

/// Resolve byte range from a line-based match.
fn line_match_byte_range(
    content_spans: &[LineSpan],
    start_line: usize,
    line_count: usize,
    old_text_lf: &str,
) -> (usize, usize) {
    let last = start_line + line_count - 1;
    let byte_start = content_spans[start_line].start;
    let byte_end = if old_text_lf.ends_with('\n') {
        content_spans[last].end
    } else {
        content_spans[last].content_end
    };
    (byte_start, byte_end)
}

/// Level 3: Try matching lines with trailing whitespace stripped on both sides.
fn try_whitespace_insensitive(
    content_lf: &str,
    old_text_lf: &str,
) -> Option<Result<ResolvedMatch, MatchError>> {
    let old_lines: Vec<&str> = old_text_lf.lines().collect();
    let content_spans = build_line_spans(content_lf);

    if old_lines.is_empty() || content_spans.len() < old_lines.len() {
        return None;
    }

    let mut matches: Vec<usize> = Vec::new();
    for i in 0..=content_spans.len() - old_lines.len() {
        let all_match = old_lines.iter().enumerate().all(|(j, old_line)| {
            let span = &content_spans[i + j];
            content_lf[span.start..span.content_end].trim_end() == old_line.trim_end()
        });
        if all_match {
            matches.push(i);
        }
    }

    match matches.len() {
        0 => None,
        1 => {
            let (byte_start, byte_end) =
                line_match_byte_range(&content_spans, matches[0], old_lines.len(), old_text_lf);
            let actual = content_lf[byte_start..byte_end].to_string();
            Some(Ok(ResolvedMatch {
                actual_old_text: actual,
                byte_offset: byte_start,
                kind: MatchKind::WhitespaceInsensitive,
            }))
        }
        _ => Some(Err(MatchError::NotUnique {
            lines: matches.iter().map(|&i| i + 1).collect(),
        })),
    }
}

/// Level 4: Combined unicode normalization + trailing whitespace stripping.
/// Handles cases where quotes/dashes AND trailing whitespace differ simultaneously.
fn try_full_normalized(
    content_lf: &str,
    old_text_lf: &str,
) -> Option<Result<ResolvedMatch, MatchError>> {
    let old_lines: Vec<&str> = old_text_lf.lines().collect();
    let content_spans = build_line_spans(content_lf);

    if old_lines.is_empty() || content_spans.len() < old_lines.len() {
        return None;
    }

    // Pre-normalize old_text lines: unicode + trim trailing ws
    let norm_old_lines: Vec<String> = old_lines
        .iter()
        .map(|l| normalize_unicode(l).trim_end().to_string())
        .collect();

    let mut matches: Vec<usize> = Vec::new();
    for i in 0..=content_spans.len() - norm_old_lines.len() {
        let all_match = norm_old_lines.iter().enumerate().all(|(j, norm_old_line)| {
            let span = &content_spans[i + j];
            let content_line = &content_lf[span.start..span.content_end];
            let norm_content_line = normalize_unicode(content_line);
            norm_content_line.trim_end() == norm_old_line.as_str()
        });
        if all_match {
            matches.push(i);
        }
    }

    match matches.len() {
        0 => None,
        1 => {
            let (byte_start, byte_end) =
                line_match_byte_range(&content_spans, matches[0], old_lines.len(), old_text_lf);
            let actual = content_lf[byte_start..byte_end].to_string();
            Some(Ok(ResolvedMatch {
                actual_old_text: actual,
                byte_offset: byte_start,
                kind: MatchKind::FullNormalized,
            }))
        }
        _ => Some(Err(MatchError::NotUnique {
            lines: matches.iter().map(|&i| i + 1).collect(),
        })),
    }
}

/// Level 5: NFKC compatibility normalization + unicode + trailing whitespace.
///
/// Handles compatibility forms that the 1:1 mapping in `normalize_unicode`
/// cannot cover — e.g. full-width CJK punctuation/Latin (，：（）￥),
/// ideographic spaces, and other NFKC-foldable characters. NFKC is not a
/// length-preserving 1:1 mapping, so this works line-by-line and resolves the
/// byte range from the original content (like Levels 3 and 4).
fn try_nfkc_normalized(
    content_lf: &str,
    old_text_lf: &str,
) -> Option<Result<ResolvedMatch, MatchError>> {
    let old_lines: Vec<&str> = old_text_lf.lines().collect();
    let content_spans = build_line_spans(content_lf);

    if old_lines.is_empty() || content_spans.len() < old_lines.len() {
        return None;
    }

    // Pre-normalize old_text lines: NFKC + unicode + trim trailing ws.
    let norm_old_lines: Vec<String> = old_lines.iter().map(|l| normalize_nfkc_line(l)).collect();

    let mut matches: Vec<usize> = Vec::new();
    for i in 0..=content_spans.len() - norm_old_lines.len() {
        let all_match = norm_old_lines.iter().enumerate().all(|(j, norm_old_line)| {
            let span = &content_spans[i + j];
            let content_line = &content_lf[span.start..span.content_end];
            normalize_nfkc_line(content_line) == *norm_old_line
        });
        if all_match {
            matches.push(i);
        }
    }

    match matches.len() {
        0 => None,
        1 => {
            let (byte_start, byte_end) =
                line_match_byte_range(&content_spans, matches[0], old_lines.len(), old_text_lf);
            let actual = content_lf[byte_start..byte_end].to_string();
            Some(Ok(ResolvedMatch {
                actual_old_text: actual,
                byte_offset: byte_start,
                kind: MatchKind::NfkcNormalized,
            }))
        }
        _ => Some(Err(MatchError::NotUnique {
            lines: matches.iter().map(|&i| i + 1).collect(),
        })),
    }
}

// ─── Result rendering ──────────────────────────────────────────────────────

/// Max ambiguous match locations rendered with context.
const MAX_LOCATIONS_SHOWN: usize = 5;
/// Context lines around each changed region in the success message.
const REGION_CONTEXT: usize = 3;
/// Cap on rendered lines per changed region.
const REGION_MAX_LINES: usize = 40;

/// `edits[i]: ` prefix, omitted for single-edit calls.
fn edit_prefix(i: usize, total: usize) -> String {
    if total > 1 {
        format!("edits[{i}].")
    } else {
        String::new()
    }
}

/// Render the post-edit content around every replaced span so the model's
/// view of the file stays current for follow-up edits.
fn changed_regions(new_content: &str, spans: &[(usize, usize)]) -> String {
    let total = snippet::line_count(new_content);
    let ranges = snippet::merge_ranges(
        spans
            .iter()
            .map(|&(s, e)| snippet::range_of_span(new_content, s, e).widen(REGION_CONTEXT, total))
            .collect(),
        0,
    );
    let mut out = String::from("Current content of the changed region(s):\n");
    for r in ranges {
        out.push_str(&format!(
            "\nLines {}-{}:\n{}",
            r.start,
            r.end,
            snippet::render(new_content, r, &[], REGION_MAX_LINES)
        ));
    }
    out
}

// ─── Normalization ─────────────────────────────────────────────────────────
//
// Text normalization primitives for edit matching.
// All functions are pure — no IO, no side effects.

/// Line ending style detected in file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
}

/// Detect the dominant line ending in `content` by counting occurrences.
pub fn detect_line_ending(content: &str) -> LineEnding {
    let crlf = content.matches("\r\n").count();
    let lf = content.matches('\n').count().saturating_sub(crlf);
    if crlf > lf {
        LineEnding::CrLf
    } else {
        LineEnding::Lf
    }
}

/// Normalize all line endings to LF.
pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Restore line endings from LF to the given style.
pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
    match ending {
        LineEnding::Lf => text.to_string(),
        LineEnding::CrLf => text.replace('\n', "\r\n"),
    }
}

/// Strip UTF-8 BOM if present.
pub fn strip_utf8_bom(content: &str) -> (&str, &str) {
    if let Some(stripped) = content.strip_prefix('\u{FEFF}') {
        ("\u{FEFF}", stripped)
    } else {
        ("", content)
    }
}

/// Normalize Unicode characters to ASCII equivalents.
///
/// IMPORTANT: This is a length-preserving, 1:1 Unicode character replacement.
/// Each source char maps to exactly one output char. This invariant is relied
/// upon by the matching code to map char indices between normalized and original.
///
/// Covers: curly quotes, Unicode dashes/hyphens, and Unicode spaces (NBSP,
/// narrow NBSP, the U+2000–U+200A range, medium math space, and the
/// ideographic space U+3000). Every replacement maps one char to one char.
pub fn normalize_unicode(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            // Smart single quotes → '
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // Smart double quotes → "
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // Dashes/hyphens → -
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            // Unicode spaces → regular space (each is a single char → single space)
            // NBSP, en/em quad range, narrow NBSP, medium math space, ideographic space
            '\u{00A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// Normalize a single line for NFKC-tier matching: apply NFKC compatibility
/// normalization, then the 1:1 unicode folding, then strip trailing whitespace.
///
/// NFKC folds compatibility characters (full-width CJK punctuation/Latin,
/// ligatures, etc.) into their canonical forms. It is *not* length-preserving,
/// so callers must resolve byte ranges from the original content rather than
/// mapping char indices.
fn normalize_nfkc_line(line: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfkc: String = line.nfkc().collect();
    normalize_unicode(&nfkc).trim_end().to_string()
}

/// Preserve the curly-quote style from the file when the match was
/// unicode-normalized.
///
/// When `actual_old_text` (from the file) contains curly quotes but
/// `old_text` (from the agent) used straight quotes, we apply the same
/// curly style to `new_text` so the replacement doesn't break the file's
/// typography.
pub fn preserve_quote_style(old_text: &str, actual_old_text: &str, new_text: &str) -> String {
    if old_text == actual_old_text {
        return new_text.to_string();
    }

    let has_double = actual_old_text.contains('\u{201C}') || actual_old_text.contains('\u{201D}');
    let has_single = actual_old_text.contains('\u{2018}') || actual_old_text.contains('\u{2019}');

    if !has_double && !has_single {
        return new_text.to_string();
    }

    let mut result = new_text.to_string();
    if has_double {
        result = apply_curly_double_quotes(&result);
    }
    if has_single {
        result = apply_curly_single_quotes(&result);
    }
    result
}

/// Returns `true` if the character before `index` is whitespace, start of
/// string, or an opening bracket — i.e. the quote at `index` is an opening quote.
fn is_opening_context(chars: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    matches!(
        chars[index - 1],
        ' ' | '\t' | '\n' | '\r' | '(' | '[' | '{' | '\u{2014}' | '\u{2013}'
    )
}

fn apply_curly_double_quotes(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '"' {
            if is_opening_context(&chars, i) {
                out.push('\u{201C}');
            } else {
                out.push('\u{201D}');
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn apply_curly_single_quotes(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '\'' {
            let prev_is_letter = i > 0 && chars[i - 1].is_alphabetic();
            let next_is_letter = i + 1 < chars.len() && chars[i + 1].is_alphabetic();
            if prev_is_letter && next_is_letter {
                out.push('\u{2019}');
            } else if is_opening_context(&chars, i) {
                out.push('\u{2018}');
            } else {
                out.push('\u{2019}');
            }
        } else {
            out.push(c);
        }
    }
    out
}
