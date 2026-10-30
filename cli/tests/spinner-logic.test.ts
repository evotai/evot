import { describe, test, expect } from 'bun:test'
import {
  createSpinnerState,
  advanceSpinner,
  setSpinnerPhase,
  setLongWait,
  setRetryWait,
  recordStreamDelta,
  isSlow,
  formatSpinnerLine,
  spinnerStatsFromLastUsage,
} from '../src/term/spinner.js'
import { resolveRunInteraction } from '../src/term/app/run-interaction.js'
import stripAnsi from 'strip-ansi'

describe('createSpinnerState', () => {
  test('creates initial state', () => {
    const state = createSpinnerState()
    expect(state.frame).toBe(0)
    expect(state.phase).toBe('preparing')
    expect(state.streaming).toBe(false)
    expect(state.toolName).toBeNull()
    expect(state.waitRetryAt).toBeNull()
    expect(state.tokenCount).toBe(0)
  })
})

describe('advanceSpinner', () => {
  test('increments frame', () => {
    const state = createSpinnerState()
    const next = advanceSpinner(state)
    expect(next.frame).toBe(1)
  })

  test('wraps around at end of frames', () => {
    let state = createSpinnerState()
    // Advance through all frames (12 total: 6 + 6 reversed)
    for (let i = 0; i < 12; i++) {
      state = advanceSpinner(state)
    }
    expect(state.frame).toBe(0)
  })

  test('does not mutate other fields', () => {
    const state = { ...createSpinnerState(), tokenCount: 42 }
    const next = advanceSpinner(state)
    expect(next.tokenCount).toBe(42)
    expect(next.phase).toBe('preparing')
  })
})

describe('setSpinnerPhase', () => {
  test('changes phase to executing', () => {
    const state = createSpinnerState()
    const next = setSpinnerPhase(state, 'executing', 'bash')
    expect(next.phase).toBe('executing')
    expect(next.toolName).toBe('bash')
  })

  test('changes phase to thinking', () => {
    let state = createSpinnerState()
    state = setSpinnerPhase(state, 'executing', 'bash')
    const next = setSpinnerPhase(state, 'thinking')
    expect(next.phase).toBe('thinking')
    expect(next.toolName).toBeNull()
  })
  test('resets phaseStartedAt on change', () => {
    const state = { ...createSpinnerState(), phaseStartedAt: 1000 }
    const next = setSpinnerPhase(state, 'executing', 'read')
    expect(next.phaseStartedAt).toBeGreaterThan(1000)
  })

  test('returns same state if phase unchanged', () => {
    const state = createSpinnerState()
    const next = setSpinnerPhase(state, 'preparing')
    expect(next).toBe(state) // same reference
  })
})

describe('isSlow', () => {
  test('not slow when just started', () => {
    const state = createSpinnerState()
    expect(isSlow(state, Date.now())).toBe(false)
  })

  test('slow after threshold with no tokens', () => {
    const state = { ...createSpinnerState(), phaseStartedAt: Date.now() - 9000 }
    expect(isSlow(state, Date.now())).toBe(true)
  })

  test('not slow when streaming', () => {
    const state = {
      ...createSpinnerState(),
      phaseStartedAt: Date.now() - 9000,
      streaming: true,
    }
    expect(isSlow(state, Date.now())).toBe(false)
  })

  test('not slow when recent tokens received while emitting', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phase: 'thinking' as const,
      phaseStartedAt: now - 9000,
      lastTokenAt: now - 1000, // 1s ago — recent
    }
    expect(isSlow(state, now)).toBe(false)
  })

  test('slow when the stream stalls (stale tokens)', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phase: 'responding' as const,
      phaseStartedAt: now - 9000,
      lastTokenAt: now - 9000, // 9s ago — stalled
      streaming: true,
    }
    expect(isSlow(state, now)).toBe(true)
  })

  test('slow in executing phase after threshold', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phase: 'executing' as const,
      phaseStartedAt: now - 9000,
      toolName: 'edit',
    }
    expect(isSlow(state, now)).toBe(true)
  })

  test('long-running tools use wider slow thresholds', () => {
    const now = Date.now()
    const executing = (toolName: string, elapsedMs: number) => ({
      ...createSpinnerState(),
      phase: 'executing' as const,
      phaseStartedAt: now - elapsedMs,
      toolName,
    })
    // bash regularly outlives 8s (builds, tests) — slow only after 30s.
    expect(isSlow(executing('bash', 9_000), now)).toBe(false)
    expect(isSlow(executing('bash', 31_000), now)).toBe(true)
    // compact includes an LLM summarization pass with a 30s budget.
    expect(isSlow(executing('compact', 29_000), now)).toBe(false)
    expect(isSlow(executing('compact', 31_000), now)).toBe(true)
    // Waiting on the user is never "slow".
    expect(isSlow(executing('ask_user', 3_600_000), now)).toBe(false)
  })
})

