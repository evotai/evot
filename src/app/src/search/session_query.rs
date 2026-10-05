//! Command arguments for semantic session retrieval.

/// Lookback when the user gives no window.
pub const DEFAULT_WINDOW_DAYS: u32 = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSearch {
    pub query: String,
    /// `None` means the whole archive (`--all`).
    pub window_days: Option<u32>,
}

impl SessionSearch {
    /// Parse the argument string after `/sessions`: `--days N`,
    /// `--since <N>[dwmy]` and `--all` set the window; the rest is the query.
    /// `None` when no query remains or a window value is malformed.
    pub fn parse(args: &str) -> Option<Self> {
        let mut window_days = Some(DEFAULT_WINDOW_DAYS);
        let mut query = Vec::new();
        let mut tokens = args.split_whitespace();
        while let Some(token) = tokens.next() {
            if token == "--all" {
                window_days = None;
                continue;
            }
            let value = match token.split_once('=') {
                Some(("--days" | "--since", value)) => Some(value),
                None if token == "--days" || token == "--since" => tokens.next(),
                _ => {
                    query.push(token);
                    continue;
                }
            };
            window_days = Some(parse_window(value?)?);
        }
        let query = unquote(&query.join(" ")).to_string();
        (!query.is_empty()).then_some(Self { query, window_days })
    }

    pub fn describe_window(&self) -> String {
        match self.window_days {
            None => "all time".to_string(),
            Some(days) => describe_days(days),
        }
    }
}

fn parse_window(value: &str) -> Option<u32> {
    let (digits, unit) = match value.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((index, _)) => value.split_at(index),
        None => (value, "d"),
    };
    let amount: u32 = digits.parse().ok().filter(|amount| *amount > 0)?;
    let per_unit = match unit.to_ascii_lowercase().as_str() {
        "d" => 1,
        "w" => 7,
        "m" => 30,
        "y" => 365,
        _ => return None,
    };
    amount.checked_mul(per_unit)
}

fn describe_days(days: u32) -> String {
    let unit = |count: u32, singular: &str, plural: &str| {
        if count == 1 {
            format!("last {singular}")
        } else {
            format!("last {count} {plural}")
        }
    };
    if days.is_multiple_of(365) {
        unit(days / 365, "year", "years")
    } else if days.is_multiple_of(30) {
        unit(days / 30, "month", "months")
    } else if days.is_multiple_of(7) {
        unit(days / 7, "week", "weeks")
    } else {
        unit(days, "day", "days")
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
