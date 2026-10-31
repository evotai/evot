import { describe, expect, test } from 'bun:test'
import { parseLoopArgs, parseDuration, formatDuration, userTask } from '../src/loop/parser.js'
import { BUILTIN_LOOP_PROMPT, BUILTIN_LOOP_TASK } from '../src/loop/builtin-task.js'
import { formatLoopWaitLine } from '../src/loop/wait-line.js'
import { getTheme } from '../src/render/theme/index.js'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import {
  LoopController,
  clampDelaySeconds,
  KEEPALIVE_SECONDS,
  MAX_AGE_MS,
  MAX_CONSECUTIVE_ERRORS,
  type StopCause,
} from '../src/loop/controller.js'
import { createLoopExtension, SCHEDULE_WAKEUP_SPEC } from '../src/loop/host-tool.js'
import { buildLoopStartPrompt, buildLoopWakeupPrompt } from '../src/loop/prompt.js'
import type { HostToolExtension } from '../src/term/host-tools.js'
import { LoopSession } from '../src/loop/session.js'
import { earlyWakeFromResult, earlyWakeSentence } from '../src/loop/early-wake.js'
import { buildToolCard } from '../src/render/output.js'
import { composeExtensions, type HostToolCall, type HostToolExtension } from '../src/term/host-tools.js'

function controller() {
  const stops: StopCause[] = []
  const c = new LoopController({ stopped: cause => stops.push(cause) })
  return { c, stops }
}

function call(args: Record<string, unknown>, name = 'schedule_wakeup'): HostToolCall {
  return { tool_name: name, tool_call_id: 'c1', arguments: args }
}

describe('parseLoopArgs', () => {
  test('control words', () => {
    expect(parseLoopArgs('stop')).toEqual({ kind: 'stop' })
    expect(parseLoopArgs(' STATUS ')).toEqual({ kind: 'status' })
  })

  test('leading interval', () => {
    expect(parseLoopArgs('5m check CI')).toEqual({ kind: 'start', mode: { kind: 'fixed', intervalMs: 300_000 }, task: { prompt: 'check CI', label: 'check CI' } })
  })

  test('trailing interval', () => {
    expect(parseLoopArgs('check CI every 20m')).toEqual({ kind: 'start', mode: { kind: 'fixed', intervalMs: 1_200_000 }, task: { prompt: 'check CI', label: 'check CI' } })
  })

  test('no interval is dynamic', () => {
    expect(parseLoopArgs('watch PR 123')).toEqual({ kind: 'start', mode: { kind: 'dynamic' }, task: { prompt: 'watch PR 123', label: 'watch PR 123' } })
  })

  test('rejects empty prompt and out-of-range interval', () => {
    expect(parseLoopArgs('10s x').kind).toBe('invalid')
    expect(parseLoopArgs('2h x').kind).toBe('invalid')
  })

  test('bare /loop continues the conversation, self-paced or on the given interval', () => {
    expect(parseLoopArgs('')).toEqual({ kind: 'start', mode: { kind: 'dynamic' }, task: BUILTIN_LOOP_TASK })
    expect(parseLoopArgs('15m')).toEqual({ kind: 'start', mode: { kind: 'fixed', intervalMs: 900_000 }, task: BUILTIN_LOOP_TASK })
    expect(BUILTIN_LOOP_TASK.label).toBe('continue this work')
    expect(BUILTIN_LOOP_PROMPT).toContain('read the')
    expect(BUILTIN_LOOP_PROMPT).toContain('If the conversation is driving a pull request')
    expect(BUILTIN_LOOP_PROMPT).toContain('If unsure, wait once more rather than stop')
  })

  test('a long user prompt is labelled by its first 120 characters', () => {
    const long = 'x'.repeat(200)
    const command = parseLoopArgs(long)
    if (command.kind !== 'start') throw new Error(command.kind)
    expect(command.task.prompt).toBe(long)
    expect(command.task.label).toBe(`${'x'.repeat(120)}…`)
    expect(parseLoopArgs('10s x').kind).toBe('invalid')
    expect(parseLoopArgs('2h x').kind).toBe('invalid')
  })

  test('durations', () => {
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('abc')).toBeNull()
    expect(formatDuration(90_000)).toBe('1m30s')
    expect(formatDuration(3_600_000)).toBe('1h')
  })
})

describe('clampDelaySeconds', () => {
  test('bounds and cache window', () => {
    expect(clampDelaySeconds(10)).toBe(60)
    expect(clampDelaySeconds(99_999)).toBe(3600)
    expect(clampDelaySeconds(300)).toBe(270)
    expect(clampDelaySeconds(329)).toBe(270)
    expect(clampDelaySeconds(331)).toBe(331)
    expect(clampDelaySeconds(269)).toBe(269)
  })
})

