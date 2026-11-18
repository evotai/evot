//! Execution limits — turn/token/duration ceilings and idle-time accounting.

use serde::Deserialize;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Execution limits
// ---------------------------------------------------------------------------

/// Execution limits for the agent loop
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionLimits {
    /// Maximum number of turns (LLM calls)
    pub max_turns: usize,
    /// Maximum total tokens consumed
    pub max_total_tokens: usize,
    /// Maximum wall-clock time
    pub max_duration: std::time::Duration,
}

impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            max_turns: 50,
            max_total_tokens: 1_000_000,
            max_duration: std::time::Duration::from_secs(600),
        }
    }
}

/// Accumulates wall-clock time the agent spent blocked waiting for the user
/// (e.g. the `ask_user` tool sitting idle until a choice is made). This time is
/// excluded from execution-limit duration accounting so a slow human answer
/// never trips `max_duration` — the limit should bound the agent's own work,
/// not how long a person took to respond.
///
/// Cheap to clone: all clones share one atomic counter.
#[derive(Clone, Default)]
pub struct IdleClock {
    accumulated_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl IdleClock {
    pub fn new() -> Self {
        Self {
            accumulated_ms: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// Total idle time accumulated so far.
    pub fn accumulated(&self) -> std::time::Duration {
        std::time::Duration::from_millis(
            self.accumulated_ms
                .load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    /// Begin an idle interval. The returned guard records the elapsed time into
    /// the clock when dropped, so the interval is counted on normal completion,
    /// cancellation, and panic alike.
    pub fn pause(&self) -> IdlePause {
        IdlePause {
            clock: self.accumulated_ms.clone(),
            started: std::time::Instant::now(),
        }
    }
}

/// RAII guard for an idle interval. Adds its lifetime to the [`IdleClock`] on
/// drop. Created via [`IdleClock::pause`].
pub struct IdlePause {
    clock: std::sync::Arc<std::sync::atomic::AtomicU64>,
    started: std::time::Instant,
}

impl Drop for IdlePause {
    fn drop(&mut self) {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        self.clock
            .fetch_add(elapsed_ms, std::sync::atomic::Ordering::Relaxed);
    }
}

/// One execution budget shared by sequential engine segments of a host run.
pub type SharedExecutionTracker = std::sync::Arc<parking_lot::Mutex<ExecutionTracker>>;

/// Tracks execution state against limits
pub struct ExecutionTracker {
    pub limits: ExecutionLimits,
    pub turns: usize,
    pub tokens_used: usize,
    pub started_at: std::time::Instant,
    idle_clock: IdleClock,
}

impl ExecutionTracker {
    pub fn new(limits: ExecutionLimits) -> Self {
        Self::with_idle_clock(limits, IdleClock::new())
    }

    /// Build a tracker that shares `idle_clock` with the tool layer, so time
    /// spent waiting on the user is excluded from the duration limit.
    pub fn with_idle_clock(limits: ExecutionLimits, idle_clock: IdleClock) -> Self {
        Self {
            limits,
            turns: 0,
            tokens_used: 0,
            started_at: std::time::Instant::now(),
            idle_clock,
        }
    }

    /// Handle to the shared idle clock, for handing to the tool layer.
    pub fn idle_clock(&self) -> IdleClock {
        self.idle_clock.clone()
    }

    /// Wall-clock time elapsed minus time spent blocked waiting on the user.
    fn active_elapsed(&self) -> std::time::Duration {
        self.started_at
            .elapsed()
            .saturating_sub(self.idle_clock.accumulated())
    }

    pub fn record_turn(&mut self, tokens: usize) {
        self.turns += 1;
        self.tokens_used += tokens;
    }

    /// Check if any limit has been exceeded. Returns the reason if so.
    pub fn check_limits(&self) -> Option<String> {
        if self.turns >= self.limits.max_turns {
            return Some(format!(
                "Max turns reached ({}/{})",
                self.turns, self.limits.max_turns
            ));
        }
        if self.tokens_used >= self.limits.max_total_tokens {
            return Some(format!(
                "Max tokens reached ({}/{})",
                self.tokens_used, self.limits.max_total_tokens
            ));
        }
        let elapsed = self.active_elapsed();
        if elapsed >= self.limits.max_duration {
            return Some(format!(
                "Max duration reached ({:.0}s/{:.0}s)",
                elapsed.as_secs_f64(),
                self.limits.max_duration.as_secs_f64()
            ));
        }
        None
    }
}
