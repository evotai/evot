import { describe, test, expect } from 'bun:test'
import { RunInteraction } from '../src/term/app/run-interaction.js'
import { decideReplControl } from '../src/term/app/repl-control.js'
import { createEditorState } from '../src/term/input/editor.js'
import { BackgroundTerminals } from '../src/term/app/background-terminals.js'
import { isBackgroundSelector } from '../src/term/app/selector-identity.js'
import { backgroundOutputRows } from '../src/term/app/background-panel.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import stripAnsi from 'strip-ansi'
import type { SelectorState } from '../src/term/selector.js'
import type { BackgroundProcess } from '../src/native/index.js'

function proc(overrides: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return {
    task_id: 'aaaaaaaa-1111',
    command: 'sleep 30',
    cwd: '/tmp',
    output_path: '/tmp/out.txt',
    status: 'running',
    exit_code: null,
    elapsed_ms: 1500,
    output_file_truncated: false,
    stopped_by_user: false,
    ...overrides,
  }
}

/** `n` numbered output lines, longer than any body window used in these tests. */
function longOutput(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
}

/**
 * Drives the controller with an in-memory overlay and client, mirroring how
 * `repl.ts` wires it: `panelOpen` is derived from the overlay's identity, so the
 * tests exercise the same guard the REPL relies on.
 */
function harness(options: {
  processes?: BackgroundProcess[]
  sessionId?: string | null | (() => string)
  output?: string | (() => string)
  stopOne?: (taskId: string) => Promise<BackgroundProcess | null>
  stopAll?: () => Promise<BackgroundProcess[]>
  backgroundForeground?: () => number
  startingBlockingWaits?: number
  blockingWaits?: () => number
  releaseBlockingWaits?: () => number
  onList?: () => BackgroundProcess[]
  /** Terminal height seen by the output view; defaults to a 24-row terminal. */
  rows?: number
  /** Queued completion notices the engine has not yet handed to a turn. */
  pendingNotifications?: () => number
  runInFlight?: () => boolean
  queuedMessages?: () => number
  overlayBlocking?: () => boolean
  /** Present by default so a wake is observable; pass null to omit the hook. */
  wake?: (() => void) | null
} = {}) {
  let processes = options.processes ?? []
  let panel: SelectorState | null = null
  const commits: Array<{ slot: string; text: string }> = []
  let renders = 0
  let messageDetaches = 0
  let wakes = 0
  let outputChanged: (() => void) | undefined
  let outputReads = 0
  let blockingWaits = options.startingBlockingWaits ?? 0

  // Shared by both detach entry points so a test cannot pass for one and fail
  // for the other. Mirrors the native side: only foreground shells move, and
  // they keep running.
  const detachForeground = (): number => {
    if (options.backgroundForeground) return options.backgroundForeground()
    const moved = processes.filter(candidate => candidate.status === 'running_foreground')
    processes = processes.map(candidate =>
      candidate.status === 'running_foreground'
        ? { ...candidate, status: 'running' as const }
        : candidate,
    )
    return moved.length
  }

  const controller = new BackgroundTerminals({
    columns: () => 80,
    rows: () => options.rows ?? 24,
    client: {
      backgroundProcesses: () => (options.onList ? options.onList() : processes),
      stopBackgroundProcess: async (_sessionId, taskId) => {
        if (options.stopOne) return options.stopOne(taskId)
        const target = processes.find(candidate => candidate.task_id === taskId)
        if (!target) return null
        const stopped = { ...target, status: 'killed' as const, stopped_by_user: true }
        processes = processes.map(candidate => candidate.task_id === taskId ? stopped : candidate)
        return stopped
      },
      stopAllBackgroundProcesses: async () => {
        if (options.stopAll) return options.stopAll()
        const live = processes.filter(candidate => candidate.status === 'running')
          .map(candidate => ({ ...candidate, status: 'killed' as const, stopped_by_user: true }))
        processes = processes.map(candidate => live.find(stopped => stopped.task_id === candidate.task_id) ?? candidate)
        return live
      },
      backgroundForegroundProcesses: () => detachForeground(),
      backgroundForegroundProcessesForMessage: () => {
        messageDetaches++
        return detachForeground()
      },
      blockingTaskWaits: () => {
        if (options.blockingWaits) return options.blockingWaits()
        return blockingWaits
      },
      releaseBlockingTaskWaits: () => {
        if (options.releaseBlockingWaits) return options.releaseBlockingWaits()
        const released = blockingWaits
        blockingWaits = 0
        return released
      },
      killAllBackgroundProcessesNow: () => processes.length,
      pendingProcessWakeNotifications: () => options.pendingNotifications?.() ?? 0,
    },
    sessionId: () => typeof options.sessionId === 'function' ? options.sessionId() : (options.sessionId === undefined ? 'session-1' : options.sessionId),
    commit: (slot, text) => commits.push({ slot, text }),
    requestRender: () => { renders++ },
    errorText: err => (err instanceof Error ? err.message : String(err)),
    watchOutput: (_path, changed) => {
      outputChanged = changed
      return () => { outputChanged = undefined }
    },
    readOutput: () => {
      outputReads++
      if (typeof options.output === 'function') return options.output()
      return options.output ?? ''
    },
    openPanel: state => { panel = state },
    updatePanel: state => { panel = state },
    panelOpen: () => panel !== null && isBackgroundSelector(panel),
    panelState: () => panel,
    runInFlight: () => options.runInFlight?.() ?? false,
    queuedMessages: () => options.queuedMessages?.() ?? 0,
    overlayBlocking: () => options.overlayBlocking?.() ?? false,
    wakeForNotifications: options.wake === null
      ? undefined
      : (options.wake ?? (() => { wakes++ })),
  })

  return {
    controller,
    commits,
    texts: () => commits.map(entry => entry.text),
    panel: () => panel,
    renders: () => renders,
    setProcesses: (next: BackgroundProcess[]) => { processes = next },
    processes: () => processes,
    messageDetaches: () => messageDetaches,
    wakes: () => wakes,
    outputChanged: () => outputChanged?.(),
    outputReads: () => outputReads,
  }
}

