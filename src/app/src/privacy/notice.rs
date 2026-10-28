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
        "privacy masking is unavailable, so nothing was sent: {error}. Fix the settings or rule packs with /privacy (/privacy off disables request masking only after settings and packs load; uploads stay protected)"
    )
}
