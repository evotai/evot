//! Shared source-language selection for syntax-aware tools.

use tree_sitter::Language;

/// Resolve a tree-sitter language for a file extension. `None` = no grammar.
pub(crate) fn language_for_ext(ext: &str) -> Option<Language> {
    let lang = match ext {
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "py" | "pyi" => tree_sitter_python::LANGUAGE.into(),
        "js" | "jsx" | "mjs" | "cjs" => tree_sitter_javascript::LANGUAGE.into(),
        "ts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "c" | "h" => tree_sitter_c::LANGUAGE.into(),
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => tree_sitter_cpp::LANGUAGE.into(),
        "rb" => tree_sitter_ruby::LANGUAGE.into(),
        _ => return None,
    };
    Some(lang)
}