test('suggestion task metadata comes only from the current polled session without reading output', () => {
  let session = 'first'
  const running = proc({ description: 'Validate authentication', quiet_for_ms: 1200 })
  const h = harness({ sessionId: () => session, processes: [running, proc({ task_id: 'done', status: 'completed' })] })
  h.controller.refresh()
  expect(h.controller.runningProcesses()).toEqual([running])
  expect(h.outputReads()).toBe(0)
  session = 'second'
  expect(h.controller.runningProcesses()).toEqual([])
  expect(h.outputReads()).toBe(0)
})

describe('BackgroundTerminals.handlePromptDown', () => {
  test('renamed background views still refresh and route back to the list', () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })], output: 'latest output' })
    h.controller.togglePanel()
    const list = h.panel()
    if (!list) throw new Error('expected background list')
    list.title = 'Renamed list'
    expect(h.controller.handlePanelKey({ type: 'enter' })).toBe(true)
    const output = h.panel()
    if (!output) throw new Error('expected output view')
    output.title = 'Models'
    h.controller.refresh()
    expect(h.panel()?.presentation).toBe('background-output')
    expect(h.panel()?.items[0]?.preview?.join('\n')).toContain('latest output')
    expect(h.controller.handlePanelKey({ type: 'escape' })).toBe(true)
    expect(h.panel()?.presentation).toBe('background-list')
    expect(h.panel()?.items[0]?.id).toBe(proc().task_id)
  })

  test('a foreign selector cannot stop tasks even if its title matches', () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    const panel = h.panel()
    if (!panel) throw new Error('expected panel')
    panel.owner = Symbol('foreign')
    expect(h.controller.handlePanelKey({ type: 'char', char: 'x' })).toBe(false)
    expect(h.processes()[0]?.status).toBe('running')
  })

  test('↓ opens the panel on an empty composer with live work', () => {
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    expect(h.controller.handlePromptDown(true)).toBe(true)
    expect(h.panel()).not.toBeNull()
  })

  test('↓ is declined while the composer has text', () => {
    // Returning false leaves the key to the editor, which still moves the caret.
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    expect(h.controller.handlePromptDown(false)).toBe(false)
    expect(h.panel()).toBeNull()
  })

  test('↓ is declined when nothing is running', () => {
    const h = harness({ processes: [proc({ status: 'completed', exit_code: 0 })] })
    h.controller.refresh()
    expect(h.controller.handlePromptDown(true)).toBe(false)
    expect(h.panel()).toBeNull()
  })

  test('a foreground-only task does not arm ↓', () => {
    // It is already visible as a running tool card, so the prompt does not
    // advertise the panel for it and ↓ must keep its editor meaning.
    const h = harness({ processes: [proc({ status: 'running_foreground' })] })
    h.controller.refresh()
    expect(h.controller.handlePromptDown(true)).toBe(false)
  })

  test('the gesture and the prompt hint read the same polled snapshot', () => {
    // Both derive from `runningCount()`, so ↓ can never be live while the chip
    // above the composer is absent, or vice versa.
    const h = harness({ processes: [proc()] })
    expect(h.controller.hintVisible(true)).toBe(false)
    expect(h.controller.handlePromptDown(true)).toBe(false)

    h.controller.refresh()
    expect(h.controller.hintVisible(true)).toBe(true)
    expect(h.controller.hintVisible(false)).toBe(false)
  })

  test('an idle session never advertises the gesture', () => {
    const h = harness({ processes: [] })
    h.controller.refresh()
    expect(h.controller.hintVisible(true)).toBe(false)
  })
})

describe('BackgroundTerminals.togglePanel', () => {
  test('one task opens directly in detail and Esc returns to the prompt', () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    expect(h.panel()?.presentation).toBe('background-output')
    expect(h.panel()!.items).toHaveLength(1)
    h.controller.handlePanelKey({ type: 'escape' })
    expect(h.panel()).toBeNull()
  })

  test('finished history never opens a panel', () => {
    for (const status of ['completed', 'failed', 'killed'] as const) {
      const h = harness({ processes: [proc({ status })] })
      h.controller.togglePanel()
      expect(h.panel()).toBeNull()
      expect(h.texts()[0]).toContain('No tasks currently running')
    }
  })

  test('a second press closes it, so one key round-trips', () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    h.controller.togglePanel()
    expect(h.panel()).toBeNull()
  })

  test('opening refreshes first, so the list is never stale', () => {
    const h = harness({ processes: [] })
    h.setProcesses([proc(), proc({ task_id: 'bbbbbbbb-2222' })])
    h.controller.togglePanel()
    expect(h.panel()!.items).toHaveLength(2)
  })

  test('without a session it explains itself instead of opening empty', () => {
    const h = harness({ sessionId: null })
    h.controller.togglePanel()
    expect(h.panel()).toBeNull()
    expect(h.texts()[0]).toContain('No active session')
  })

  test('an empty list stays at the prompt with a one-line answer', () => {
    // "Nothing running" is a fact, not something to manage: an overlay for it
    // would only cost an Esc.
    const h = harness({ processes: [] })
    h.controller.togglePanel()
    expect(h.panel()).toBeNull()
    expect(h.texts()).toEqual(['  No tasks currently running.'])
  })

  test('the list closes itself when the last task finishes', () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'bbbbbbbb-2222' })] })
    h.controller.togglePanel()
    expect(h.panel()?.presentation).toBe('background-list')
    h.setProcesses([proc({ status: 'completed' }), proc({ task_id: 'bbbbbbbb-2222' })])
    h.controller.refresh()
    expect(h.panel()!.items).toHaveLength(1)
    h.setProcesses([proc({ status: 'completed' }), proc({ task_id: 'bbbbbbbb-2222', status: 'completed' })])
    h.controller.refresh()
    expect(h.panel()).toBeNull()
  })
})

