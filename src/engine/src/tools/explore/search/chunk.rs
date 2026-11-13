//! Code-aware chunking via tree-sitter.
//!
//! Splits source files into semantic units (functions, classes, structs, …)
//! using tree-sitter grammars. Files in unsupported languages fall back to
//! fixed-size line windows so they remain searchable.

use std::path::Path;

use tree_sitter::Parser;

use crate::tools::syntax::language_for_ext;

/// A searchable unit of code with its location and tokenized content.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    /// Lowercased word tokens (for BM25).
    pub tokens: Vec<String>,
    /// Symbol name this chunk defines, if it is a definition (for ranking + scope label).
    pub defines: Option<String>,
}

/// Min lines for a tree-sitter node to become its own chunk.
const MIN_CHUNK_LINES: usize = 3;
/// Max lines per chunk; larger nodes are split into windows.
const MAX_CHUNK_LINES: usize = 60;
/// Fixed window size for the fallback path.
const FALLBACK_WINDOW: usize = 30;
/// Skip files larger than this; generated/minified blobs add cost, not signal.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Node kinds that represent a meaningful, named definition chunk.
fn is_chunk_node(kind: &str) -> bool {
    matches!(
        kind,
        // Rust
        "function_item" | "impl_item" | "struct_item" | "enum_item" | "trait_item"
            | "mod_item" | "macro_definition" | "type_item"
        // Python
            | "function_definition" | "class_definition" | "decorated_definition"
        // JS / TS
            | "function_declaration" | "class_declaration" | "method_definition"
            | "generator_function_declaration" | "export_statement"
            | "interface_declaration" | "type_alias_declaration"
        // Go
            | "method_declaration" | "type_declaration"
        // C / C++
            | "struct_specifier" | "class_specifier"
        // Ruby
            | "method" | "class" | "module"
    )
}

/// Tokenize text into lowercased identifier-ish words (len >= 2), expanding
/// multi-part identifiers into their stems so natural-language queries match
/// `snake_case` / `camelCase` names. e.g. `authenticate_user` indexes as
/// ["authenticate_user", "authenticate", "user"].
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if word.len() < 2 {
            continue;
        }
        let lower = word.to_lowercase();
        let stems = split_identifier(word);
        out.push(lower);
        if stems.len() > 1 {
            out.extend(stems.into_iter().filter(|s| s.len() >= 2));
        }
    }
    out
}

/// Split a camelCase / snake_case / PascalCase identifier into lowercased
/// stems. e.g. `parseConfig` -> ["parse", "config"], `config_parser` ->
/// ["config", "parser"].
pub fn split_identifier(ident: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    for ch in ident.chars() {
        if ch == '_' || ch == '-' {
            if !cur.is_empty() {
                parts.push(std::mem::take(&mut cur).to_lowercase());
            }
        } else if ch.is_uppercase() && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur).to_lowercase());
            cur.push(ch);
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        parts.push(cur.to_lowercase());
    }
    parts
}

/// Chunk a single file. Reads it, picks tree-sitter or fixed-window chunking.
pub fn chunk_file(path: &Path) -> Vec<Chunk> {
    // Skip oversized files (generated bundles, vendored blobs) before reading
    // them into memory — they cost build time without adding search signal.
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
        return Vec::new();
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let path_str = path.to_string_lossy().into_owned();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    if let Some(lang) = language_for_ext(ext) {
        let mut parser = Parser::new();
        if parser.set_language(&lang).is_ok() {
            if let Some(tree) = parser.parse(&content, None) {
                let chunks = chunks_from_tree(&content, &path_str, &tree);
                if !chunks.is_empty() {
                    return chunks;
                }
            }
        }
    }
    chunk_fixed(&content, &path_str)
}

/// Extract chunks from a parsed syntax tree (top-level definitions only).
fn chunks_from_tree(content: &str, path_str: &str, tree: &tree_sitter::Tree) -> Vec<Chunk> {
    let lines: Vec<&str> = content.lines().collect();
    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut chunks = Vec::new();

    for node in root.children(&mut cursor) {
        if !is_chunk_node(node.kind()) {
            continue;
        }
        let start = node.start_position().row;
        let end = node.end_position().row + 1; // exclusive
        if end.saturating_sub(start) < MIN_CHUNK_LINES {
            continue;
        }
        let defines = node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(content.as_bytes()).ok())
            .map(str::to_string);

        if end - start > MAX_CHUNK_LINES {
            // Split oversized node into windows; only the first carries `defines`.
            let mut s = start;
            let mut first = true;
            while s < end {
                let e = (s + MAX_CHUNK_LINES).min(end);
                push_chunk(
                    &mut chunks,
                    &lines,
                    path_str,
                    s,
                    e,
                    if first { defines.clone() } else { None },
                );
                first = false;
                s = e;
            }
        } else {
            push_chunk(&mut chunks, &lines, path_str, start, end, defines);
        }
    }
    chunks
}

/// Fixed-window fallback for files without a tree-sitter grammar.
fn chunk_fixed(content: &str, path_str: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = content.lines().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        let end = (start + FALLBACK_WINDOW).min(lines.len());
        push_chunk(&mut chunks, &lines, path_str, start, end, None);
        start = end;
    }
    chunks
}

/// Build a chunk from a line range `[start, end)` (0-indexed) and append it
/// if it contains any tokens. Stored line numbers are 1-indexed.
fn push_chunk(
    chunks: &mut Vec<Chunk>,
    lines: &[&str],
    path_str: &str,
    start: usize,
    end: usize,
    defines: Option<String>,
) {
    let text = lines[start..end].join("\n");
    let tokens = tokenize(&text);
    if tokens.is_empty() {
        return;
    }
    chunks.push(Chunk {
        file_path: path_str.to_string(),
        start_line: start + 1,
        end_line: end,
        content: text,
        tokens,
        defines,
    });
}
