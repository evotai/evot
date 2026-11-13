//! Enclosing function signatures for unified-diff hunk headers.

use std::path::Path;

use tree_sitter::Parser;
use tree_sitter::Point;
use tree_sitter::Tree;

use crate::tools::syntax::language_for_ext;

/// Keep generated/minified files from making a display hint expensive.
const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;

pub(super) struct SourceContext<'a> {
    source: &'a str,
    tree: Tree,
    line_starts: Vec<usize>,
}

impl<'a> SourceContext<'a> {
    pub(super) fn parse(source: &'a str, filename: &str) -> Option<Self> {
        if source.is_empty() || source.len() > MAX_SOURCE_BYTES {
            return None;
        }
        let ext = Path::new(filename).extension()?.to_str()?;
        let language = language_for_ext(ext)?;
        let mut parser = Parser::new();
        parser.set_language(&language).ok()?;
        let tree = parser.parse(source, None)?;
        let mut line_starts = vec![0];
        line_starts.extend(source.match_indices('\n').map(|(offset, _)| offset + 1));
        Some(Self {
            source,
            tree,
            line_starts,
        })
    }

    /// `row` is the zero-based changed line, not the first context line of a
    /// hunk (which may still belong to a different function).
    pub(super) fn signature_at(&self, row: usize) -> Option<String> {
        let start = *self.line_starts.get(row)?;
        let end = self
            .line_starts
            .get(row + 1)
            .copied()
            .unwrap_or(self.source.len());
        let text = self.source.get(start..end)?;
        let column = text.len() - text.trim_start_matches([' ', '\t']).len();
        let point = Point::new(row, column);
        let mut node = self
            .tree
            .root_node()
            .descendant_for_point_range(point, point)?;
        loop {
            if matches!(
                node.kind(),
                "function_item"
                    | "function_definition"
                    | "function_declaration"
                    | "generator_function_declaration"
                    | "method_definition"
                    | "method_declaration"
                    | "method"
                    | "singleton_method"
                    | "arrow_function"
                    | "function_expression"
            ) {
                let body = node.child_by_field_name("body")?;
                let mut signature_start = node.start_byte();
                // Give named JS/TS arrow functions their binding, too.
                if matches!(node.kind(), "arrow_function" | "function_expression") {
                    let parent = node.parent()?;
                    if !matches!(parent.kind(), "variable_declarator" | "pair") {
                        node = parent;
                        continue;
                    }
                    signature_start = parent.start_byte();
                }
                let body_start = body.start_byte();
                let signature_end = if self.source.as_bytes().get(body_start) == Some(&b'{') {
                    body_start + 1
                } else {
                    body_start
                };
                let signature = self.source.get(signature_start..signature_end)?;
                // Header text must stay on one line, even for multiline
                // signatures. Never emit terminal controls from source text.
                let signature = signature.split_whitespace().collect::<Vec<_>>().join(" ");
                return Some(signature.chars().filter(|ch| !ch.is_control()).collect());
            }
            node = node.parent()?;
        }
    }
}
