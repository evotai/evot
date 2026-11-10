//! Field rules for compute machines. Tool arguments from the model and typed
//! user input both arrive here, and `ssh_target` ends up as an `ssh` argument,
//! so every field is checked before it is stored or used.

use crate::base::error::EvotError;
use crate::base::error::Result;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_DESCRIPTION_CHARS: usize = 300;
pub const MAX_TARGET_LEN: usize = 255;

fn invalid(message: impl Into<String>) -> EvotError {
    EvotError::Conf(message.into())
}

/// `name`: short, lowercase-friendly identifier shown in lists and context.
pub fn name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid("machine name is required"));
    }
    if value.len() > MAX_NAME_LEN {
        return Err(invalid(format!(
            "machine name must be at most {MAX_NAME_LEN} characters"
        )));
    }
    let valid = value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    if !valid || value.starts_with(['-', '.']) {
        return Err(invalid(
            "machine name may use letters, digits, '-', '_' and '.', and must start with a letter or digit",
        ));
    }
    Ok(value.to_string())
}

/// `ssh_target`: an ssh config alias, `host`, `user@host`, or `user@[v6]`.
///
/// Passed to `ssh` as its own argument, after `--`, never through a shell.
/// A leading `-` is still refused so the value can never read as an option.
pub fn ssh_target(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid("ssh target is required"));
    }
    if value.len() > MAX_TARGET_LEN {
        return Err(invalid("ssh target is too long"));
    }
    if value.starts_with('-') {
        return Err(invalid("ssh target must not start with '-'"));
    }
    let valid = value.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(b, b'@' | b'.' | b'_' | b'-' | b':' | b'[' | b']' | b'%')
    });
    if !valid {
        return Err(invalid(
            "ssh target may contain only letters, digits and @ . _ - : [ ] %",
        ));
    }
    if value.matches('@').count() > 1 || value.ends_with('@') || value.starts_with('@') {
        return Err(invalid(
            "ssh target must look like host, user@host or an ssh alias",
        ));
    }
    Ok(value.to_string())
}

pub fn description(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid("describe what this machine should be used for"));
    }
    if value.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(invalid(format!(
            "use-for description must be at most {MAX_DESCRIPTION_CHARS} characters"
        )));
    }
    if value
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(invalid(
            "use-for description must not contain control characters",
        ));
    }
    Ok(value.to_string())
}