describe('LoopController', () => {
  test('fixed mode advances nextFireAt at run end', () => {
    const { c } = controller()
    c.start({ kind: 'fixed', intervalMs: 60_000 }, userTask('p'), 1000)
    c.beginRun(1000)
    c.endRun('ok', 5000)
    expect(c.remainingMs(5000)).toBe(60_000)
    expect(c.due(65_000)).toBe(true)
  })

  test('dynamic schedule overrides and counts noop streak', () => {
    const { c } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    c.beginRun(0)
    expect(c.schedule({ delaySeconds: 120, reason: 'a', noop: true }, 0)).toBe(120)
    c.endRun('ok', 1)
    expect(c.snapshot?.noopStreak).toBe(1)
    expect(c.snapshot?.streakStartedAt).toBe(0)
    expect(c.remainingMs(1)).toBe(119_999)
    // A second quiet tick extends the streak but keeps its original start.
    c.beginRun(120_000)
    c.schedule({ delaySeconds: 120, reason: 'a', noop: true }, 120_000)
    expect(c.snapshot?.noopStreak).toBe(2)
    expect(c.snapshot?.streakStartedAt).toBe(0)
    c.beginRun(240_000)
    c.schedule({ delaySeconds: 60, reason: 'b', noop: false }, 240_000)
    expect(c.snapshot?.noopStreak).toBe(0)
    expect(c.snapshot?.streakStartedAt).toBeNull()
  })

  test('a loop lives for a week, matching Claude Code recurring tasks', () => {
    expect(MAX_AGE_MS).toBe(7 * 24 * 3_600_000)
  })

  test('keepalive once, then stop', () => {
    const { c, stops } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    c.beginRun(0)
    c.endRun('ok', 0)
    expect(c.active).toBe(true)
    expect(c.remainingMs(0)).toBe(KEEPALIVE_SECONDS * 1000)
    c.beginRun(1)
    c.endRun('ok', 1)
    expect(c.active).toBe(false)
    expect(stops).toEqual(['no_reschedule'])
  })

  test('consecutive errors stop the loop', () => {
    const { c, stops } = controller()
    c.start({ kind: 'fixed', intervalMs: 60_000 }, userTask('p'), 0)
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      c.beginRun(i)
      c.endRun('error', i)
    }
    expect(stops).toEqual(['errors'])
  })

  test('error counter resets on success', () => {
    const { c } = controller()
    c.start({ kind: 'fixed', intervalMs: 60_000 }, userTask('p'), 0)
    c.beginRun(0); c.endRun('error', 0)
    c.beginRun(1); c.endRun('error', 1)
    c.beginRun(2); c.endRun('ok', 2)
    c.beginRun(3); c.endRun('error', 3)
    expect(c.active).toBe(true)
  })

  test('interrupted turns retain the loop without spending the missing-wakeup budget', () => {
    const { c, stops } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    for (let i = 0; i < 4; i++) {
      c.beginRun(i)
      c.endRun('interrupted', i)
      expect(c.remainingMs(i)).toBe(60_000)
      expect(c.snapshot?.reason).toContain('loop will resume')
    }
    expect(c.active).toBe(true)
    expect(stops).toEqual([])
    c.beginRun(10)
    c.endRun('ok', 10)
    expect(c.remainingMs(10)).toBe(KEEPALIVE_SECONDS * 1000)
    c.beginRun(11)
    c.endRun('ok', 11)
    expect(stops).toEqual(['no_reschedule'])
  })

  test('interruptions preserve an existing schedule in both loop modes', () => {
    for (const mode of [{ kind: 'dynamic' }, { kind: 'fixed', intervalMs: 300_000 }] as const) {
      const { c } = controller()
      c.start(mode, userTask('p'), 0)
      c.beginRun(0)
      c.schedule({ delaySeconds: 600, reason: 'waiting for review', noop: true }, 0)
      c.endRun('interrupted', 1000)
      expect(c.remainingMs(1000)).toBe(599_000)
      expect(c.snapshot?.reason).toBe('waiting for review')
      expect(c.snapshot?.noopStreak).toBe(1)
    }
  })

  test('an interrupted fixed turn retries at its configured interval', () => {
    const { c, stops } = controller()
    c.start({ kind: 'fixed', intervalMs: 300_000 }, userTask('p'), 0)
    for (let i = 0; i < 4; i++) {
      c.beginRun(i)
      c.endRun('interrupted', i)
      expect(c.remainingMs(i)).toBe(300_000)
    }
    expect(stops).toEqual([])
  })

  test('interruptions neither count as errors nor clear existing errors', () => {
    const { c, stops } = controller()
    c.start({ kind: 'fixed', intervalMs: 60_000 }, userTask('p'), 0)
    c.beginRun(0); c.endRun('error', 0)
    c.beginRun(1); c.endRun('interrupted', 1)
    c.beginRun(2); c.endRun('error', 2)
    expect(c.active).toBe(true)
    c.beginRun(3); c.endRun('error', 3)
    expect(stops).toEqual(['errors'])
  })

  test('max age stops at run start', () => {
    const { c, stops } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    c.beginRun(MAX_AGE_MS + 1)
    expect(stops).toEqual(['max_age'])
  })

  test('stop is idempotent', () => {
    const { c, stops } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    expect(c.stop('user')).not.toBeNull()
    expect(c.stop('user')).toBeNull()
    expect(stops).toEqual(['user'])
  })
})

