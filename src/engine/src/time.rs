//! Wall-clock helpers shared by every layer.

/// Milliseconds since UNIX epoch, or 0 if the system clock is unavailable.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
