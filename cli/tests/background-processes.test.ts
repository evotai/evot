import { describe, test, expect } from 'bun:test'
import {
  backgroundProcessFingerprint,
  decideSessionSwitch,
  runningBackgroundCount,
  SETTLED_SNAPSHOT_LINE_WIDTH,
  SETTLED_SNAPSHOT_TAIL_LINES,
  settledOutputSnapshot,
  shouldWakeForNotifications,
  stopAllMessage,
  stopOneMessage,
} from '../src/term/app/background-processes.js'
import type { BackgroundProcess } from '../src/native/index.js'

function proc(overrides: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return {
    task_id: '028deb34-db80-401f-8c65-7b13f92efb36',
    command: 'sleep 30',
    cwd: '/tmp',
    output_path: '/tmp/out.txt',
    status: 'running',
    exit_code: null,
    elapsed_ms: 1500,
    output_file_truncated: false,
    ...overrides,
  }
}

describe('settledOutputSnapshot', () => {
  test('keeps only the tail lines and says how many were hidden', () => {
    const output = Array.from({ length: SETTLED_SNAPSHOT_TAIL_LINES + 3 }, (_, i) => `line ${i}`).join('\n')
    const block = settledOutputSnapshot(proc({ status: 'completed', exit_code: 0 }), output)
    expect(block).toContain('… 3 earlier lines')
    expect(block).not.toContain('line 2\n')
    expect(block).toContain(`line ${SETTLED_SNAPSHOT_TAIL_LINES + 2}`)
    expect(block).toContain('/tmp/out.txt')
  })

  test('caps a single huge line so one JSON blob cannot fill the screen', () => {
    // An extracted web page arrives as one minified JSON line of several
    // thousand characters: a line budget alone would let it wrap for pages.
    const long = `{"content": "${'x'.repeat(5000)}"}`
    const block = settledOutputSnapshot(proc({ status: 'completed', exit_code: 0 }), `ok\n${long}`)
    const bodyLines = block.split('\n').filter(line => line.startsWith('    '))
    for (const line of bodyLines) {
      expect(line.length).toBeLessThanOrEqual(SETTLED_SNAPSHOT_LINE_WIDTH + 4)
    }
    expect(block).toContain(' ... ')
    expect(block).toContain('{"content"')
  })
})

describe('shouldWakeForNotifications', () => {
  const ready = {
    pending: 1,
    hasSession: true,
    runInFlight: false,
    queuedMessages: 0,
    overlayBlocking: false,
  }

  test('wakes when a queued notice has nobody else to carry it', () => {
    expect(shouldWakeForNotifications(ready)).toBe(true)
  })

  test('does not wake while a run or queued message already owns the turn', () => {
    expect(shouldWakeForNotifications({ ...ready, runInFlight: true })).toBe(false)
    expect(shouldWakeForNotifications({ ...ready, queuedMessages: 1 })).toBe(false)
  })
})

describe('runningBackgroundCount', () => {
  test('counts only backgrounded work', () => {
    // A foreground command is already visible as a running tool card, so
    // counting it in the footer would report the same command twice.
    expect(runningBackgroundCount([
      proc({ status: 'running' }),
      proc({ status: 'running_foreground' }),
      proc({ status: 'completed' }),
    ])).toBe(1)
  })

  test('is zero for an empty list', () => {
    expect(runningBackgroundCount([])).toBe(0)
  })
})

describe('backgroundProcessFingerprint', () => {
  test('ignores elapsed time so a ticking clock does not force re-renders', () => {
    const before = backgroundProcessFingerprint([proc({ elapsed_ms: 1000 })])
    const after = backgroundProcessFingerprint([proc({ elapsed_ms: 90_000 })])
    expect(after).toBe(before)
  })

  test('changes when status or exit code moves', () => {
    const running = backgroundProcessFingerprint([proc()])
    expect(backgroundProcessFingerprint([proc({ status: 'completed', exit_code: 0 })]))
      .not.toBe(running)
  })
})

describe('decideSessionSwitch', () => {
  test('unrelated commands are never gated', () => {
    expect(decideSessionSwitch({ command: '/model', running: 3, warnedFor: null }))
      .toEqual({ kind: 'proceed' })
  })

  test('switching is free when nothing runs in the background', () => {
    expect(decideSessionSwitch({ command: '/new', running: 0, warnedFor: null }))
      .toEqual({ kind: 'proceed' })
  })

  test('first attempt warns and names the escape hatch', () => {
    const decision = decideSessionSwitch({ command: '/clear', running: 2, warnedFor: null })
    expect(decision.kind).toBe('warn')
    if (decision.kind !== 'warn') return
    expect(decision.running).toBe(2)
    expect(decision.message).toContain('2 background terminals still running')
    expect(decision.message).toContain('repeat /clear to switch anyway')
  })

  test('repeating the same command proceeds, so a wedged task cannot trap the user', () => {
    expect(decideSessionSwitch({ command: '/clear', running: 2, warnedFor: '/clear' }))
      .toEqual({ kind: 'proceed' })
  })

  test('a warning for one command does not clear the gate for another', () => {
    expect(decideSessionSwitch({ command: '/resume', running: 1, warnedFor: '/clear' }).kind)
      .toBe('warn')
  })

  test('singular wording for a single task', () => {
    const decision = decideSessionSwitch({ command: '/new', running: 1, warnedFor: null })
    if (decision.kind !== 'warn') throw new Error('expected a warning')
    expect(decision.message).toContain('1 background terminal still running')
  })
})

describe('stop messages', () => {
  test('stopAllMessage pluralizes and reports an empty stop', () => {
    expect(stopAllMessage(0)).toBe('  No background terminals running.')
    expect(stopAllMessage(1)).toBe('  ■ Stopped 1 background terminal.')
    expect(stopAllMessage(3)).toBe('  ■ Stopped 3 background terminals.')
  })

  test('stopOneMessage confirms a terminated task', () => {
    expect(stopOneMessage(proc({ status: 'killed' })))
      .toBe('  ■ Stopped 028deb34  sleep 30')
  })

  test('a task that outlived the stop timeout is not reported as stopped', () => {
    // The engine keeps such a task's notification pending, so the UI must not
    // claim success either.
    expect(stopOneMessage(proc({ status: 'running' })))
      .toBe('  ● 028deb34 did not stop within the timeout and is still running  sleep 30')
  })
})