describe('schedule_wakeup host tool', () => {
  test('spec aliases ScheduleWakeup', () => {
    expect(SCHEDULE_WAKEUP_SPEC.name_aliases).toEqual([['claude', 'ScheduleWakeup']])
    const { c } = controller()
    const ext = createLoopExtension(c)
    expect(ext.handles('ScheduleWakeup')).toBe(true)
    expect(ext.handles('ask_user')).toBe(false)
  })

  test('requires delay, reason and noop unless stop', async () => {
    const { c } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    const ext = createLoopExtension(c)
    const missingDelay = await ext.dispatch(call({ reason: 'x', noop: true }))
    expect(missingDelay.is_error).toBe(true)
    expect(missingDelay.content[0]?.text).toContain('delay_seconds and reason are required')
    const missingReason = await ext.dispatch(call({ delay_seconds: 600, noop: true }))
    expect(missingReason.is_error).toBe(true)
    // Claude Code makes noop mandatory so quiet ticks can be tracked; a
    // forgotten flag must not be silently read as "did work".
    const missingNoop = await ext.dispatch(call({ delay_seconds: 600, reason: 'waiting on CI' }))
    expect(missingNoop.is_error).toBe(true)
    expect(missingNoop.content[0]?.text).toContain('noop is required')
    expect(c.snapshot?.nextFireAt).toBeNull()
    const ok = await ext.dispatch(call({ delay_seconds: 600, reason: 'waiting on CI', noop: false }))
    expect(ok.is_error).toBe(false)
    expect(ok.content[0]?.text).toContain('10m')
    expect(c.snapshot?.reason).toBe('waiting on CI')
  })

  test('stop ends the loop', async () => {
    const { c, stops } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    const ext = createLoopExtension(c)
    const res = await ext.dispatch(call({ stop: true, reason: 'converged' }))
    expect(res.is_error).toBe(false)
    expect(c.active).toBe(false)
    expect(stops).toEqual(['model'])
  })

  test('errors when no loop is active', async () => {
    const { c } = controller()
    const res = await createLoopExtension(c).dispatch(call({ delay_seconds: 60, reason: 'x', noop: true }))
    expect(res.is_error).toBe(true)
  })

  test('stop needs nothing else and works on a fixed loop too', async () => {
    const { c, stops } = controller()
    c.start({ kind: 'fixed', intervalMs: 300_000 }, userTask('p'), 0)
    const res = await createLoopExtension(c).dispatch(call({ stop: true }))
    expect(res.is_error).toBe(false)
    expect(c.active).toBe(false)
    expect(stops).toEqual(['model'])
  })
})