describe('BackgroundTerminals panel refresh', () => {
  test('a poll updates the open panel in place', () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    h.setProcesses([proc({ elapsed_ms: 61_000 })])
    h.controller.refresh()
    expect(h.panel()!.items[0]!.detail).toBe('running · 1m 1s')
    expect(h.panel()?.presentation).toBe('background-output')
  })

  test('the management list drops settled tasks while retaining their records', () => {
    const a = proc({ task_id: 'a' })
    const b = proc({ task_id: 'b' })
    const h = harness({ processes: [a, b] })
    h.controller.togglePanel()
    h.setProcesses([{ ...a, status: 'completed' }, b])
    h.controller.refresh()
    expect(h.panel()?.items.map(item => item.id)).toEqual(['b'])
    expect(h.panel()?.subtitle).toBe('1 active shell')
    h.setProcesses([{ ...a, status: 'completed' }, { ...b, status: 'failed' }])
    h.controller.refresh()
    // Nothing left to manage: the list hands the screen back on its own.
    expect(h.panel()).toBeNull()
  })

  test('a closed panel is not reopened by a poll', () => {
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    expect(h.panel()).toBeNull()
  })

  test('a failing list call keeps the last known state', () => {
    let fail = false
    const h = harness({
      processes: [proc()],
      onList: () => {
        if (fail) throw new Error('session gone')
        return [proc()]
      },
    })
    h.controller.refresh()
    expect(h.controller.runningCount()).toBe(1)
    fail = true
    h.controller.refresh()
    expect(h.controller.runningCount()).toBe(1)
  })
})

