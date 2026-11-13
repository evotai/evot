use evotengine::tools::file::diff::*;

#[test]
fn single_line_replace() {
    let old = "aaa\nbbb\nccc\n";
    let new = "aaa\nxxx\nccc\n";
    let d = unified_diff(old, new, "test.rs");
    assert_eq!(d.added_lines, 1);
    assert_eq!(d.removed_lines, 1);
    assert!(d.unified.contains("-bbb"));
    assert!(d.unified.contains("+xxx"));
}

#[test]
fn multi_line_add() {
    let old = "aaa\nccc\n";
    let new = "aaa\nbbb\nccc\n";
    let d = unified_diff(old, new, "test.rs");
    assert_eq!(d.added_lines, 1);
    assert_eq!(d.removed_lines, 0);
    assert!(d.unified.contains("+bbb"));
}

#[test]
fn multi_line_delete() {
    let old = "aaa\nbbb\nccc\n";
    let new = "aaa\nccc\n";
    let d = unified_diff(old, new, "test.rs");
    assert_eq!(d.added_lines, 0);
    assert_eq!(d.removed_lines, 1);
    assert!(d.unified.contains("-bbb"));
}

#[test]
fn first_changed_line_correct() {
    let old = "line1\nline2\nline3\nline4\n";
    let new = "line1\nline2\nchanged\nline4\n";
    let d = unified_diff(old, new, "test.rs");
    assert_eq!(d.first_changed_line, Some(3));
}

#[test]
fn no_changes_empty_diff() {
    let content = "aaa\nbbb\n";
    let d = unified_diff(content, content, "test.rs");
    assert_eq!(d.added_lines, 0);
    assert_eq!(d.removed_lines, 0);
    assert_eq!(d.first_changed_line, None);
}

#[test]
fn diff_header_format() {
    let d = unified_diff("a\n", "b\n", "foo.rs");
    assert!(d.unified.starts_with("--- a/foo.rs\n+++ b/foo.rs\n"));
}

#[test]
fn function_header_contract_fixture() {
    let old = "fn load() {\n    old();\n}\n";
    let d = unified_diff(old, &old.replace("old();", "new();"), "index.rs");
    assert_eq!(
        d.unified,
        include_str!("../../fixtures/diff/function.patch")
    );
}

#[test]
fn hunk_header_shows_enclosing_function_not_nearby_call_or_comment() {
    let old = "impl Index {\n    pub async fn build(&self) -> Result<()> {\n        // fn misleading()\n        prepare();\n        let a = 1;\n        let b = 2;\n        let c = 3;\n        finish(a);\n        Ok(())\n    }\n}\n";
    let new = old.replace("finish(a)", "finish(b)");
    let d = unified_diff(old, &new, "index.rs");
    let headers: Vec<_> = d
        .unified
        .lines()
        .filter(|line| line.starts_with("@@"))
        .collect();
    assert_eq!(headers.len(), 1);
    assert!(headers[0].ends_with("@@ pub async fn build(&self) -> Result<()> {"));
    assert_eq!((d.added_lines, d.removed_lines), (1, 1));
    assert_eq!(d.first_changed_line, Some(8));
}

#[test]
fn hunk_header_flattens_multiline_signatures() {
    let old = "async fn load(\n    id: u64,\n) -> Result<()> {\n    old();\n}\n";
    let d = unified_diff(old, &old.replace("old();", "new();"), "a.rs");
    assert!(d
        .unified
        .lines()
        .any(|line| line.ends_with("@@ async fn load( id: u64, ) -> Result<()> {")));
}

#[test]
fn hunk_header_uses_changed_line_even_when_context_starts_in_another_function() {
    let old = "fn first() {\n    unchanged();\n}\nfn second() {\n    old();\n}\n";
    let d = unified_diff(old, &old.replace("old();", "new();"), "a.rs");
    assert!(d
        .unified
        .lines()
        .any(|line| line.ends_with("@@ fn second() {")));
}

#[test]
fn separate_hunks_get_their_own_function_signatures() {
    let old = format!(
        "fn first() {{\n    old();\n}}\n{}fn second() {{\n    old();\n}}\n",
        "\n".repeat(12)
    );
    let d = unified_diff(&old, &old.replace("old();", "new();"), "a.rs");
    let headers: Vec<_> = d
        .unified
        .lines()
        .filter(|line| line.starts_with("@@"))
        .collect();
    assert_eq!(headers.len(), 2);
    assert!(headers[0].ends_with("@@ fn first() {"));
    assert!(headers[1].ends_with("@@ fn second() {"));
}

#[test]
fn hunk_signatures_support_source_languages() {
    let cases = [
        (
            "a.py",
            "class Index:\n    async def load(self):\n        old()\n",
            "async def load(self):",
        ),
        (
            "a.ts",
            "class Index {\n  async load(): Promise<void> {\n    old();\n  }\n}\n",
            "async load(): Promise<void> {",
        ),
        (
            "a.tsx",
            "function View() {\n  return old();\n}\n",
            "function View() {",
        ),
        (
            "a.js",
            "const load = () => {\n  old();\n};\n",
            "load = () => {",
        ),
        (
            "a.go",
            "package main\nfunc (i *Index) Load() {\n    old()\n}\n",
            "func (i *Index) Load() {",
        ),
        (
            "a.java",
            "class Index {\n  public void load() {\n    old();\n  }\n}\n",
            "public void load() {",
        ),
        (
            "a.c",
            "void load(void) {\n  old();\n}\n",
            "void load(void) {",
        ),
        (
            "a.cpp",
            "void Index::load() {\n  old();\n}\n",
            "void Index::load() {",
        ),
        (
            "a.rb",
            "class Index\n  def load\n    old()\n  end\nend\n",
            "def load",
        ),
    ];
    for (filename, old, signature) in cases {
        let d = unified_diff(old, &old.replace("old()", "new()"), filename);
        assert!(
            d.unified
                .lines()
                .any(|line| line.ends_with(&format!("@@ {signature}"))),
            "{filename}: {}",
            d.unified
        );
    }
}

#[test]
fn inserted_and_deleted_functions_use_the_available_side() {
    let source = "fn load() {\n    work();\n}\n";
    for (old, new) in [("", source), (source, "")] {
        let d = unified_diff(old, new, "a.rs");
        assert!(d
            .unified
            .lines()
            .any(|line| line.ends_with("@@ fn load() {")));
    }
}

#[test]
fn insertion_inside_function_gets_new_side_context() {
    let old = "fn load() {\n    work();\n}\n";
    let d = unified_diff(
        old,
        &old.replace("    work();", "    setup();\n    work();"),
        "a.rs",
    );
    assert!(d
        .unified
        .lines()
        .any(|line| line.ends_with("@@ fn load() {")));
}

#[test]
fn no_signature_for_unsupported_or_top_level_content() {
    for (filename, old, new) in [
        ("a.txt", "fn load() {\nold\n}\n", "fn load() {\nnew\n}\n"),
        ("a.rs", "const VALUE: u32 = 1;\n", "const VALUE: u32 = 2;\n"),
        (
            "a.ts",
            "function done() {}\n\nconst x = 1;\n",
            "function done() {}\n\nconst x = 2;\n",
        ),
    ] {
        let d = unified_diff(old, new, filename);
        assert!(
            d.unified
                .lines()
                .filter(|line| line.starts_with("@@"))
                .all(|line| line.ends_with("@@")),
            "{}",
            d.unified
        );
    }
}
