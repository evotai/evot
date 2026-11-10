//! Command arguments for semantic session retrieval.

/// The free-text request after `/sessions`. The model reads the time range
/// and the topic out of the natural-language request itself; no flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSearch {
    pub query: String,
}

impl SessionSearch {
    /// Parse the argument string after `/sessions`. The whole text is the
    /// query; `None` when nothing remains after trimming surrounding quotes.
    pub fn parse(args: &str) -> Option<Self> {
        let query = unquote(args).to_string();
        (!query.is_empty()).then_some(Self { query })
    }
}

fn unquote(query: &str) -> &str {
    let query = query.trim();
    for (open, close) in [
        ("'", "'"),
        ("\"", "\""),
        ("\u{2018}", "\u{2019}"),
        ("\u{201c}", "\u{201d}"),
    ] {
        if let Some(inner) = query
            .strip_prefix(open)
            .and_then(|value| value.strip_suffix(close))
        {
            return inner.trim();
        }
    }
    query
}
