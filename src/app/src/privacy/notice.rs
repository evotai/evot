//! What the user is told when privacy stops something. The wording is a
//! contract: the CLI reads it back out of provider and upload errors to
//! show the privacy card (`cli/src/render/privacy-card.ts`), so change it
//! only together with that parser and both sides' tests.
use super::record::Target;

fn noun(target: Target) -> &'static str {
    match target {
        Target::Llm => "request",
        Target::Share => "share",
        Target::Sync => "sync",
        Target::Task => "task",
        Target::TaskReport => "task report",
        Target::Delivery => "delivery",
        Target::Egress => "tool call",
    }
}

/// `kinds` were set to block, so nothing went to `target`.
pub fn blocked_message(target: Target, kinds: &[String]) -> String {
    format!(
        "privacy blocked this {}: it contains {}. Nothing was sent; run /privacy to review the rule.",
        noun(target),
        kinds.join(", ")
    )
}

/// Masking could not run, so nothing went out.
pub fn unavailable_message(error: impl std::fmt::Display) -> String {
    format!(
        "privacy masking is unavailable, so nothing was sent: {error}. Fix the settings or rule packs with /privacy (/privacy off disables request masking only after settings and packs load; uploads and tool checks stay protected)"
    )
}

/// A tool call refused for what it would send: what it did, that it did not
/// run, and what to do. `host` is the one host it named, when safe to show.
/// The CLI parses the first sentence (`cli/src/privacy/notice.ts`).
pub fn egress_blocked_message(reason: &str, host: Option<&str>) -> String {
    let hint = if reason.starts_with("runs decoded code") {
        "Rewrite it as plain, readable code; trusting a host or tool does not allow hidden code"
            .to_string()
    } else {
        match host {
            Some(host) => {
                format!("Tell the user, who can trust that host: /privacy trust {host}")
            }
            None => "Tell the user, who can trust a host with /privacy trust HOST".to_string(),
        }
    };
    format!(
        "privacy blocked this tool call: it {reason}. It did not run. {hint}. Do not send it another way."
    )
}