describe('early wake from a running background shell', () => {
  const shells = [{ taskId: '3ecbfd4f-1234-5678', command: 'sleep 30', elapsedMs: 5000 }]

  test('sentence names one shell, counts several, and is absent without any', () => {
    expect(earlyWakeSentence([])).toBeNull()
    expect(earlyWakeSentence(['3ecbfd4f-1234'])).toBe('wakes earlier when background shell 3ecbfd4f finishes')
    expect(earlyWakeSentence(['3ecbfd4f-1234', 'c0e571db-9999']))
      .toBe('wakes earlier when any of 2 background shells (3ecbfd4f, c0e571db) finishes')
  })

  test('the tool result tells the model the delay is only a fallback', async () => {
    const { c } = controller()
    c.start({ kind: 'dynamic' }, userTask('p'), 0)
    const plain = await createLoopExtension(c).dispatch(call({ delay_seconds: 1800, reason: 'x', noop: true }))
    expect(plain.content[0]?.text).not.toContain('wakes earlier')
    const withShell = await createLoopExtension(c, () => shells).dispatch(call({ delay_seconds: 1800, reason: 'x', noop: true }))
    expect(withShell.content[0]?.text).toMatch(/^Next wakeup in 30m at \d\d:\d\d:\d\d\. The loop wakes earlier when background shell 3ecbfd4f finishes\.$/)
    expect(earlyWakeFromResult(withShell.content[0]?.text ?? '')).toBe('wakes earlier when background shell 3ecbfd4f finishes')
    expect(earlyWakeFromResult(plain.content[0]?.text ?? '')).toBeNull()
  })

  test('the wakeup card repeats it under the reason', () => {
    const base = { id: 't', name: 'ScheduleWakeup', status: 'success', startedAt: 0, durationMs: 1,
      args: { delay_seconds: 1800, reason: 'Waiting for Codex', noop: true } }
    const lines = (result: string) => buildToolCard({ ...base, result } as never).map(line => stripAnsi(line.text))
    expect(lines('Next wakeup in 30m at 19:37:24. The loop wakes earlier when background shell 3ecbfd4f finishes.').slice(1))
      .toEqual(['  Waiting for Codex', '  wakes earlier when background shell 3ecbfd4f finishes'])
    expect(lines('Next wakeup in 30m at 19:37:24.').slice(1)).toEqual(['  Waiting for Codex'])
  })

  test('the footer row and /loop status read live shells, not the scheduling moment', async () => {
    let running: typeof shells = []
    const notices: string[] = []
    const s = new LoopSession({
      runTurn: () => {}, canWake: () => true, notify: text => notices.push(text), requestRender: () => {},
      backgroundTasks: () => running,
    })
    s.handleCommand('/loop a', 'a')
    await s.extension?.dispatch(call({ delay_seconds: 1800, reason: 'x', noop: true }))
    s.endRun('ok')
    expect(s.waitRemaining()?.earlyWake).toBeNull()
    running = shells
    expect(s.waitRemaining()?.earlyWake).toBe('wakes earlier when background shell 3ecbfd4f finishes')
    expect(stripAnsi(formatLoopWaitLine({ remainingMs: 1_790_000, earlyWake: s.waitRemaining()?.earlyWake })))
      .toBe('◌ loop · wakes in 29m50s · or earlier when background shell 3ecbfd4f finishes')
    s.handleCommand('/loop status', 'status')
    expect(notices.at(-1)).toContain('\n  wakes earlier when background shell 3ecbfd4f finishes')
    running = []
    s.handleCommand('/loop status', 'status')
    expect(notices.at(-1)).not.toContain('wakes earlier')
    s.dispose()
  })
})

describe('composeExtensions', () => {
  const a: HostToolExtension = {
    specsJson: JSON.stringify([{ name: 'ask_user' }, { name: 'a' }]),
    handles: n => n === 'a',
    dispatch: async c => ({ tool_call_id: c.tool_call_id, content: [{ type: 'text', text: 'A' }], is_error: false }),
  }
  const b: HostToolExtension = {
    specsJson: JSON.stringify([{ name: 'ask_user' }, { name: 'b' }]),
    handles: n => n === 'b',
    dispatch: async c => ({ tool_call_id: c.tool_call_id, content: [{ type: 'text', text: 'B' }], is_error: false }),
  }

  test('passthrough', () => {
    expect(composeExtensions()).toBeUndefined()
    expect(composeExtensions(undefined, a)).toBe(a)
  })

  test('merges specs without duplicates and routes dispatch', async () => {
    const merged = composeExtensions(a, b)!
    expect((JSON.parse(merged.specsJson) as Array<{ name: string }>).map(s => s.name)).toEqual(['ask_user', 'a', 'b'])
    expect(merged.handles('a')).toBe(true)
    expect(merged.handles('b')).toBe(true)
    expect(merged.handles('c')).toBe(false)
    expect((await merged.dispatch(call({}, 'b'))).content[0]?.text).toBe('B')
    expect((await merged.dispatch(call({}, 'c'))).is_error).toBe(true)
  })
})