describe('BackgroundTerminals.handlePanelKey', () => {
  test('returns false when the panel is closed, leaving keys to the REPL', () => {
    const h = harness({ processes: [proc()] })
    expect(h.controller.handlePanelKey({ type: 'enter' })).toBe(false)
  })

  test('esc closes the panel and consumes the key', () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'escape' })).toBe(true)
    expect(h.panel()).toBeNull()
  })

  test('navigation keys in a multi-task list are left to the selector', () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })] })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'down' })).toBe(false)
  })

  test('enter opens a live output view without writing to the transcript', () => {
    const h = harness({ processes: [proc()], output: 'building…\ndone\n' })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'enter' })).toBe(true)
    expect(h.panel()?.presentation).toBe('background-output')
    expect(h.panel()?.items[0]?.preview).toContain('building…')
    expect(h.panel()?.items[0]?.preview).toContain('done')
    expect(h.texts()).toHaveLength(0)
  })

  test('output events update the view without waiting for the status poll', () => {
    let output = 'building…\n'
    const h = harness({ processes: [proc()], output: () => output })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'enter' })

    output += 'done\n'
    const reads = h.outputReads()
    h.controller.refresh()
    expect(h.outputReads()).toBe(reads)
    expect(h.panel()?.items[0]?.preview).not.toContain('done')
    h.outputChanged()
    expect(h.panel()?.items[0]?.preview).toContain('done')
  })

  test('the live view closes by itself when the watched task finishes', () => {
    // Watching a build to the end must not cost an extra esc for every task:
    // the prompt comes back, and what was on screen goes into the transcript.
    const h = harness({ processes: [proc()], output: 'building…\ndone\n' })
    h.controller.togglePanel()
    expect(h.panel()?.presentation).toBe('background-output')
    h.setProcesses([proc({ status: 'completed', exit_code: 0, elapsed_ms: 2500 })])
    h.controller.refresh()

    expect(h.panel()).toBeNull()
    const settled = h.commits.filter(entry => entry.slot === 'settled')
    expect(settled).toHaveLength(1)
    const text = settled[0]!.text
    expect(text).toContain('✓ completed in background · exit 0 · aaaaaaaa  sleep 30')
    expect(text).toContain('    building…')
    expect(text).toContain('    done')
    expect(text).toContain('    /tmp/out.txt')
    // Further polls do not re-announce or re-open anything.
    h.controller.refresh()
    expect(h.panel()).toBeNull()
    expect(h.commits.filter(entry => entry.slot === 'settled')).toHaveLength(1)
    // Output-file events after the close are ignored.
    const reads = h.outputReads()
    h.outputChanged()
    expect(h.outputReads()).toBe(reads)
  })

  test('a finished task viewed from the list returns to the list while others run', () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'bbbbbbbb-2222', command: 'make check' })] })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'enter' })
    expect(h.panel()?.presentation).toBe('background-output')
    h.setProcesses([proc({ status: 'failed', exit_code: 2 }), proc({ task_id: 'bbbbbbbb-2222', command: 'make check' })])
    h.controller.refresh()

    expect(h.panel()?.presentation).toBe('background-list')
    expect(h.panel()?.items.map(item => item.id)).toEqual(['bbbbbbbb-2222'])
    expect(h.texts().join('\n')).toContain('✗ failed in background · exit 2')
  })

  test('a finished task viewed from the list closes the overlay when it was the last one', () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'bbbbbbbb-2222' })] })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'enter' })
    h.setProcesses([proc({ status: 'completed', exit_code: 0 }), proc({ task_id: 'bbbbbbbb-2222', status: 'completed', exit_code: 0 })])
    h.controller.refresh()

    expect(h.panel()).toBeNull()
    // Both tasks settled in one poll: the watched one via the view, the other
    // via the ordinary notice. Each is reported exactly once.
    expect(h.commits.filter(entry => entry.slot === 'settled')).toHaveLength(2)
  })

  test('a frozen viewport is not closed under the reader when the task finishes', () => {
    let output = longOutput(40)
    const h = harness({ processes: [proc()], output: () => output })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'up' })
    expect(h.panel()?.outputView?.scrollOffset).toBeDefined()
    h.setProcesses([proc({ status: 'completed', exit_code: 0, elapsed_ms: 2500 })])
    h.controller.refresh()

    expect(h.panel()?.presentation).toBe('background-output')
    expect(h.panel()?.items[0]?.detail).toContain('exit 0')
    // The plain notice still lands in the transcript, once.
    expect(h.commits.filter(entry => entry.slot === 'settled')).toHaveLength(1)
    expect(h.controller.handlePanelKey({ type: 'escape' })).toBe(true)
    expect(h.panel()).toBeNull()
  })

  test('stopping the watched task from its view closes the view without a second notice', async () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'char', char: 'x' })).toBe(true)
    await h.controller.settled()
    expect(h.panel()).toBeNull()
    expect(h.texts().filter(text => text.includes('aaaaaaaa'))).toHaveLength(1)
    expect(h.texts().join('\n')).toContain('Stopped aaaaaaaa')
  })

  test('↑ on output that already fits is inert instead of pausing an empty window', () => {
    const h = harness({ processes: [proc()], output: 'one\ntwo\nthree\n' })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'up' })).toBe(true)
    expect(h.panel()?.outputView?.scrollOffset).toBeUndefined()
    expect(h.controller.handlePanelKey({ type: 'page-up' })).toBe(true)
    expect(h.panel()?.outputView?.scrollOffset).toBeUndefined()
  })

  test('scrolling moves a fixed-height window over the body and resumes following at the tail', () => {
    // 24 rows → budget 20, minus 2 header and 2 footer rows = a 16-row body window.
    const h = harness({ processes: [proc()], output: longOutput(40), rows: 24 })
    h.controller.togglePanel()
    const rendered = () => buildSelectorRegionLines(h.panel()!, 80, 24).map(stripAnsi)
    const height = rendered().length
    const body = backgroundOutputRows(h.panel()!, 80)
    const maxStart = body.length - 16

    h.controller.handlePanelKey({ type: 'up' })
    expect(h.panel()?.outputView?.scrollOffset).toBe(maxStart - 1)
    expect(rendered()).toHaveLength(height)
    h.controller.handlePanelKey({ type: 'page-up' })
    expect(h.panel()?.outputView?.scrollOffset).toBe(maxStart - 1 - 15)
    expect(rendered()).toHaveLength(height)
    h.controller.handlePanelKey({ type: 'home' })
    expect(h.panel()?.outputView?.scrollOffset).toBe(0)
    expect(rendered()).toHaveLength(height)
    expect(rendered().join('\n')).toContain('Command')
    // Every further ↑ is clamped at the top; the overlay never shrinks.
    h.controller.handlePanelKey({ type: 'up' })
    expect(h.panel()?.outputView?.scrollOffset).toBe(0)
    expect(rendered()).toHaveLength(height)

    h.controller.handlePanelKey({ type: 'char', char: 'c' })
    expect(h.panel()?.outputView?.scrollOffset).toBe(0)
    h.controller.handlePanelKey({ type: 'page-down' })
    expect(h.panel()?.outputView?.scrollOffset).toBe(15)
    // Walking down onto the last window hands control back to the tail.
    for (let i = 0; i < 40 && h.panel()?.outputView?.scrollOffset !== undefined; i++) {
      h.controller.handlePanelKey({ type: 'down' })
    }
    expect(h.panel()?.outputView?.scrollOffset).toBeUndefined()
    expect(rendered()).toHaveLength(height)
  })

  test('reading earlier output freezes the viewport while new output is received', () => {
    let output = longOutput(40)
    const h = harness({ processes: [proc()], output: () => output })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'up' })
    const offset = h.panel()?.outputView?.scrollOffset
    expect(offset).toBeDefined()
    output += 'four\n'
    h.outputChanged()
    expect(h.panel()?.outputView?.scrollOffset).toBe(offset)
    expect(h.panel()?.items[0]?.preview).not.toContain('four')
    h.controller.handlePanelKey({ type: 'end' })
    expect(h.panel()?.outputView?.scrollOffset).toBeUndefined()
    expect(h.panel()?.items[0]?.preview).toContain('four')
    h.controller.handlePanelKey({ type: 'escape' })
    const reads = h.outputReads()
    h.outputChanged()
    expect(h.outputReads()).toBe(reads)
    expect(h.panel()).toBeNull()
  })

  test('latest list activity is subordinate text and does not change task identity', () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })], output: 'first\nlatest\n' })
    h.controller.togglePanel()
    expect(h.panel()?.items[0]?.activity).toBe('latest')
    expect(h.panel()?.items[0]?.id).toBe(proc().task_id)
    expect(h.panel()?.items[0]?.preview).toBeUndefined()
  })

  test('esc returns from output to the list and keeps focus on the task', () => {
    const h = harness({
      processes: [proc(), proc({ task_id: 'bbbbbbbb-2222', command: 'make check' })],
    })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'down' })
    // Navigation is owned by the selector in production; focus it directly in
    // this controller harness before opening the second task.
    const panel = h.panel()
    if (panel) panel.focusIndex = 1
    h.controller.handlePanelKey({ type: 'enter' })
    expect(h.panel()?.items[0]?.id).toBe('bbbbbbbb-2222')

    expect(h.controller.handlePanelKey({ type: 'escape' })).toBe(true)
    expect(h.panel()?.presentation).toBe('background-list')
    expect(h.panel()?.items[h.panel()?.focusIndex ?? 0]?.id).toBe('bbbbbbbb-2222')
  })

  test('global control chords pass through the live output view', () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'enter' })
    expect(h.controller.handlePanelKey({ type: 'ctrl', key: 'c' })).toBe(false)
    expect(h.controller.handlePanelKey({ type: 'char', char: 'x' })).toBe(true)
  })

  test('an unreadable output file is shown in the live view instead of throwing', () => {
    const h = harness({
      processes: [proc()],
      output: () => { throw new Error('ENOENT') },
    })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'enter' })
    expect(h.panel()?.items[0]?.preview?.join('\n')).toContain('could not read output: ENOENT')
    expect(h.texts()).toHaveLength(0)
  })

  test('x stops the focused task and confirms it', async () => {
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'char', char: 'x' })).toBe(true)
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('Stopped aaaaaaaa')
    expect(h.processes()[0]!.status).toBe('killed')
  })

  test('x with no panel open is inert and leaves keys to the REPL', () => {
    const h = harness({ processes: [proc({ status: 'completed', exit_code: 0 })] })
    expect(h.controller.handlePanelKey({ type: 'char', char: 'x' })).toBe(false)
    expect(h.texts()).toHaveLength(0)
  })

  test('a task that outlives the stop timeout is not claimed as stopped', async () => {
    const h = harness({
      processes: [proc()],
      stopOne: async () => proc({ status: 'running' }),
    })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'char', char: 'x' })
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('did not stop within the timeout')
  })

  test('a stop failure is surfaced rather than swallowed', async () => {
    const h = harness({
      processes: [proc()],
      stopOne: async () => { throw new Error('signal refused') },
    })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'char', char: 'x' })
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('signal refused')
  })

  test('shift+X stops every task and reports the count', async () => {
    const h = harness({
      processes: [proc(), proc({ task_id: 'bbbbbbbb-2222' })],
    })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'shift-char', char: 'x' })).toBe(true)
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('Stopped 2 background terminals')
  })

  test('stopping refreshes the panel, so the stopped row leaves the list', async () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'bbbbbbbb-2222' })] })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'char', char: 'x' })
    await h.controller.settled()
    expect(h.panel()?.presentation).toBe('background-list')
    expect(h.panel()?.items.map(item => item.id)).toEqual(['bbbbbbbb-2222'])
  })
})

