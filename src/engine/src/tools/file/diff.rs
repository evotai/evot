//! Unified diff generation for edit results.
//!
//! Uses the `similar` crate (Myers algorithm) for efficient diffing.
//! All functions are pure — no IO, no side effects.

use similar::ChangeTag;
use similar::DiffTag;
use similar::TextDiff;

use super::diff_context::SourceContext;

/// Result of generating a unified diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffResult {
    /// Unified diff string.
    pub unified: String,
    /// Line number (1-based) of the first change in the **new** file content.
    pub first_changed_line: Option<usize>,
    /// Number of lines added.
    pub added_lines: usize,
    /// Number of lines removed.
    pub removed_lines: usize,
}

/// Generate a unified diff between `old` and `new` content, with 3 context lines.
pub fn unified_diff(old: &str, new: &str, filename: &str) -> DiffResult {
    let diff = TextDiff::from_lines(old, new);

    let mut added_lines = 0;
    let mut removed_lines = 0;
    let mut first_changed_line: Option<usize> = None;

    let mut result = String::new();
    result.push_str(&format!("--- a/{filename}\n"));
    result.push_str(&format!("+++ b/{filename}\n"));

    // Lazy parsing: unchanged files need no syntax work, and most edits only
    // need the old tree. Pure insertions use the new tree instead.
    let old_context = std::cell::OnceCell::new();
    let new_context = std::cell::OnceCell::new();
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        let signature = hunk
            .ops()
            .iter()
            .find(|op| op.tag() != DiffTag::Equal)
            .and_then(|op| {
                let (context, row) = if op.old_range().is_empty() {
                    (
                        new_context.get_or_init(|| SourceContext::parse(new, filename)),
                        op.new_range().start,
                    )
                } else {
                    (
                        old_context.get_or_init(|| SourceContext::parse(old, filename)),
                        op.old_range().start,
                    )
                };
                context.as_ref()?.signature_at(row)
            });
        // A standard unified-diff section heading: older consumers already
        // ignore the optional suffix, so no tool-result schema change is needed.
        let header = hunk.header().to_string();
        result.push_str(header.trim_end_matches('\n'));
        if let Some(signature) = signature {
            result.push(' ');
            result.push_str(&signature);
        }
        result.push('\n');

        for change in hunk.iter_changes() {
            let sign = match change.tag() {
                ChangeTag::Delete => '-',
                ChangeTag::Insert => '+',
                ChangeTag::Equal => ' ',
            };
            result.push(sign);
            result.push_str(change.value());
            if change.missing_newline() {
                result.push('\n');
            }

            match change.tag() {
                ChangeTag::Insert => {
                    added_lines += 1;
                    if first_changed_line.is_none() {
                        first_changed_line = change.new_index().map(|i| i + 1);
                    }
                }
                ChangeTag::Delete => {
                    removed_lines += 1;
                    if first_changed_line.is_none() {
                        // For removals, report the corresponding new-file line
                        first_changed_line = change.old_index().map(|i| i + 1);
                    }
                }
                ChangeTag::Equal => {}
            }
        }
    }

    DiffResult {
        unified: result,
        first_changed_line,
        added_lines,
        removed_lines,
    }
}
