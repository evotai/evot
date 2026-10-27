//! Observation only: candidate stricter decisions never alter a verdict,
//! arguments or audit records. Counters contain no values, paths or hosts.
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Process-memory observations for one masker. Not settings or persisted data.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ShadowSummary {
    /// Sensitive shell calls the current sender classifier permits locally.
    pub sensitive_shell_unclassified: u64,
    /// Sensitive calls permitted using hosts inferred from unstructured text.
    pub text_derived_destination: u64,
}

#[derive(Default)]
pub(super) struct ShadowCounters {
    sensitive_shell_unclassified: AtomicU64,
    text_derived_destination: AtomicU64,
}

impl ShadowCounters {
    pub fn shell_unclassified(&self) {
        self.sensitive_shell_unclassified
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn text_destination(&self) {
        self.text_derived_destination
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn summary(&self) -> ShadowSummary {
        ShadowSummary {
            sensitive_shell_unclassified: self.sensitive_shell_unclassified.load(Ordering::Relaxed),
            text_derived_destination: self.text_derived_destination.load(Ordering::Relaxed),
        }
    }
}