describe('BackgroundTerminals panel entry', () => {
  test('togglePanel opens the panel rather than dumping lines', async () => {
    // Background work is managed only through the panel: there are no slash
    // commands, so this is the single entry point.
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    expect(h.panel()).not.toBeNull()
    expect(h.texts()).toHaveLength(0)
  })

  test('X stops every task from the panel', async () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })] })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'char', char: 'X' })
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('Stopped 2 background terminals')
  })
})

describe('BackgroundTerminals.backgroundForeground', () => {
  test('hands foreground shells to the background without killing them', () => {
    // The point of the gesture: reclaim the turn, keep the work. A killed task
    // would lose however far a build or test run had already got.
    const h = harness({ processes: [proc({ status: 'running_foreground' })] })
    h.controller.refresh()
    expect(h.controller.foregroundCount()).toBe(1)

    expect(h.controller.backgroundForeground()).toBe(1)

    expect(h.controller.foregroundCount()).toBe(0)
    // Still live, just no longer waited on, so the footer now counts it.
    expect(h.controller.runningCount()).toBe(1)
  })

  test('reports nothing moved when no shell is in the foreground', () => {
    // Lets the caller fall through to interrupting, so esc is never inert.
    const h = harness({ processes: [proc({ status: 'running' })] })
    expect(h.controller.foregroundCount()).toBe(0)
    expect(h.controller.backgroundForeground()).toBe(0)
  })

  test('a session that disappeared mid-gesture reports nothing moved', () => {
    const h = harness({ processes: [proc({ status: 'running_foreground' })], sessionId: null })
    expect(h.controller.backgroundForeground()).toBe(0)
  })

  test('a failing native call is swallowed rather than surfaced over a keypress', () => {
    const h = harness({
      processes: [proc({ status: 'running_foreground' })],
      backgroundForeground: () => { throw new Error('session vanished') },
    })
    expect(h.controller.backgroundForeground()).toBe(0)
    expect(h.texts()).toHaveLength(0)
  })

  test('foregroundCount ignores finished and already-background tasks', () => {
    const h = harness({
      processes: [
        proc({ task_id: 'a', status: 'running_foreground' }),
        proc({ task_id: 'b', status: 'running' }),
        proc({ task_id: 'c', status: 'completed', exit_code: 0 }),
      ],
    })
    h.controller.refresh()
    expect(h.controller.foregroundCount()).toBe(1)
  })

  test('the message-delivery detach frees the shell through its own entry point', () => {
    // Attribution matters: the model is told the shell moved so a queued message
    // could land, not that the user walked away from the result.
    const h = harness({ processes: [proc({ status: 'running_foreground' })] })
    h.controller.refresh()

    expect(h.controller.backgroundForegroundForMessage()).toBe(1)

    expect(h.messageDetaches()).toBe(1)
    expect(h.controller.foregroundCount()).toBe(0)
    // Still live: typing must not cost the user their build.
    expect(h.controller.runningCount()).toBe(1)
  })

  test('a message with nothing in the foreground detaches nothing', () => {
    // Steering already reaches the model between tool calls, so there is no
    // reason to disturb a task the model backgrounded itself.
    const h = harness({ processes: [proc({ status: 'running' })] })
    h.controller.refresh()
    expect(h.controller.backgroundForegroundForMessage()).toBe(0)
    expect(h.controller.runningCount()).toBe(1)
  })

  test('a message frees a blocking wait, not just a foreground shell', () => {
    // The reported case: `bash` had already detached and a blocking task_output
    // held the turn. Detaching shells alone left the message stuck behind it,
    // which is what made typing look inert.
    const h = harness({
      processes: [proc({ status: 'running' })],
      startingBlockingWaits: 1,
    })
    h.controller.refresh()
    expect(h.controller.foregroundCount()).toBe(0)

    expect(h.controller.reclaimTurnForMessage()).toBe(1)

    expect(h.controller.blockingWaitCount()).toBe(0)
    // Speaking up must never cost the user their build.
    expect(h.controller.runningCount()).toBe(1)
  })

  test('a message covers a shell and a wait together', () => {
    const h = harness({
      processes: [proc({ status: 'running_foreground' })],
      startingBlockingWaits: 1,
    })
    h.controller.refresh()
    expect(h.controller.reclaimTurnForMessage()).toBe(2)
    // Attributed to message delivery, so the model is told why the shell moved.
    expect(h.messageDetaches()).toBe(1)
    expect(h.controller.foregroundCount()).toBe(0)
    expect(h.controller.blockingWaitCount()).toBe(0)
  })

  test('a message with nothing holding the turn frees nothing', () => {
    // Steering already reaches the model between tool calls, so there is
    // nothing to disturb.
    const h = harness({ processes: [proc({ status: 'running' })] })
    h.controller.refresh()
    expect(h.controller.reclaimTurnForMessage()).toBe(0)
    expect(h.controller.runningCount()).toBe(1)
  })
})