describe('prompts', () => {
  test('dynamic start self-paces; fixed start is host-paced but can still stop', () => {
    const dynamic = buildLoopStartPrompt({ kind: 'dynamic' }, 'watch')
    expect(dynamic).toContain('`schedule_wakeup` exactly once')
    expect(dynamic).toContain('third straight tick')
    // Quiet ticks are normal while a watcher runs; they must not end the loop.
    expect(dynamic).toContain('Quiet ticks while a watcher you armed is still running are expected and do not count')
    // Always ~5 minutes, inside the warm cache; the model never lengthens it for long waits.
    expect(dynamic).toContain('Use 270s (about 5 minutes) every time, including long waits')
    expect(dynamic).toContain('Do not lengthen the delay on your own')
    expect(dynamic).not.toMatch(/1200|1800/)
    expect(SCHEDULE_WAKEUP_SPEC.description).toContain('Use 270s (5 minutes')
    expect(SCHEDULE_WAKEUP_SPEC.description).toContain('Do not lengthen it on your own')
    expect(SCHEDULE_WAKEUP_SPEC.description).not.toMatch(/1200|1800/)
    expect(dynamic).toContain('`noop` is required')
    // The 5-minute cache boundary: stay under it or go long, never land on it.
    expect(dynamic).toContain('Do not choose 300s exactly')
    const fixed = buildLoopStartPrompt({ kind: 'fixed', intervalMs: 300_000 }, 'watch')
    expect(fixed).toContain('every 5m')
    expect(fixed).toContain('you do not schedule the next wakeup yourself')
    // Claude Code's cron loops tell the model how to end them (CronDelete);
    // ours must say the same for stop: true or a done task fires for a week.
    expect(fixed).toContain('`stop: true`')
    expect(fixed).not.toContain('`noop` is required')
  })

  test('both modes tell the agent to trust the host\'s watcher list over memory', () => {
    for (const mode of [{ kind: 'dynamic' } as const, { kind: 'fixed', intervalMs: 60_000 } as const]) {
      const text = buildLoopStartPrompt(mode, 'watch')
      expect(text).toContain('Never report a watcher as running unless it appears there')
      expect(text).toContain('handle that event first')
    }
  })

  test('the start prompt states the live background list too', () => {
    // A loop started right after a restart must not inherit the old
    // process's watchers from the transcript; the first turn already says
    // what is really running.
    const idle = buildLoopStartPrompt({ kind: 'dynamic' }, 'watch')
    expect(idle).toContain('No background shell is running. Start now:')
    const busy = buildLoopStartPrompt({ kind: 'fixed', intervalMs: 60_000 }, 'watch', '/loop 1m watch', [
      { taskId: '4d2de14b9999', command: 'gh pr checks --watch', elapsedMs: 67_000 },
    ])
    expect(busy).toContain('Background shell still running: 4d2de14b (1m7s) gh pr checks --watch. Start now:')
    expect(busy).not.toContain('No background shell')
  })

  const snapshot = (over: Partial<Parameters<typeof buildLoopWakeupPrompt>[0]> = {}) => ({
    active: true, mode: { kind: 'dynamic' } as const, task: userTask('x'.repeat(200)), startedAt: 0,
    nextFireAt: null, reason: null, tick: 7, noopStreak: 0, streakStartedAt: null, ...over,
  })

  test('wakeup prompt is short, tick-numbered, and states no watcher is running', () => {
    const text = buildLoopWakeupPrompt(snapshot())
    expect(text).toContain('#7')
    expect(text).toContain('…')
    expect(text).toContain('schedule_wakeup')
    expect(text).toContain('No background shell is running.')
    expect(text).not.toContain('no-op tick')
    // One envelope header plus one instruction line: still a reminder, not a prompt.
    expect(text.split('\n')).toHaveLength(3)
    expect(text.length).toBeLessThan(400)
  })

  test('wakeup prompt lists the running background shells the host knows about', () => {
    const text = buildLoopWakeupPrompt(snapshot(), 0, [
      { taskId: '7a0598731234', command: 'cd /repo &&   gh pr checks 1 --watch\n  && echo done', elapsedMs: 9 * 60_000 },
      { taskId: 'c19e3a65', command: 'sleep 60', elapsedMs: 5_000 },
    ])
    expect(text).toContain('Background shells still running: 7a059873 (9m) cd /repo && gh pr checks 1 --watch && echo done; c19e3a65 (5s) sleep 60.')
    expect(text).not.toContain('No background shell')
  })

  test('wakeup prompt carries the quiet streak and when it began', () => {
    const since = new Date(2026, 9, 17, 19, 7).getTime()
    const text = buildLoopWakeupPrompt(snapshot({ noopStreak: 5, streakStartedAt: since }), since + 25 * 60_000)
    expect(text).toContain('5 no-op ticks since 19:07')
    const one = buildLoopWakeupPrompt(snapshot({ noopStreak: 1, streakStartedAt: since }), since + 60_000)
    expect(one).toContain('1 no-op tick since')
  })

  test('a fixed wakeup still gets the background list but no schedule reminder', () => {
    const text = buildLoopWakeupPrompt(snapshot({ mode: { kind: 'fixed', intervalMs: 300_000 } }))
    expect(text).toContain('No background shell is running.')
    expect(text).not.toContain('End with schedule_wakeup')
  })
})

