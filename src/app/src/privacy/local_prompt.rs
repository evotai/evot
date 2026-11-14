//! System prompt sections that describe this computer and never leave it.
//!
//! The producer (`cloud::compute::prompt`) brackets its section with these
//! markers; every upload (shares, cloud sync) removes the bracketed text.
//! Machine names, descriptions and hardware are the user's private setup.

pub const COMPUTE_OPEN: &str = "<compute_machines>";
pub const COMPUTE_CLOSE: &str = "</compute_machines>";

/// Remove every bracketed section from a system prompt.
pub fn redact_prompt(system_prompt: &str) -> String {
    let mut out = String::with_capacity(system_prompt.len());
    let mut rest = system_prompt;
    while let Some(start) = rest.find(COMPUTE_OPEN) {
        let Some(len) = rest[start..].find(COMPUTE_CLOSE) else {
            // An unterminated section still never leaves.
            out.push_str(rest[..start].trim_end());
            return out;
        };
        out.push_str(rest[..start].trim_end_matches('\n'));
        rest = rest[start + len + COMPUTE_CLOSE.len()..].trim_start_matches('\n');
        if !rest.is_empty() && !out.is_empty() {
            out.push_str("\n\n");
        }
    }
    out.push_str(rest);
    out
}

/// Strip the sections from one recorded `llm_call_started` stats payload.
/// Returns whether anything changed.
pub fn redact_llm_call(data: &mut serde_json::Value) -> bool {
    match data.get_mut("system_prompt") {
        Some(serde_json::Value::String(text)) if text.contains(COMPUTE_OPEN) => {
            *text = redact_prompt(text);
            true
        }
        _ => false,
    }
}
