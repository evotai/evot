//! What the user is told when privacy stops something. The wording is a
//! contract: the CLI reads it back out of provider and upload errors to
//! show the privacy card (`cli/src/render/privacy-card.ts`), so change it
//! only together with that parser and both sides' tests.
use super::egress::TaintedFile;
use super::record::Target;

/// What a refused tool call's notice has to work with besides the reason.
pub struct EgressNotice<'a> {
    /// The one remote host it named, when safe to show.
    pub host: Option<&'a str>,
    /// The program that makes it send (`node`, `curl`, `git push`).
    pub sender: Option<&'a str>,
    /// Files it reads that an earlier call in this process marked.
    pub tainted: &'a [TaintedFile],
}

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

/// A tool call refused for what it would send. One text for both readers:
/// the model gets it as the tool's result, the CLI parses it into a card
/// (`cli/src/privacy/notice.ts`). Line by line:
///
/// - the headline: what it did, and that it did not run;
/// - `Why:` how the check reached that, in the user's terms (which program
///   sends, which file was marked by what, that a decoded script cannot be
///   read);
/// - `/privacy ...` lines: each thing the user can run to lift it, one per
///   line, only ones that apply here. Saying yes in chat does nothing;
///   the model is told so, so it asks for the command instead of retrying;
/// - the standing rule: do not send it another way.
pub fn egress_blocked_message(reason: &str, notice: &EgressNotice<'_>) -> String {
    let mut lines = vec![format!(
        "privacy blocked this tool call: it {reason}. It did not run."
    )];
    if reason.starts_with("runs decoded code") {
        lines.push(
            "Why: the code is decoded as it runs, so nothing can check what it sends before it does."
                .to_string(),
        );
        lines.push(
            "Rewrite it as plain, readable code; trusting a host or tool does not allow hidden code."
                .to_string(),
        );
        lines.push("Do not send it another way.".to_string());
        return lines.join("\n");
    }
    let mut why = Vec::new();
    if let Some(sender) = notice.sender {
        why.push(format!("`{sender}` can send data off this machine"));
    }
    for file in notice.tainted {
        let rule = file
            .origin
            .rule
            .as_deref()
            .map(|rule| format!(" (rule {rule})"))
            .unwrap_or_default();
        why.push(format!(
            "{} was marked as holding a {} when `{}` wrote it earlier in this session{rule}",
            file.path, file.origin.kind, file.origin.tool
        ));
    }
    if notice.sender.is_none() && notice.tainted.is_empty() {
        why.push("the call carries a secret and sends off this machine".to_string());
    }
    lines.push(format!("Why: {}.", why.join("; ")));
    let mut options = Vec::new();
    for file in notice.tainted {
        options.push(format!(
            "/privacy untaint {} \u{2014} if what `{}` wrote there is a fixture or example, not a real secret",
            file.path, file.origin.tool
        ));
    }
    if let Some(host) = notice.host {
        options.push(format!(
            "/privacy trust {host} \u{2014} to let tool calls send secrets to that host"
        ));
    }
    if options.is_empty() {
        lines.push(
            "The command names no host to trust and reads no file that can be unmarked; the way out is to rewrite the call so it does not carry the secret."
                .to_string(),
        );
    } else {
        lines.push(
            "Only the user can lift this, by running one of these (agreeing in chat does not):"
                .to_string(),
        );
        for option in options {
            lines.push(format!("  {option}"));
        }
    }
    lines.push(
        "Tell the user which applies and wait for them to run it; do not retry as is or send it another way."
            .to_string(),
    );
    lines.join("\n")
}
