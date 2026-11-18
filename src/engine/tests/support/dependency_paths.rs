//! Explicit in-crate paths in Rust syntax (not name resolution or macro expansion).
use std::path::Path;

use syn::visit::Visit;
use syn::UseTree;

pub fn module_path(relative: &Path) -> Vec<String> {
    let mut parts: Vec<_> = relative
        .with_extension("")
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if parts.last().is_some_and(|p| p == "mod" || p == "lib") {
        parts.pop();
    }
    parts
}

pub fn dependencies(source: &str, module: &[String]) -> syn::Result<Vec<Vec<String>>> {
    let mut visitor = Paths {
        module: module.to_vec(),
        found: Vec::new(),
    };
    visitor.visit_file(&syn::parse_file(source)?);
    Ok(visitor.found)
}

struct Paths {
    module: Vec<String>,
    found: Vec<Vec<String>>,
}

impl Paths {
    fn record(&mut self, segments: &[String]) {
        let Some((first, mut rest)) = segments.split_first() else {
            return;
        };
        let mut path = match first.as_str() {
            "crate" => Vec::new(),
            "self" => self.module.clone(),
            "super" => {
                let mut path = self.module.clone();
                path.pop();
                while let Some(("super", tail)) = rest.split_first().map(|(s, r)| (s.as_str(), r)) {
                    path.pop();
                    rest = tail;
                }
                path
            }
            _ => return,
        };
        path.extend_from_slice(rest);
        self.found.push(path);
    }

    fn import(&mut self, prefix: &mut Vec<String>, tree: &UseTree) {
        match tree {
            UseTree::Path(p) => {
                prefix.push(p.ident.to_string());
                self.import(prefix, &p.tree);
                prefix.pop();
            }
            UseTree::Group(g) => {
                for item in &g.items {
                    self.import(prefix, item);
                }
            }
            UseTree::Glob(_) => self.record(prefix),
            leaf => {
                let name = match leaf {
                    UseTree::Name(n) => &n.ident,
                    UseTree::Rename(n) => &n.ident,
                    _ => return,
                };
                prefix.push(name.to_string());
                self.record(prefix);
                prefix.pop();
            }
        }
    }
}

impl<'ast> Visit<'ast> for Paths {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.module.push(node.ident.to_string());
        syn::visit::visit_item_mod(self, node);
        self.module.pop();
    }
    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        self.import(&mut Vec::new(), &node.tree);
    }
    fn visit_path(&mut self, node: &'ast syn::Path) {
        self.record(
            &node
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect::<Vec<_>>(),
        );
        syn::visit::visit_path(self, node);
    }
}

#[test]
fn equivalent_imports_resolve_to_the_same_dependency() -> syn::Result<()> {
    for import in [
        "use crate::agent::X;",
        "use crate::{\nagent::{X as Y},\n};",
        "use super::super::{agent::X};",
        "mod nested { use super::super::super::agent::X; }",
    ] {
        assert_eq!(dependencies(import, &["base".into(), "io".into()])?, [[
            "agent", "X"
        ]]);
    }
    Ok(())
}