describe('formatSpinnerLine', () => {
  test('labels each run phase', () => {
    const now = Date.now()
    const at = (phase: 'preparing' | 'waiting' | 'thinking' | 'responding') => ({
      ...createSpinnerState(),
      phase,
    })
    expect(stripAnsi(formatSpinnerLine(at('preparing'), now))).toContain('Preparing…')
    expect(stripAnsi(formatSpinnerLine(at('waiting'), now))).toContain('Waiting for model…')
    expect(stripAnsi(formatSpinnerLine(at('thinking'), now))).toContain('Thinking…')
    expect(stripAnsi(formatSpinnerLine(at('responding'), now))).toContain('Responding…')
  })

  test('formats quota waiting as a calm model-specific countdown instead of a slow request', () => {
    const now = Date.now()
    const state = setLongWait(createSpinnerState(), 'quota_waiting', 1_800_000, now)
    expect(state.phase).toBe('quota_waiting')
    expect(isSlow(state, now + 30_000)).toBe(false)
    const line = stripAnsi(formatSpinnerLine(state, now + 18_100, {
      inputTokens: 100,
      cacheReadTokens: 90,
    }, { model: 'claude-fable-5' }))
    expect(line).toContain('Quota unavailable · retrying in 29m42s')
    expect(line).not.toContain('cache')
    expect(line).toContain('esc twice to interrupt')
    expect(line).not.toContain('slow')
    const expired = stripAnsi(formatSpinnerLine(state, now + 1_800_000, undefined, { model: 'claude-fable-5' }))
    expect(expired).toContain('Quota unavailable · retrying…')
    expect(expired).not.toContain('retrying in 0s')
  })

  test('formats outage waiting as a calm countdown instead of a slow request', () => {
    const now = Date.now()
    const state = setLongWait(createSpinnerState(), 'outage_waiting', 60_000, now)
    expect(state.phase).toBe('outage_waiting')
    expect(isSlow(state, now + 30_000)).toBe(false)
    const line = stripAnsi(formatSpinnerLine(state, now + 18_100, {
      inputTokens: 100,
      cacheReadTokens: 90,
    }))
    expect(line).toContain('Request failed · retrying in 42s')
    expect(line).not.toContain('cache')
    expect(line).toContain('esc twice to interrupt')
    expect(line).not.toContain('slow')
  })

  test('a retry storm repaints one line: countdown down, attempt up', () => {
    // What replaced a pair of committed cards per attempt. Both moving parts
    // live here, so a ten-attempt storm costs one row instead of twenty.
    const now = Date.now()
    const state = setRetryWait(createSpinnerState(), 9_000, 3, 10, now)
    expect(state.phase).toBe('retrying')

    const line = stripAnsi(formatSpinnerLine(state, now + 2_000))
    expect(line).toContain('Retrying in 7s · attempt 3/10')

    // Elapsed time in a retry storm says nothing about health, so it must not
    // be painted red as a stalled request.
    expect(isSlow(state, now + 30_000)).toBe(false)

    // Advancing to the next attempt updates the same line, not a new one.
    const next = setRetryWait(state, 18_000, 4, 10, now)
    expect(stripAnsi(formatSpinnerLine(next, now))).toContain('attempt 4/10')
  })

  test('a retry line with the delay elapsed reads as retrying now', () => {
    const now = Date.now()
    const state = setRetryWait(createSpinnerState(), 2_000, 1, 10, now)
    const line = stripAnsi(formatSpinnerLine(state, now + 5_000))
    expect(line).toContain('Retrying…')
    expect(line).toContain('attempt 1/10')
  })

  test('leaving a retry storm clears the counter', () => {
    // Otherwise a later storm inherits a stale `attempt 4/10` from this one.
    const state = setRetryWait(createSpinnerState(), 2_000, 4, 10)
    const resumed = setSpinnerPhase(state, 'waiting')
    expect(resumed.retryAttempt).toBeNull()
    expect(resumed.retryMaxAttempts).toBeNull()
    expect(resumed.waitRetryAt).toBeNull()
  })

  test('contains action label when executing', () => {
    const state = setSpinnerPhase(createSpinnerState(), 'executing', 'bash')
    const line = stripAnsi(formatSpinnerLine(state, Date.now()))
    expect(line).toContain('Running command…')
  })

  test('maps tool names to action verbs', () => {
    const cases: [string, string][] = [
      ['read', 'Reading…'],
      ['grep', 'Searching…'],
      ['edit', 'Applying changes…'],
      ['write', 'Writing file…'],
      ['web_fetch', 'Fetching…'],
      ['skill', 'Loading skill…'],
      ['ask_user', 'Waiting for you…'],
      ['some_unknown_tool', 'Working…'],
    ]
    for (const [tool, label] of cases) {
      const state = setSpinnerPhase(createSpinnerState(), 'executing', tool)
      const line = stripAnsi(formatSpinnerLine(state, Date.now()))
      expect(line).toContain(label)
    }
  })

  test('maps log shot stages and can omit the interrupt hint', () => {
    const cases: [string, string][] = [
      ['log_shot_render', 'Rendering shot…'],
      ['log_shot_chrome', 'Starting Chrome…'],
      ['log_shot_capture', 'Capturing PNG…'],
    ]
    for (const [tool, label] of cases) {
      const state = setSpinnerPhase(createSpinnerState(), 'executing', tool)
      const line = stripAnsi(formatSpinnerLine(state, Date.now(), undefined, { interaction: resolveRunInteraction({ active: true, owner: null, localOperation: true }) }))
      expect(line).toContain(label)
      expect(line).not.toContain('esc to interrupt')
    }
  })

  test('contains slow label after threshold', () => {
    const now = Date.now()
    const waiting = { ...createSpinnerState(), phase: 'waiting' as const, phaseStartedAt: now - 9000 }
    expect(stripAnsi(formatSpinnerLine(waiting, now))).toContain('LLM slow…')
    const preparing = { ...createSpinnerState(), phaseStartedAt: now - 9000 }
    expect(stripAnsi(formatSpinnerLine(preparing, now))).toContain('Preparing slow…')
  })

  test('labels a stalled stream', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phase: 'responding' as const,
      streaming: true,
      lastTokenAt: now - 9000,
      phaseStartedAt: now - 20000,
    }
    expect(stripAnsi(formatSpinnerLine(state, now))).toContain('Stream stalled…')
  })

  test('contains action slow label', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phase: 'executing' as const,
      phaseStartedAt: now - 31000,
      toolName: 'bash',
    }
    const line = stripAnsi(formatSpinnerLine(state, now))
    expect(line).toContain('Running command slow…')
  })

  test('does not insert duration padding after the opening parenthesis', () => {
    const now = Date.now()
    const subsecond = { ...createSpinnerState(), phaseStartedAt: now - 99 }
    const seconds = { ...createSpinnerState(), phaseStartedAt: now - 3800 }

    expect(stripAnsi(formatSpinnerLine(subsecond, now))).toContain('(99ms)')
    expect(stripAnsi(formatSpinnerLine(seconds, now))).toContain('(3.8s)')
  })

  test('contains duration', () => {
    const now = Date.now()
    const state = { ...createSpinnerState(), phaseStartedAt: now - 2500 }
    const line = stripAnsi(formatSpinnerLine(state, now))
    expect(line).toContain('2.5s')
  })

  test('contains esc twice to interrupt hint without agent wording', () => {
    const state = createSpinnerState()
    const line = stripAnsi(formatSpinnerLine(state, Date.now()))
    expect(line).toContain('esc twice to interrupt')
    expect(line).not.toContain('interrupt agent')
  })

  test('an armed interrupt asks for the confirming esc in place', () => {
    const state = createSpinnerState()
    const line = stripAnsi(formatSpinnerLine(state, Date.now(), undefined, { interaction: { ...resolveRunInteraction({ active: true, owner: state, foregroundTasks: 1 }), interruptPending: true } }))
    expect(line).toContain('esc again to interrupt')
    expect(line).not.toContain('interrupt agent')
    expect(line).not.toContain('to background')
    expect(line).not.toContain('esc to interrupt')
  })

  test('names ctrl+b while work can be detached', () => {
    // The hint used to advertise a timer instead of the key. With nothing
    // yielding on a timer, ctrl+b is the only non-destructive way out of a
    // wait, so it has to be the thing the line names.
    const state = createSpinnerState()
    const line = stripAnsi(formatSpinnerLine(state, Date.now(), undefined, { interaction: resolveRunInteraction({ active: true, owner: state, foregroundTasks: 1 }) }))
    expect(line).not.toContain('esc twice to interrupt')
    expect(line).toContain('ctrl+b to background')
    expect(line).not.toContain('auto-background')
  })

  test('inside tmux the hint spells the chord the way tmux forwards it', () => {
    // Ctrl+B is tmux's own prefix, so a single press never reaches us there.
    // Advertising the plain spelling would send a tmux user pressing a key that
    // does nothing and concluding backgrounding is broken.
    const previous = process.env.TMUX
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    try {
      const state = createSpinnerState()
      const line = stripAnsi(formatSpinnerLine(state, Date.now(), undefined, { interaction: resolveRunInteraction({ active: true, owner: state, foregroundTasks: 1 }) }))
      expect(line).toContain('ctrl+b ctrl+b (twice) to background')
    } finally {
      if (previous === undefined) delete process.env.TMUX
      else process.env.TMUX = previous
    }
  })

  test('a suppressed hint stays suppressed even when backgroundable', () => {
    const state = createSpinnerState()
    const line = stripAnsi(
      formatSpinnerLine(state, Date.now(), undefined, { interaction: resolveRunInteraction({ active: true, owner: state, localOperation: true, foregroundTasks: 1 }) }),
    )
    expect(line).not.toContain('esc to')
  })

  test('shows token count after 30s', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phaseStartedAt: now - 35000,
      tokenCount: 1500,
      streaming: true, // prevent slow
    }
    const line = stripAnsi(formatSpinnerLine(state, now))
    expect(line).toContain('1.5k tokens')
  })

  test('shows token count with arrow even before 30s', () => {
    const now = Date.now()
    const state = {
      ...createSpinnerState(),
      phaseStartedAt: now - 5000,
      tokenCount: 100,
    }
    const line = stripAnsi(formatSpinnerLine(state, now))
    expect(line).toContain('↓ 100 tokens')
  })

  test('shows last-call token stats with absolute cache amount when provided', () => {
    const now = Date.now()
    const state = { ...createSpinnerState(), phaseStartedAt: now - 5000 }
    const line = stripAnsi(formatSpinnerLine(state, now, {
      inputTokens: 408000,
      outputTokens: 1100,
      cacheReadTokens: 89000,
    }))
    // cache% = 89k / (408k + 89k) ≈ 18%; absolute read is shown so a high
    // percentage can be sanity-checked against the real volume (pi: CH% from
    // latest call + R absolute separately).
    expect(line).toContain('↑408k ↓1.1k cache 89k 18%')
    expect(line).not.toContain('tokens')
  })

  test('cache hit percent includes cache-write tokens in the denominator', () => {
    const now = Date.now()
    const state = { ...createSpinnerState(), phaseStartedAt: now - 5000 }
    // 80 read / (10 + 80 + 10) = 80%; the write bucket surfaces as `+`.
    const line = stripAnsi(formatSpinnerLine(state, now, {
      inputTokens: 10_000,
      outputTokens: 100,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 10_000,
    }))
    expect(line).toContain('cache 80k 80% +10k')
  })

  test('near-full hit shows one decimal instead of rounding to 100%', () => {
    const now = Date.now()
    const state = { ...createSpinnerState(), phaseStartedAt: now - 5000 }
    // 200000 / 200504 = 99.75% — Math.round would show a fake "100%".
    const line = stripAnsi(formatSpinnerLine(state, now, {
      inputTokens: 4,
      outputTokens: 900,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 500,
    }))
    expect(line).toContain('cache 200k 99.7% +500')
    expect(line).not.toContain('100%')
  })

  test('shows 100% only when every billed prompt token was a cache read', () => {
    const now = Date.now()
    const state = { ...createSpinnerState(), phaseStartedAt: now - 5000 }
    const line = stripAnsi(formatSpinnerLine(state, now, {
      inputTokens: 0,
      outputTokens: 40,
      cacheReadTokens: 150_000,
      cacheWriteTokens: 0,
    }))
    expect(line).toContain('cache 150k 100%')
  })

  test('spinnerStatsFromLastUsage hides prior usage until the active call completes', () => {
    const last = {
      inputTokens: 12_000,
      outputTokens: 800,
      cacheReadTokens: 450_000,
      cacheWriteTokens: 0,
    }
    expect(spinnerStatsFromLastUsage(last)).toEqual({
      inputTokens: 12_000,
      outputTokens: 800,
      cacheReadTokens: 450_000,
      cacheWriteTokens: 0,
    })
    expect(spinnerStatsFromLastUsage(last, 320, true)).toEqual({
      inputTokens: 0,
      outputTokens: 320,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(spinnerStatsFromLastUsage(last, 0, true)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(spinnerStatsFromLastUsage(null, 50, true)).toEqual({
      inputTokens: 0,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  test('shows live tok/s while streaming text', () => {
    const start = 10_000
    let state = setSpinnerPhase(createSpinnerState(), 'responding')
    state = recordStreamDelta(state, 'x'.repeat(400), start)
    const line = stripAnsi(formatSpinnerLine(state, start + 2000))
    expect(line).toContain('↓ 100 tokens')
    expect(line).toContain('~50 tok/s')
  })
})

describe('awaiting_background phase', () => {
  test('names the wait rather than claiming work is happening', () => {
    // "Working" would be a lie: nothing is being computed while the agent is
    // parked on a detached task.
    const state = setSpinnerPhase(createSpinnerState(), 'awaiting_background')
    const line = stripAnsi(formatSpinnerLine(state, Date.now()))
    expect(line).toContain('Background task running · resumes when finished')
  })

  test('offers no keyboard hint, because no key applies', () => {
    // esc does not reach a detached task, and ctrl+b cannot background work that
    // is already backgrounded. Advertising either would be a false promise.
    const state = setSpinnerPhase(createSpinnerState(), 'awaiting_background')
    const line = stripAnsi(formatSpinnerLine(state, Date.now(), undefined, {
      interaction: resolveRunInteraction({ active: false, owner: null, backgroundTasks: 1, foregroundTasks: 1 }),
    }))
    expect(line).not.toContain('esc to interrupt')
    expect(line).not.toContain('to background')
  })

  test('reports no tokens, since a parked agent spends nothing', () => {
    const state = setSpinnerPhase(createSpinnerState(), 'awaiting_background')
    const line = stripAnsi(formatSpinnerLine(state, Date.now(), {
      inputTokens: 1200,
      outputTokens: 340,
    }))
    expect(line).not.toContain('↑')
    expect(line).not.toContain('↓')
  })

  test('a long wait is not treated as a fault', () => {
    // A detached build legitimately runs for minutes; reddening the row would
    // report a problem that does not exist.
    const start = 10_000
    const state = { ...setSpinnerPhase(createSpinnerState(), 'awaiting_background'), phaseStartedAt: start }
    expect(isSlow(state, start + 10 * 60_000)).toBe(false)
  })

  test('still shows elapsed, so the wait reads as ongoing', () => {
    const start = 10_000
    const state = { ...setSpinnerPhase(createSpinnerState(), 'awaiting_background'), phaseStartedAt: start }
    const line = stripAnsi(formatSpinnerLine(state, start + 42_000))
    expect(line).toContain('42.0s')
  })
})
