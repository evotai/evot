use crate::base::error::EvotError;
use crate::base::error::Result;

/// Shared validation for every backend and entry point. Count Unicode scalars,
/// not UTF-8 bytes, so a Chinese name has the same budget as an English name.
pub(crate) fn validate(title: &str) -> Result<String> {
    if title
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err(EvotError::Session(
            "session name must be a single line without control characters".into(),
        ));
    }
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(EvotError::Session(
            "session name must contain 1–120 characters".into(),
        ));
    }
    Ok(title.to_string())
}
