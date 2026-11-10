//! The per-turn system prompt section that lists the user's machines. evot
//! only tells the model what each machine is for; the model reaches them with
//! ordinary `ssh` through bash and decides how to move files itself.

use super::model::ComputeMachine;

/// Wraps the section so a shared or synced session can drop it whole.
pub const PROMPT_OPEN: &str = "<compute_machines>";
pub const PROMPT_CLOSE: &str = "</compute_machines>";

/// The section for the enabled machines, or `None` when there are none.
pub fn prompt_section(machines: &[ComputeMachine]) -> Option<String> {
    let lines: Vec<String> = machines
        .iter()
        .filter(|machine| machine.enabled)
        .map(machine_line)
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "{PROMPT_OPEN}\n\
         The user connected these ssh machines for you to use. Each one is for what its description says; do not use it for anything else.\n\
         {}\n\
         Each name is an ssh alias (unless another one is shown): reach it with `ssh <name>` through bash, and tell the user which machine you are using.\n\
         - Never copy secrets such as .env* files or keys to a machine.\n\
         - Run anything long detached so a dropped connection does not stop it; where the tools list tmux, use a tmux session named evot-<short-name>.\n\
         - To avoid quoting and escaping bugs, send anything beyond a simple command as a script on stdin with a quoted heredoc: ssh <name> bash -s <<'EOF' … EOF. Nothing inside it is expanded locally or needs escaping.\n\
         {PROMPT_CLOSE}",
        lines.join("\n")
    ))
}

/// Remove the compute section from a system prompt before it leaves this
/// computer, e.g. in a shared session. Machine names, descriptions and
/// hardware are the user's private setup.
pub fn redact_prompt(system_prompt: &str) -> String {
    let mut out = String::with_capacity(system_prompt.len());
    let mut rest = system_prompt;
    while let Some(start) = rest.find(PROMPT_OPEN) {
        let Some(len) = rest[start..].find(PROMPT_CLOSE) else {
            // An unterminated section still never leaves.
            out.push_str(rest[..start].trim_end());
            return out;
        };
        out.push_str(rest[..start].trim_end_matches('\n'));
        rest = rest[start + len + PROMPT_CLOSE.len()..].trim_start_matches('\n');
        if !rest.is_empty() && !out.is_empty() {
            out.push_str("\n\n");
        }
    }
    out.push_str(rest);
    out
}

/// Strip the compute section from one recorded `llm_call_started` stats
/// payload. Returns whether anything changed.
pub fn redact_llm_call(data: &mut serde_json::Value) -> bool {
    match data.get_mut("system_prompt") {
        Some(serde_json::Value::String(text)) if text.contains(PROMPT_OPEN) => {
            *text = redact_prompt(text);
            true
        }
        _ => false,
    }
}

fn machine_line(machine: &ComputeMachine) -> String {
    let mut facts: Vec<String> = Vec::new();
    if let Some(profile) = &machine.profile {
        let mut hardware: Vec<String> = Vec::new();
        if !profile.os.is_empty() {
            hardware.push(profile.os.clone());
        }
        if profile.cpus > 0 {
            hardware.push(format!("{} CPUs", profile.cpus));
        }
        if profile.mem_gb > 0 {
            hardware.push(format!("{} GB", profile.mem_gb));
        }
        if !hardware.is_empty() {
            facts.push(hardware.join(" · "));
        }
        if !profile.tools.is_empty() {
            facts.push(format!("tools: {}", profile.tools.join(", ")));
        }
    }
    if let Some(check) = &machine.last_check {
        if check.status != super::model::CheckStatus::Ok {
            let reason = if check.message.is_empty() {
                "failed".to_string()
            } else {
                check.message.clone()
            };
            facts.push(format!("last check: {reason}"));
        }
    }
    let description = machine
        .description
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // The target is the machine's ssh alias, normally its name.
    let head = if machine.ssh_target == machine.name {
        format!("- {}", machine.name)
    } else {
        format!("- {} (ssh {})", machine.name, machine.ssh_target)
    };
    if facts.is_empty() {
        format!("{head}: {description}")
    } else {
        format!("{head}: {description} ({})", facts.join("; "))
    }
}