describe('LoopSession', () => {
  function session(canWake = true) {
    const turns: Array<{ userLine: string | null; prompt: string }> = []
    const notices: string[] = []
    const s = new LoopSession({
      runTurn: (userLine, prompt) => turns.push({ userLine, prompt }),
      canWake: () => canWake,
      notify: text => notices.push(text),
      requestRender: () => {},
    })
    return { s, turns, notices }
  }

  test('start runs first turn with the user line', () => {
    const { s, turns } = session()
    s.handleCommand('/loop watch PR', 'watch PR')
    expect(s.active).toBe(true)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.userLine).toBe('/loop watch PR')
    expect(turns[0]?.prompt).toContain('watch PR')
    s.dispose()
  })

  test('the schedule_wakeup tool is offered while any loop is active', () => {
    const { s } = session()
    expect(s.extension).toBeUndefined()
    s.handleCommand('/loop a', 'a')
    expect(s.extension).toBeDefined()
    s.handleCommand('/loop 5m b', '5m b')
    expect(s.extension).toBeDefined()
    s.handleCommand('/loop stop', 'stop')
    expect(s.extension).toBeUndefined()
    s.dispose()
  })

  test('schedule on a fixed loop changes its interval for good', () => {
    const c = new LoopController({ stopped: () => {} })
    c.start({ kind: 'fixed', intervalMs: 300_000 }, userTask('p'), 0)
    c.beginRun(0)
    c.schedule({ delaySeconds: 3600, reason: 'hourly now', noop: false }, 0)
    expect(c.snapshot?.mode).toEqual({ kind: 'fixed', intervalMs: 3_600_000 })
    c.endRun('ok', 10_000)
    expect(c.snapshot?.nextFireAt).toBe(10_000 + 3_600_000)
  })

  test('stop and status notices', () => {
    const { s, notices } = session()
    s.handleCommand('/loop status', 'status')
    expect(notices.at(-1)).toContain('No loop is running.')
    s.handleCommand('/loop x', 'x')
    s.handleCommand('/loop status', 'status')
    expect(notices.at(-1)).toContain('self-paced')
    s.endRun('ok')
    s.handleCommand('/loop stop', 'stop')
    expect(s.active).toBe(false)
    expect(notices.at(-1)).toContain('loop stopped')
    s.dispose()
  })

  test('waitRemaining is the countdown between ticks and null while running', () => {
    const { s } = session()
    const t0 = Date.now()
    s.handleCommand('/loop 20m x', '20m x')
    expect(s.waitRemaining(t0)).toBeNull()
    s.endRun('ok')
    expect(s.waiting).toBe(true)
    const wait = s.waitRemaining(t0 + 23_000)
    expect(wait?.label).toMatch(/^19m3\ds$/)
    expect(wait?.remainingMs).toBeGreaterThan(19 * 60_000)
    s.dispose()
  })

  test('interrupting a loop turn keeps the wakeup tool and lets user turns leave its timer untouched', () => {
    const { s, notices } = session()
    s.handleCommand('/loop watch PR', 'watch PR')
    const extension = s.extension
    s.endRun('interrupted')
    expect(s.active).toBe(true)
    expect(s.runInFlight).toBe(false)
    expect(s.waiting).toBe(true)
    expect(s.extension).toBe(extension)
    expect(notices).toEqual([])
    const nextFireAt = s.snapshot?.nextFireAt
    // The native run's late finally or a subsequent user turn cannot finish
    // the old tick again or consume its keepalive allowance.
    s.endRun('error')
    s.endRun('ok')
    s.endRun('interrupted')
    expect(s.snapshot?.nextFireAt).toBe(nextFireAt)
    expect(s.active).toBe(true)
    expect(s.cancelWait()).toBe(true)
    expect(notices.at(-1)).toContain('stopped by you')
    s.dispose()
  })

  test('reset closes an abandoned run and reports its stop immediately', () => {
    const { s, notices } = session()
    s.handleCommand('/loop old session', 'old session')
    s.reset()
    expect(s.active).toBe(false)
    expect(s.runInFlight).toBe(false)
    expect(s.waiting).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('session changed')
    s.endRun('ok')
    expect(notices).toHaveLength(1)
    s.handleCommand('/loop new session', 'new session')
    s.endRun('interrupted')
    expect(s.active).toBe(true)
    expect(s.runInFlight).toBe(false)
    expect(notices).toHaveLength(1)
    s.dispose()
  })

  test('an explicit stop during a turn is flushed when that turn is interrupted', () => {
    const { s, notices } = session()
    s.handleCommand('/loop watch PR', 'watch PR')
    s.handleCommand('/loop stop', 'stop')
    expect(notices).toEqual([])
    s.endRun('interrupted')
    expect(s.runInFlight).toBe(false)
    expect(s.active).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('stopped by you')
    s.endRun('ok')
    expect(notices).toHaveLength(1)
    s.dispose()
  })

  test('a run is in flight only between the loop launching a turn and endRun', () => {
    const { s } = session()
    expect(s.runInFlight).toBe(false)
    s.handleCommand('/loop 1m x', '1m x')
    expect(s.runInFlight).toBe(true)
    s.endRun('error')
    expect(s.runInFlight).toBe(false)
    expect(s.active).toBe(true)
    // A user turn while parked is not a loop run: endRun without a loop
    // launch is a no-op, the timer and error streak are untouched.
    const before = s.waitRemaining()
    s.endRun('error')
    s.endRun('error')
    expect(s.active).toBe(true)
    expect(s.waitRemaining()?.remainingMs).toBe(before?.remainingMs)
    s.dispose()
  })

  test('a wakeup reads the live background list from the host, not from memory', async () => {
    // The watcher the agent started earlier was stopped before this wakeup.
    // What the prompt says must track the host's list at fire time, so the
    // agent cannot keep reporting "watcher still running" from old context.
    let running: Array<{ taskId: string; command: string; elapsedMs: number }> = [
      { taskId: 'abcd1234ffff', command: 'gh pr checks --watch', elapsedMs: 120_000 },
    ]
    const turns: string[] = []
    let extension: HostToolExtension | undefined
    const s = new LoopSession({
      runTurn: (_line, prompt, ext) => { turns.push(prompt); extension = ext },
      canWake: () => true,
      notify: () => {},
      requestRender: () => {},
      backgroundTasks: () => running,
    })
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      s.handleCommand('/loop watch', 'watch')
      if (!extension) throw new Error('no extension')
      expect(turns[0]).toContain('Background shell still running: abcd1234 (2m) gh pr checks --watch.')
      await extension.dispatch(call({ delay_seconds: 60, reason: 'watching checks', noop: true }))
      s.endRun('ok')
      // Fire the wakeup via the 1s timer once the delay has elapsed.
      now += 61_000
      await new Promise(resolve => setTimeout(resolve, 1_100))
      expect(turns).toHaveLength(2)
      expect(turns[1]).toContain('Background shell still running: abcd1234 (2m) gh pr checks --watch.')
      expect(turns[1]).toContain('1 no-op tick since')

      running = []
      await extension.dispatch(call({ delay_seconds: 60, reason: 'watching checks', noop: true }))
      s.endRun('ok')
      now += 61_000
      await new Promise(resolve => setTimeout(resolve, 1_100))
      expect(turns).toHaveLength(3)
      expect(turns[2]).toContain('No background shell is running.')
      expect(turns[2]).toContain('2 no-op ticks since')
    } finally {
      Date.now = realNow
      s.dispose()
    }
  }, 10_000)
})

