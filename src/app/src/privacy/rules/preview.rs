//! Show the shape of a match without copying any credential body.

const MASK: &str = "[mask]";

/// Public format markers, not arbitrary first characters from a credential.
fn masked(value: &str) -> String {
    const PREFIXES: &[&str] = &[
        "github_pat_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "glpat-",
        "npm_",
        "sk-proj-",
        "sk-svcacct-",
        "sk-or-v1-",
        "sk-ant-api03-",
        "sk-",
        "xoxb-",
        "xoxp-",
        "AKIA",
        "ASIA",
        "AIza",
        "AKID",
        "AKLT",
        "LTAI",
        "hf_",
        "gsk_",
        "xai-",
        "pypi-",
        "t-g",
        "u-g",
    ];
    let prefix = PREFIXES.iter().find(|&&prefix| {
        value.strip_prefix(prefix).is_some_and(|body| {
            body.len() >= 20 || (matches!(prefix, "AKIA" | "ASIA" | "LTAI") && body.len() >= 12)
        })
    });
    match prefix {
        Some(prefix) => format!("{prefix}{MASK}"),
        None => MASK.into(),
    }
}

pub(super) fn pattern(rule: &str, before: &str, value: &str) -> Option<String> {
    match rule {
        "contexts.authorization" => {
            let (head, scheme) = before.trim_end().rsplit_once([':', '='])?;
            let header = identifier(head)?;
            let scheme = scheme.trim().trim_start_matches(['\'', '"']);
            let scheme = ["Bearer", "Basic", "Token"]
                .into_iter()
                .find(|name| name.eq_ignore_ascii_case(scheme))?;
            Some(format!("{header}: {scheme} {}", masked(value)))
        }
        "contexts.url-password" => {
            let scheme = before.split_once("://")?.0;
            let scheme = [
                "postgres",
                "postgresql",
                "mysql",
                "mariadb",
                "redis",
                "rediss",
                "mongodb",
                "mongodb+srv",
                "databend",
                "bend",
                "http",
                "https",
                "ftp",
                "amqp",
                "amqps",
            ]
            .into_iter()
            .find(|name| name.eq_ignore_ascii_case(scheme))
            .unwrap_or("<scheme>");
            Some(format!("{scheme}://<user>:{MASK}@<host>"))
        }
        "contexts.password-assignment" | "contexts.credential-assignment" => {
            assignment(before, value, rule == "contexts.password-assignment")
        }
        "contexts.curl-user" => {
            let (command, _) = before.rsplit_once(':')?;
            let flag = if command.contains("--user") {
                "--user"
            } else {
                "-u"
            };
            Some(format!("curl {flag} <user>:{MASK}"))
        }
        "contexts.cjk-password" => Some(format!("<password label>: {MASK}")),
        "formats.jwt" => Some(format!("eyJ{MASK}.eyJ{MASK}.{MASK}")),
        rule if rule.starts_with("formats.") => Some(masked(value)),
        _ => None,
    }
}

/// First token in the regex match: at most the bounded identifier, never a line.
fn identifier(text: &str) -> Option<&str> {
    let text =
        text.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || "{(,;\"'".contains(ch));
    let end = text
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || "_.-".contains(ch)))
        .unwrap_or(text.len());
    (1..=96).contains(&end).then(|| &text[..end])
}

fn assignment(before: &str, value: &str, password: bool) -> Option<String> {
    let name = identifier(before)?;
    let quote = before
        .trim_end()
        .chars()
        .last()
        .filter(|ch| matches!(ch, '\'' | '"'));
    let lhs = before.trim_end().trim_end_matches(['\'', '"']).trim_end();
    let op = if lhs.ends_with(":=") {
        ":="
    } else if lhs.ends_with('=') {
        "="
    } else {
        ": "
    };
    let value = if password { MASK.into() } else { masked(value) };
    let value = match quote {
        Some(quote) => format!("{quote}{value}{quote}"),
        None => value,
    };
    let name = if lhs
        .trim_start()
        .trim_start_matches(['{', '(', ',', ';'])
        .trim_start()
        .starts_with(['\'', '"'])
        && op == ": "
    {
        format!("\"{name}\"")
    } else {
        name.into()
    };
    Some(format!("{name}{op}{value}"))
}

pub(super) fn field(key: &str, value: &str, kind: &str) -> Option<String> {
    let name = identifier(key)?;
    if name != key {
        return None;
    }
    let value = if kind == "PASSWORD" {
        MASK.into()
    } else {
        masked(value)
    };
    Some(format!("\"{name}\": \"{value}\""))
}