describe('BackgroundTerminals.reclaimTurn', () => {
  test('releases a blocking wait even with no foreground shell', () => {
    // The state from the reported screenshot: `bash` had already detached, and a
    // blocking `task_output` call was what held the turn. No shell is in the
    // foreground, so the shell-only check saw nothing and esc fell through to
    // killing the run.
    const h = harness({
      processes: [proc({ status: 'running' })],
      startingBlockingWaits: 1,
    })
    h.controller.refresh()
    expect(h.controller.foregroundCount()).toBe(0)
    expect(h.controller.blockingWaitCount()).toBe(1)
    expect(h.controller.canReclaimTurn()).toBe(true)

    expect(h.controller.reclaimTurn()).toBe(1)

    // The watched task is untouched: only the waiting ended.
    expect(h.controller.blockingWaitCount()).toBe(0)
    expect(h.controller.runningCount()).toBe(1)
  })

  test('covers a foreground shell and a blocking wait in one gesture', () => {
    const h = harness({
      processes: [proc({ status: 'running_foreground' })],
      startingBlockingWaits: 2,
    })
    h.controller.refresh()
    expect(h.controller.reclaimTurn()).toBe(3)
    expect(h.controller.foregroundCount()).toBe(0)
    expect(h.controller.blockingWaitCount()).toBe(0)
  })

  test('reports nothing freed when neither is present', () => {
    // Lets the caller fall through to interrupting, so esc is never inert.
    const h = harness({ processes: [proc({ status: 'running' })] })
    h.controller.refresh()
    expect(h.controller.canReclaimTurn()).toBe(false)
    expect(h.controller.reclaimTurn()).toBe(0)
  })

  test('a failing release still counts the shell that was detached', () => {
    // Partial success must not read as total failure: reporting 0 here would
    // make the caller kill a run whose shell had in fact just been freed.
    const h = harness({
      processes: [proc({ status: 'running_foreground' })],
      releaseBlockingWaits: () => { throw new Error('session vanished') },
    })
    h.controller.refresh()
    expect(h.controller.reclaimTurn()).toBe(1)
    expect(h.texts()).toHaveLength(0)
  })

  test('a vanished session reclaims nothing', () => {
    const h = harness({
      processes: [proc({ status: 'running_foreground' })],
      sessionId: null,
      startingBlockingWaits: 1,
    })
    expect(h.controller.blockingWaitCount()).toBe(0)
    expect(h.controller.reclaimTurn()).toBe(0)
  })

  test('a failing wait probe reads as nothing waiting', () => {
    const h = harness({
      processes: [proc({ status: 'running' })],
      blockingWaits: () => { throw new Error('session vanished') },
    })
    h.controller.refresh()
    expect(h.controller.blockingWaitCount()).toBe(0)
    expect(h.controller.canReclaimTurn()).toBe(false)
  })

  test('a failing wait probe still lets the rest of the poll land', () => {
    // The probe only decides which of two esc gestures is offered. Letting it
    // abandon the poll would freeze the footer and panel over that.
    const h = harness({
      processes: [proc({ status: 'running' })],
      blockingWaits: () => { throw new Error('session vanished') },
    })
    h.controller.refresh()
    expect(h.controller.runningCount()).toBe(1)
  })

  test('the wait count comes from the poll, not a live read per frame', () => {
    // The spinner asks every frame to pick the esc hint; reading across the
    // native boundary that often would be wasteful, so the value is cached.
    const h = harness({
      processes: [proc({ status: 'running' })],
      startingBlockingWaits: 1,
    })
    expect(h.controller.blockingWaitCount()).toBe(0)
    h.controller.refresh()
    expect(h.controller.blockingWaitCount()).toBe(1)
  })

  test('a release clears the cached count without waiting for the next poll', () => {
    // Otherwise a second esc inside the 500ms window reads a stale count, thinks
    // there is still something to release, and does nothing visible.
    const h = harness({
      processes: [proc({ status: 'running' })],
      startingBlockingWaits: 1,
    })
    h.controller.refresh()
    expect(h.controller.reclaimTurn()).toBe(1)

    expect(h.controller.blockingWaitCount()).toBe(0)
    // So the next esc escalates to interrupting instead of silently repeating.
    expect(h.controller.canReclaimTurn()).toBe(false)
  })
})

describe('BackgroundTerminals.guardSessionSwitch', () => {
  test('warns once while work is live, then lets the repeat through', () => {
    const h = harness({ processes: [proc()] })
    expect(h.controller.guardSessionSwitch('/clear')).toBe(true)
    expect(h.texts().join('\n')).toContain('ctrl+t to manage')
    expect(h.controller.guardSessionSwitch('/clear')).toBe(false)
  })

  test('an idle session is never gated', () => {
    const h = harness({ processes: [proc({ status: 'completed', exit_code: 0 })] })
    expect(h.controller.guardSessionSwitch('/clear')).toBe(false)
  })
})

describe('BackgroundTerminals settled notices', () => {
  test('a task finishing while idle is reported in the transcript', () => {
    // The whole point: with no spinner and no turn in flight, the footer count
    // ticking down was the only trace a `make check` had ever finished.
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    expect(h.texts()).toEqual([])

    h.setProcesses([proc({ status: 'completed', exit_code: 0 })])
    h.controller.refresh()
    const notice = h.commits.find(entry => entry.slot === 'settled')
    expect(notice?.text).toBe('  ✓ completed in background · exit 0 · aaaaaaaa  sleep 30')
  })

  test('a failure is named and carries its exit code', () => {
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    h.setProcesses([proc({ status: 'failed', exit_code: 2 })])
    h.controller.refresh()
    expect(h.texts().join('\n')).toContain('✗ failed in background · exit 2')
  })

  test('the notice is emitted once, not on every poll', () => {
    // The poll runs twice a second; repeating the line would bury the session.
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    h.setProcesses([proc({ status: 'completed', exit_code: 0 })])
    h.controller.refresh()
    h.controller.refresh()
    h.controller.refresh()
    expect(h.commits.filter(entry => entry.slot === 'settled')).toHaveLength(1)
  })

  test('a task already settled when first seen is not announced', () => {
    // Otherwise resuming a session would replay outcomes the user has read.
    const h = harness({ processes: [proc({ status: 'completed', exit_code: 0 })] })
    h.controller.refresh()
    h.controller.refresh()
    expect(h.commits.filter(entry => entry.slot === 'settled')).toEqual([])
  })

  test('a panel stop is reported once, by the panel', async () => {
    // stopFromPanel already commits its own line; the poll that observes the
    // same transition must not say it a second time.
    const h = harness({ processes: [proc()] })
    h.controller.togglePanel()
    expect(h.controller.handlePanelKey({ type: 'char', char: 'x' })).toBe(true)
    await h.controller.settled()
    h.controller.refresh()
    expect(h.texts().join('\n')).toContain('Stopped aaaaaaaa')
    expect(h.commits.filter(entry => entry.slot === 'settled')).toEqual([])
  })

  test('a user cancellation is attributed, matching the panel and cards', () => {
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    h.setProcesses([proc({ status: 'killed', stopped_by_user: true })])
    h.controller.refresh()
    expect(h.texts().join('\n')).toContain('was cancelled by the user')
  })

  test('a task that vanishes between polls is not given an invented outcome', () => {
    // The engine reclaims entries. Its last observed state is all we ever saw.
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    h.setProcesses([])
    h.controller.refresh()
    expect(h.commits.filter(entry => entry.slot === 'settled')).toEqual([])
  })
})