describe('loop tool card', () => {
  const base = { id: 't1', name: 'schedule_wakeup', startedAt: Date.UTC(2026, 0, 1, 12, 0, 0) }

  test('scheduled wakeup shows countdown, clock and reason', async () => {
    const { buildToolCard } = await import('../src/render/output.js')
    const lines = buildToolCard({
      ...base, status: 'done',
      args: { delay_seconds: 1600, reason: 'Waiting for the PR watcher to exit on a new codex review.', noop: false },
    })
    expect(lines).toHaveLength(2)
    expect(lines[0]?.text).toMatch(/^◌ loop · next wakeup in 26m 40s \(\d\d:\d\d:\d\d\)$/)
    expect(lines[1]?.text).toBe('  Waiting for the PR watcher to exit on a new codex review.')
    expect(lines[0]?.toolCard?.state).toBe('success')
  })

  test('quiet tick is marked', async () => {
    const { buildToolCard } = await import('../src/render/output.js')
    const [head] = buildToolCard({ ...base, status: 'done', args: { delay_seconds: 60, reason: 'r', noop: true } })
    expect(head?.text).toContain('◌ loop · quiet · next wakeup in 1m')
  })

  test('stop and error states', async () => {
    const { buildToolCard } = await import('../src/render/output.js')
    expect(buildToolCard({ ...base, status: 'done', args: { stop: true, reason: 'converged' } })[0]?.text).toBe('⏹ loop · stopping')
    const err = buildToolCard({ ...base, status: 'error', args: { reason: 'x' }, result: 'delay_seconds is required unless stop is true.' })
    expect(err[0]?.text).toBe('✗ loop · wakeup not scheduled')
    expect(err[1]?.text).toContain('delay_seconds is required')
    expect(buildToolCard({ ...base, status: 'running', args: {} })[0]?.text).toBe('◌ loop · scheduling next wakeup…')
  })
})

