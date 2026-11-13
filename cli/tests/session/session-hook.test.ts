import { describe, expect, test } from 'bun:test'
import { SessionHook } from '../../src/session/hook.js'

/** Collect NDJSON lines written to a fake adapter that always accepts writes. */
function recordingSpawn(lines: string[], fail = false) {
  return () => {
    if (fail) throw new Error('adapter unavailable')
    return { stdin: { write: (data: string) => lines.push(data), end: () => undefined } }
  }
}

function eventsFrom(lines: string[]): Array<Record<string, unknown>> {
  return lines.map(line => JSON.parse(line))
}

function kindsFrom(lines: string[]): string[] {
  return eventsFrom(lines).map(event => event.event as string)
}

function newHook(lines: string[], command = 'evot-hook', cwd?: string) {
  return new SessionHook({
    command,
    cwd,
    spawn: recordingSpawn(lines),
  })
}

describe('SessionHook', () => {
  test('only the resolved config command enables the bridge; the environment is never consulted', async () => {
    const previous = process.env.EVOT_SESSION_HOOK
    process.env.EVOT_SESSION_HOOK = 'environment-must-be-ignored'
    try {
      const commands: string[] = []
      const hook = new SessionHook({ command: ' /fixture/from-config ',
        spawn: command => { commands.push(command); return { stdin: { write: () => 1 } } } })
      hook.startProcess('/repo')
      await hook.close()
      expect(commands).toEqual(['/fixture/from-config'])
      for (const command of ['', '  ', undefined]) {
        const disabled = new SessionHook({ command, spawn: () => { throw new Error('must not spawn') } })
        disabled.startProcess('/repo')
        expect(disabled.enabled).toBe(false)
        await disabled.close()
      }
    } finally {
      if (previous === undefined) delete process.env.EVOT_SESSION_HOOK
      else process.env.EVOT_SESSION_HOOK = previous
    }
  })
  test('announces an idle process before a persisted session exists', () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startProcess('/repo')
    hook.state('idle')

    expect(eventsFrom(lines)).toEqual([
      { version: 1, event: 'session_started', cwd: '/repo', source: 'evot' },
      { version: 1, event: 'state_changed', state: 'idle' },
    ])
  })

  test('is inert when no external hook is configured', () => {
    let spawned = false
    const hook = new SessionHook({
      spawn: () => {
        spawned = true
        throw new Error('must not spawn')
      },
    })

    hook.startSession('session-1', '/repo')
    hook.runStarted('run-1')
    hook.close()

    expect(hook.enabled).toBe(false)
    expect(spawned).toBe(false)
  })

  test('emits ordered versioned NDJSON lifecycle events', async () => {
    const lines: string[] = []
    const hook = newHook(lines, 'evot-hook', '/repo')

    hook.startSession('session-1', '/repo')
    hook.runStarted('run-1')
    hook.state('blocked', 'waiting for approval')
    hook.runFinished('run-1')
    await hook.close('test')

    const events = eventsFrom(lines)
    expect(events.map(event => event.event)).toEqual([
      'session_started',
      'run_started',
      'state_changed',
      'state_changed',
      'run_finished',
      'state_changed',
      'session_ended',
    ])
    expect(events[0]).toMatchObject({
      version: 1,
      event: 'session_started',
      session_id: 'session-1',
      cwd: '/repo',
      source: 'evot',
    })
    expect(events[2]).toMatchObject({ event: 'state_changed', state: 'working' })
    expect(events[3]).toMatchObject({
      event: 'state_changed',
      state: 'blocked',
      message: 'waiting for approval',
    })
    expect(events.at(-1)).toMatchObject({
      event: 'session_ended',
      session_id: 'session-1',
      reason: 'test',
    })
  })

  test('ends the previous session before starting a new one', () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startSession('session-1', '/repo')
    hook.startSession('session-2', '/repo')

    expect(kindsFrom(lines)).toEqual(['session_started', 'session_ended', 'session_started'])
    expect(eventsFrom(lines)[1]).toMatchObject({
      session_id: 'session-1',
      reason: 'session_changed',
    })
  })

  test('isolates adapter startup failures', () => {
    const hook = new SessionHook({
      command: 'missing-hook',
      spawn: recordingSpawn([], true),
    })

    expect(() => {
      hook.startSession('session-1', '/repo')
      hook.runStarted('run-1')
      hook.runFailed('run-1', 'failed')
      hook.close()
    }).not.toThrow()
  })

  // --- run settlement: the hook owns "did this run already settle?" ---

  test('settles an open run only once', () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startSession('session-1', '/repo')
    hook.runStarted('run-1')
    hook.runFinished('run-1')
    // A late error plus a finally-block safety net must not re-report the run.
    hook.runFailed('run-1', 'too late')
    hook.settleRun()

    expect(kindsFrom(lines)).toEqual([
      'session_started',
      'run_started',
      'state_changed',
      'run_finished',
      'state_changed',
    ])
  })

  test('settleRun returns an abandoned run to idle without a verdict', () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startSession('session-1', '/repo')
    hook.runStarted('run-1')
    hook.state('blocked', 'waiting')
    // Interrupt: no run_finished and no run_failed ever arrives.
    hook.settleRun()

    expect(kindsFrom(lines)).toEqual([
      'session_started',
      'run_started',
      'state_changed',
      'state_changed',
      'state_changed',
    ])
    expect(eventsFrom(lines).at(-1)).toMatchObject({ state: 'idle' })
  })

  test('ignores run settlement when no run is open', () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startSession('session-1', '/repo')
    hook.runFinished('run-1')
    hook.runFailed('run-1', 'nope')
    hook.settleRun()

    expect(kindsFrom(lines)).toEqual(['session_started'])
  })

  test('does not carry a settled run across a session change', () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startSession('session-1', '/repo')
    hook.runStarted('run-1')
    hook.startSession('session-2', '/repo')
    // The old run belonged to session-1 and must not settle under session-2.
    hook.settleRun()

    expect(kindsFrom(lines)).toEqual([
      'session_started',
      'run_started',
      'state_changed',
      'session_ended',
      'session_started',
    ])
  })

  // --- shutdown must never depend on adapter behavior ---

  test('closes without waiting for the adapter process to exit', async () => {
    const lines: string[] = []
    let ended = false
    const hook = new SessionHook({
      command: 'evot-hook',
      // A long-lived adapter: `exited` never settles. Awaiting it would hang evot.
      spawn: () => ({
        stdin: {
          write: (data: string) => lines.push(data),
          end: () => { ended = true },
        },
        exited: new Promise<never>(() => {}),
      }),
    })

    hook.startProcess('/repo')
    await hook.close('test')

    expect(ended).toBe(true)
    expect(kindsFrom(lines)).toEqual(['session_started', 'session_ended'])
  })

  test('drains queued backpressured writes before releasing stdin', async () => {
    const lines: string[] = []
    let resolveFirstWrite: (() => void) | undefined
    let writes = 0
    let ended = false
    const hook = new SessionHook({
      command: 'evot-hook',
      spawn: () => ({
        stdin: {
          // Bun's FileSink returns a Promise once the pipe is full.
          write: (data: string) => {
            lines.push(data)
            writes += 1
            if (writes === 1) return new Promise<void>(resolve => { resolveFirstWrite = resolve })
            return Promise.resolve()
          },
          end: () => { ended = true },
        },
      }),
    })

    hook.startProcess('/repo')
    const closing = hook.close('test')
    await Promise.resolve()
    expect(ended).toBe(false)

    resolveFirstWrite?.()
    await closing

    expect(ended).toBe(true)
    expect(kindsFrom(lines)).toEqual(['session_started', 'session_ended'])
  })

  test('gives up on a wedged adapter instead of blocking shutdown', async () => {
    let ended = false
    const hook = new SessionHook({
      command: 'evot-hook',
      spawn: () => ({
        stdin: {
          // An adapter that never drains stdin: every write stays pending forever.
          write: () => new Promise<void>(() => {}),
          end: () => { ended = true },
        },
      }),
    })

    hook.startProcess('/repo')
    hook.state('idle')

    const start = Date.now()
    await hook.close('test')

    // Bounded by FLUSH_TIMEOUT_MS rather than the adapter.
    expect(Date.now() - start).toBeLessThan(2000)
    expect(ended).toBe(true)
  })

  test('close is idempotent and later events are dropped', async () => {
    const lines: string[] = []
    const hook = newHook(lines)

    hook.startSession('session-1', '/repo')
    await hook.close('first')
    await hook.close('second')
    hook.runStarted('run-2')
    hook.state('working')

    expect(kindsFrom(lines)).toEqual(['session_started', 'session_ended'])
    expect(eventsFrom(lines).at(-1)).toMatchObject({ reason: 'first' })
  })

  test('stops writing to an adapter whose pipe has broken', () => {
    const lines: string[] = []
    let spawns = 0
    const hook = new SessionHook({
      command: 'evot-hook',
      spawn: () => {
        spawns += 1
        return {
          stdin: {
            write: (data: string) => {
              if (spawns === 1 && lines.length >= 1) throw new Error('EPIPE')
              lines.push(data)
              return 1
            },
            end: () => undefined,
          },
        }
      },
    })

    hook.startProcess('/repo')
    // The pipe breaks here; the hook drops the process and respawns on the next event.
    hook.state('working')
    hook.state('idle')

    expect(spawns).toBe(2)
    expect(kindsFrom(lines)).toEqual(['session_started', 'state_changed'])
  })
})