describe('BackgroundTerminals wake on completion', () => {
  test('a queued notice while idle opens a turn to deliver it', () => {
    // The point of the whole mechanism: "run the build, then fix what breaks"
    // must survive a build that outlives its own turn.
    const h = harness({ processes: [proc()], pendingNotifications: () => 1 })
    h.controller.refresh()
    expect(h.wakes()).toBe(1)
  })

  test('a task finishing while idle wakes even though nothing is still running', () => {
    // The completion notice is queued after the task leaves the live list.
    // Gating the wake on runningCount would miss that moment entirely.
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
    h.setProcesses([proc({ status: 'completed', exit_code: 0 })])
    const pending = harness({
      processes: [proc({ status: 'completed', exit_code: 0 })],
      pendingNotifications: () => 1,
    })
    pending.controller.refresh()
    expect(pending.wakes()).toBe(1)
  })

  test('nothing queued means no turn', () => {
    const h = harness({ processes: [proc()], pendingNotifications: () => 0 })
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
  })

  test('a run in flight is left to drain the queue itself', () => {
    // The engine hands queued notices to the running turn between calls, so
    // waking here would deliver the same text twice.
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => 1,
      runInFlight: () => true,
    })
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
  })

  test('a queued user message carries the notices instead', () => {
    // It will submit on its own and pick them up, and it outranks a synthetic
    // turn the user did not ask for.
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => 1,
      queuedMessages: () => 1,
    })
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
  })

  test('an open ask is not answered by a synthetic turn', () => {
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => 1,
      overlayBlocking: () => true,
    })
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
  })

  test('no session means nothing to wake', () => {
    const h = harness({
      processes: [proc()],
      sessionId: null,
      pendingNotifications: () => 1,
    })
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
  })

  test('a host without the hook never wakes', () => {
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => 1,
      wake: null,
    })
    expect(() => h.controller.refresh()).not.toThrow()
    expect(h.wakes()).toBe(0)
  })

  test('a failing probe does not wake and does not abandon the poll', () => {
    // Reading it as "something is pending" would open turns in a loop.
    const h = harness({
      processes: [proc({ status: 'completed', exit_code: 0 })],
      pendingNotifications: () => { throw new Error('native boundary') },
    })
    expect(() => h.controller.refresh()).not.toThrow()
    expect(h.wakes()).toBe(0)
  })

  test('the queue draining stops the waking', () => {
    // build_turn consumes the queue, so the next poll sees zero and must not
    // open a second turn for the same batch.
    let pending = 1
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => pending,
      wake: () => { pending = 0 },
    })
    h.controller.refresh()
    h.controller.refresh()
    h.controller.refresh()
    expect(pending).toBe(0)
  })
})