describe('LoopSession stop notice ordering', () => {
  test('a stop raised during a run is reported at endRun, not mid-stream', async () => {
    const { LoopSession } = await import('../src/loop/session.js')
    const notices: string[] = []
    let extension: HostToolExtension | undefined
    const session = new LoopSession({
      runTurn: (_line, _prompt, ext) => { extension = ext },
      canWake: () => true,
      notify: text => notices.push(text),
      requestRender: () => {},
    })
    session.handleCommand('/loop watch', 'watch')
    if (!extension) throw new Error('no extension')
    await extension.dispatch({ tool_call_id: '1', tool_name: 'schedule_wakeup', arguments: { stop: true, reason: 'converged' } })
    expect(session.active).toBe(false)
    expect(notices).toHaveLength(0)
    session.endRun('ok')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('⏹ loop done')
  })

  test('a user stop while idle is reported immediately', async () => {
    const { LoopSession } = await import('../src/loop/session.js')
    const notices: string[] = []
    const session = new LoopSession({
      runTurn: () => {},
      canWake: () => true,
      notify: text => notices.push(text),
      requestRender: () => {},
    })
    session.handleCommand('/loop watch', 'watch')
    session.endRun('ok')
    session.handleCommand('/loop stop', 'stop')
    expect(notices.at(-1)).toContain('⏹ loop stopped by you')
  })
})

describe('LoopSession waiting state', () => {
  test('reports working while a wakeup is pending and idle once stopped', async () => {
    const { LoopSession } = await import('../src/loop/session.js')
    const transitions: boolean[] = []
    let extension: HostToolExtension | undefined
    const session = new LoopSession({
      runTurn: (_line, _prompt, ext) => { extension = ext },
      canWake: () => true,
      notify: () => {},
      requestRender: () => {},
      waitingChanged: w => transitions.push(w),
    })
    session.handleCommand('/loop watch', 'watch')
    expect(session.waiting).toBe(false)
    if (!extension) throw new Error('no extension')
    await extension.dispatch({ tool_call_id: '1', tool_name: 'schedule_wakeup', arguments: { delay_seconds: 600, reason: 'r', noop: true } })
    expect(transitions).toEqual([])
    session.endRun('ok')
    expect(session.waiting).toBe(true)
    expect(transitions).toEqual([true])
    session.handleCommand('/loop stop', 'stop')
    expect(transitions).toEqual([true, false])
    session.dispose()
  })

  test('cancelWait stops a parked loop and is a no-op otherwise', async () => {
    const { LoopSession } = await import('../src/loop/session.js')
    const notices: string[] = []
    let extension: HostToolExtension | undefined
    const session = new LoopSession({
      runTurn: (_line, _prompt, ext) => { extension = ext },
      canWake: () => true,
      notify: line => notices.push(line),
      requestRender: () => {},
      waitingChanged: () => {},
    })
    expect(session.cancelWait()).toBe(false)
    session.handleCommand('/loop watch', 'watch')
    expect(session.cancelWait()).toBe(false) // a run is in flight; Esc belongs to it
    if (!extension) throw new Error('no extension')
    await extension.dispatch({ tool_call_id: '1', tool_name: 'schedule_wakeup', arguments: { delay_seconds: 600, reason: 'r', noop: true } })
    session.endRun('ok')
    expect(session.waiting).toBe(true)
    expect(session.cancelWait()).toBe(true)
    expect(session.waiting).toBe(false)
    expect(notices.some(n => n.includes('stopped by you'))).toBe(true)
    expect(session.cancelWait()).toBe(false)
    session.dispose()
  })
})

describe('formatLoopWaitLine', () => {
  test('says only how long until the next wakeup', () => {
    const line = formatLoopWaitLine({ remainingMs: 18 * 60_000 + 30_000 })
    expect(stripAnsi(line)).toBe('◌ loop · wakes in 18m30s')
  })

  test('brand tone while parked, yellow in the final minute', () => {
    const { brandHex } = getTheme()
    expect(formatLoopWaitLine({ remainingMs: 600_000 })).toContain(chalk.hex(brandHex)('◌ loop · wakes in 10m'))
    expect(formatLoopWaitLine({ remainingMs: 42_000 })).toContain(chalk.yellow('◌ loop · wakes in 42s'))
  })
})

describe('formatLoopWaitLine stop confirmation', () => {
  test('asks for the second Esc only while a stop is pending', () => {
    expect(stripAnsi(formatLoopWaitLine({ remainingMs: 600_000, stopPending: true })))
      .toBe('◌ loop · wakes in 10m · esc again to stop the loop')
    expect(stripAnsi(formatLoopWaitLine({ remainingMs: 600_000, stopPending: false })))
      .toBe('◌ loop · wakes in 10m')
  })
})