describe('BackgroundTerminals layered stop', () => {
  test('confirmed background stop never expands to a task admitted after the snapshot', async () => {
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    const target = h.controller.stopTarget()
    h.setProcesses([proc(), proc({ task_id: 'new-task' })])
    h.controller.stopAll(target)
    await h.controller.settled()
    expect(h.processes().find(task => task.task_id === 'new-task')?.status).toBe('running')
    expect(h.processes().find(task => task.task_id === 'aaaaaaaa-1111')?.status).toBe('killed')
  })

  test('fresh stop confirmation rejects changed or unreadable task lists without waking', () => {
    let unavailable = false
    let listed = [proc()]
    const h = harness({ onList: () => {
      if (unavailable) throw new Error('unavailable')
      return listed
    }, pendingNotifications: () => 1 })
    h.controller.refresh(false)
    const confirmation = new RunInteraction()
    const input = () => ({ active: false, owner: null, backgroundTasks: h.controller.runningCount(), backgroundOwner: h.controller.stopTarget() })
    expect(confirmation.requestInterrupt(input())).toBe('confirm')
    listed = [proc(), proc({ task_id: 'new-task' })]
    h.controller.refresh(false)
    expect(confirmation.requestInterrupt(input())).toBe('confirm')
    unavailable = true
    h.controller.refresh(false)
    expect(confirmation.requestInterrupt(input())).toBe('unavailable')
    expect(h.controller.stopTarget()).toBeNull()
    expect(h.wakes()).toBe(0)
  })

  test('a timed-out stop still announces its later settlement', async () => {
    const h = harness({ processes: [proc()], stopOne: async () => proc({ stopped_by_user: true }) })
    h.controller.refresh()
    h.controller.stopAll(h.controller.stopTarget())
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('1 still running')
    h.setProcesses([proc({ status: 'killed', stopped_by_user: true })])
    h.controller.refresh()
    expect(h.texts().join('\n')).toContain('was cancelled by the user')
  })

  test('individual failures do not prevent stopping other confirmed tasks', async () => {
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })], stopOne: async id => {
      if (id === 'second') throw new Error('signal refused')
      return proc({ status: 'killed', stopped_by_user: true })
    } })
    h.controller.refresh()
    h.controller.stopAll(h.controller.stopTarget())
    await h.controller.settled()
    expect(h.texts().join('\n')).toContain('signal refused')
    expect(h.texts().join('\n')).toContain('Stopped 1 background terminal · 1 stop requests failed')
    expect(h.texts().join('\n')).not.toContain('No background terminals running')
  })

  test('panel stop and status poll do not announce the same settled task twice', async () => {
    let resolveStop: (task: BackgroundProcess) => void = () => { throw new Error('not started') }
    const h = harness({ processes: [proc()], stopOne: () => new Promise(resolve => { resolveStop = resolve }) })
    h.controller.togglePanel()
    h.controller.handlePanelKey({ type: 'char', char: 'x' })
    const stopped = proc({ status: 'killed', stopped_by_user: true })
    h.setProcesses([stopped])
    h.controller.refresh()
    resolveStop(stopped)
    await h.controller.settled()
    expect(h.texts()).toHaveLength(1)
  })

  test('two Esc stop only the reply; the next pair stops background work without a panel', async () => {
    const h = harness({ processes: [proc()] })
    h.controller.refresh()
    const interaction = new RunInteraction()
    const owner = {}
    let active = true
    let aborts = 0
    const esc = () => {
      const input = { active, owner: active ? owner : null, backgroundTasks: h.controller.runningCount(), backgroundOwner: h.controller.stopTarget() }
      const actions = decideReplControl({
        event: { type: 'escape' }, interaction: interaction.snapshot(input),
        overlay: { kind: 'none' }, editor: createEditorState(), isLoading: active,
        hasStream: active, exitHint: false, logMode: false, hasQueuedPrompt: false,
      })
      for (const action of actions) {
        if (interaction.requestInterrupt(input) !== 'interrupt') continue
        if (action.kind === 'interrupt') {
          aborts++
          active = false
          interaction.clear()
          h.controller.parkUntilBackground()
        } else if (action.kind === 'stop-background') h.controller.stopAll(input.backgroundOwner)
      }
    }
    esc()
    expect(aborts).toBe(0)
    esc()
    expect(aborts).toBe(1)
    expect(h.processes()[0]?.status).toBe('running')
    esc()
    expect(h.processes()[0]?.status).toBe('running')
    esc()
    await h.controller.settled()
    expect(h.processes()[0]?.status).toBe('killed')
    expect(h.panel()).toBeNull()
    expect(h.wakes()).toBe(0)
  })

  test('a natural completion racing stop still wakes a parked model', async () => {
    let pending = 1
    let active = true
    const h = harness({ processes: [proc()], pendingNotifications: () => pending, runInFlight: () => active,
      stopOne: async () => {
        const done = proc({ status: 'completed', exit_code: 0 })
        h.setProcesses([done])
        pending = 2
        return done
      },
    })
    h.controller.togglePanel()
    h.controller.parkUntilBackground()
    active = false
    h.controller.handlePanelKey({ type: 'char', char: 'x' })
    await h.controller.settled()
    expect(h.wakes()).toBe(1)
  })

  test('bulk stop is single-flight and reports unfinished tasks honestly', async () => {
    let resolveStop: (tasks: BackgroundProcess[]) => void = () => { throw new Error('stop not started') }
    let calls = 0
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })], stopAll: () => {
      calls++
      return new Promise(resolve => { resolveStop = resolve })
    } })
    h.controller.refresh()
    h.controller.stopAll()
    h.controller.stopAll()
    expect(calls).toBe(1)
    expect(h.controller.isStopping()).toBe(true)
    resolveStop([proc({ status: 'killed', stopped_by_user: true }), proc({ task_id: 'second' })])
    await h.controller.settled()
    expect(h.controller.isStopping()).toBe(false)
    expect(h.texts().join('\n')).toContain('Stopped 1 background terminal · 1 still running')
  })

  test('late stop results cannot write into a different session', async () => {
    let session = 'one'
    let resolveStop: (tasks: BackgroundProcess[]) => void = () => { throw new Error('stop not started') }
    const h = harness({ sessionId: () => session, processes: [proc()], stopAll: () => new Promise(resolve => { resolveStop = resolve }) })
    h.controller.refresh()
    const target = h.controller.stopTarget()
    h.controller.stopAll()
    session = 'two'
    h.controller.refresh()
    expect(h.controller.stopTarget()).not.toBe(target)
    resolveStop([proc({ status: 'killed', stopped_by_user: true })])
    await h.controller.settled()
    expect(h.texts()).toEqual([])
  })

  test('user cancellation cannot rearm old results, but a natural completion still can', () => {
    let active = true
    const h = harness({ processes: [proc(), proc({ task_id: 'second' })], pendingNotifications: () => 1, runInFlight: () => active })
    h.controller.refresh()
    h.controller.parkUntilBackground()
    active = false
    h.setProcesses([proc({ status: 'killed', stopped_by_user: true }), proc({ task_id: 'second' })])
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
    h.setProcesses([proc({ status: 'killed', stopped_by_user: true }), proc({ task_id: 'second', status: 'completed' })])
    h.controller.refresh()
    expect(h.wakes()).toBe(1)
  })
})

describe('BackgroundTerminals wake arming', () => {
  test('a wake that opens no turn is not retried every poll', () => {
    // A host can decline: a signed-out cloud session returns before starting a
    // run, leaving the queue pending. Retrying twice a second would hammer it.
    let pending = 1
    let attempts = 0
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => pending,
      wake: () => { attempts++ },
    })
    h.controller.refresh()
    h.controller.refresh()
    h.controller.refresh()
    expect(attempts).toBe(1)
    expect(pending).toBe(1)
  })

  test('a drained queue re-arms the next batch', () => {
    // One refusal must not disable waking for the rest of the session.
    let pending = 1
    let attempts = 0
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => pending,
      wake: () => { attempts++; pending = 0 },
    })
    h.controller.refresh()
    expect(attempts).toBe(1)
    // The turn took delivery, so the next poll observes an empty queue.
    h.controller.refresh()
    // A later task finishes.
    pending = 1
    h.controller.refresh()
    expect(attempts).toBe(2)
  })

  test('parking skips leftover notices until live work finishes', () => {
    // Esc ends the current turn. Notices already queued from earlier work
    // must not open a model turn immediately; the still-running task's later
    // completion is the natural wake.
    let pending = 1
    let busy = true
    const h = harness({
      processes: [proc()],
      pendingNotifications: () => pending,
      runInFlight: () => busy,
    })
    h.controller.refresh()
    h.controller.parkUntilBackground()
    busy = false
    h.controller.refresh()
    expect(h.wakes()).toBe(0)
    // The old notice never drains. A later completion must still wake once.
    pending = 2
    h.setProcesses([proc({ status: 'completed', exit_code: 0 })])
    h.controller.refresh()
    h.controller.refresh()
    expect(h.wakes()).toBe(1)
  })
})
