import { expect, test } from 'bun:test'
import { RunInteraction, resolveRunInteraction, type RunInteractionInput } from '../../../src/term/app/run/run-interaction.js'
import { runStatusPresentation } from '../../../src/term/viewmodel/run-status.js'
import { decideReplControl } from '../../../src/term/app/composer/repl-control.js'
import { createEditorState } from '../../../src/term/input/editor.js'

const owner = {}
const cases: Array<[RunInteractionInput, string, boolean, boolean]> = [
  [{ active: false, owner: null }, 'idle', false, false],
  [{ active: false, owner: null, backgroundTasks: 1 }, 'waiting-background', false, false],
  [{ active: true, owner }, 'active', true, true],
  [{ active: true, owner, foregroundTasks: 1 }, 'active', true, true],
  [{ active: true, owner, blockingWaits: 1 }, 'waiting-task', true, false],
  [{ active: true, owner, phase: 'retrying' }, 'retrying', true, false],
  [{ active: true, owner, localOperation: true }, 'local-operation', false, false],
  [{ active: true, owner, compacting: true }, 'compacting', true, false],
  [{ active: true, owner: null }, 'active', false, true],
]

test('status hints and key routing share the same capabilities for every state', () => {
  for (const [input, kind, interruptible, usage] of cases) {
    const interaction = resolveRunInteraction(input)
    const status = runStatusPresentation(interaction)
    expect(interaction.kind).toBe(kind)
    expect(status.showUsage).toBe(usage)
    expect(status.hint.includes('esc twice')).toBe((interruptible || interaction.interruptTarget === 'background') && interaction.backgroundAction === null)
    expect(status.hint.includes('to background') || status.hint.includes('to release wait')).toBe(interaction.backgroundAction !== null)
    const route = (event: { type: 'escape' } | { type: 'ctrl'; key: string }) => decideReplControl({
      event, interaction, overlay: { kind: 'none' }, editor: createEditorState(),
      isLoading: input.active, hasStream: Boolean(input.owner), exitHint: false,
      logMode: false, hasQueuedPrompt: false,
    }).map(action => action.kind)
    expect(route({ type: 'escape' }).includes('interrupt')).toBe(interruptible)
    expect(route({ type: 'escape' }).includes('stop-background')).toBe(interaction.interruptTarget === 'background')
    expect(route({ type: 'ctrl', key: 'b' }).includes('reclaim-turn')).toBe(interaction.backgroundAction !== null)
  }
})

test('two Esc presses belong to one operation and expire after five seconds', () => {
  let now = 0
  const controller = new RunInteraction(() => now)
  const run = { active: true, owner, blockingWaits: 1 }
  expect(controller.requestInterrupt(run)).toBe('confirm')
  expect(runStatusPresentation(controller.snapshot(run)).hint).toBe(' · esc again to interrupt')
  expect(controller.requestInterrupt(run)).toBe('interrupt')
  expect(controller.snapshot(run).interruptPending).toBe(false)
  expect(controller.requestInterrupt(run)).toBe('confirm')
  now = 5000
  expect(controller.requestInterrupt(run)).toBe('confirm')
  expect(controller.requestInterrupt({ ...run, owner: {} })).toBe('confirm')
  controller.clear()
  expect(controller.snapshot(run).interruptPending).toBe(false)
  expect(controller.requestInterrupt({ active: false, owner: null, backgroundTasks: 1 })).toBe('unavailable')
})

test('confirmation temporarily replaces the primary hint and expiry restores it', () => {
  let now = 0
  const controller = new RunInteraction(() => now)
  for (const run of [
    { active: true, owner, foregroundTasks: 1 },
    { active: true, owner, blockingWaits: 1 },
  ]) {
    controller.clear()
    const normal = runStatusPresentation(controller.snapshot(run)).hint
    expect(normal).not.toContain('esc')
    expect(controller.requestInterrupt(run)).toBe('confirm')
    expect(runStatusPresentation(controller.snapshot(run)).hint).toBe(' · esc again to interrupt')
    now += 5000
    expect(runStatusPresentation(controller.snapshot(run)).hint).toBe(normal)
  }
})

test('background confirmations are scoped separately from replies, sessions and live tasks', () => {
  let now = 0
  const controller = new RunInteraction(() => now)
  const run = { active: true, owner, backgroundTasks: 2, backgroundOwner: 'session:a,b' }
  const idle = { ...run, active: false, owner: null }
  expect(controller.requestInterrupt(run)).toBe('confirm')
  expect(controller.requestInterrupt(run)).toBe('interrupt')
  expect(controller.requestInterrupt(idle)).toBe('confirm')
  expect(runStatusPresentation(controller.snapshot(idle)).hint).toBe(' · esc again to stop all 2 background tasks')
  expect(controller.requestInterrupt(idle)).toBe('interrupt')

  expect(controller.requestInterrupt(idle)).toBe('confirm')
  now += 5000
  expect(controller.snapshot(idle).interruptPending).toBe(false)
  expect(controller.requestInterrupt(idle)).toBe('confirm')
  expect(controller.requestInterrupt({ ...idle, backgroundOwner: 'other-session:a,b' })).toBe('confirm')
  expect(controller.requestInterrupt({ ...idle, backgroundOwner: 'other-session:a,c' })).toBe('confirm')
  expect(controller.requestInterrupt({ ...idle, backgroundStopping: true })).toBe('unavailable')
  expect(controller.requestInterrupt(idle)).toBe('confirm')
  expect(controller.requestInterrupt({ ...run, owner: {} })).toBe('confirm')
  expect(controller.requestInterrupt(idle)).toBe('confirm')
})

test('idle background stop preserves drafts and respects modal and completion priority', () => {
  const input = {
    interaction: resolveRunInteraction({ active: false, owner: null, backgroundTasks: 2 }),
    event: { type: 'escape' as const }, overlay: { kind: 'none' as const },
    editor: { ...createEditorState(), lines: ['keep this draft'] },
    isLoading: false, hasStream: false, exitHint: false, logMode: false, hasQueuedPrompt: false,
  }
  expect(decideReplControl(input)).toEqual([{ kind: 'stop-background' }])
  expect(input.editor.lines).toEqual(['keep this draft'])
  expect(decideReplControl({ ...input, overlay: { kind: 'help' } })).toEqual([{ kind: 'close-overlay' }])
  expect(decideReplControl({ ...input, interaction: resolveRunInteraction({ active: false, owner: null, backgroundTasks: 2, backgroundStopping: true }) })).toEqual([])
})

test('overlays dismiss first, then Esc pulls back a pending message, then it interrupts', () => {
  const input = {
    interaction: resolveRunInteraction({ active: true, owner, blockingWaits: 1 }),
    event: { type: 'escape' as const }, overlay: { kind: 'none' as const },
    editor: createEditorState(), isLoading: true, hasStream: true,
    exitHint: false, logMode: false, hasQueuedPrompt: true,
  }
  expect(decideReplControl(input)).toEqual([{ kind: 'restore-queued' }])
  expect(decideReplControl({ ...input, hasQueuedPrompt: false })).toEqual([{ kind: 'interrupt' }])
  expect(decideReplControl({ ...input, overlay: { kind: 'help' } })).toEqual([{ kind: 'close-overlay' }])
})

test('a parked loop takes two Esc presses, scoped to that loop', () => {
  let now = 0
  const controller = new RunInteraction(() => now)
  const parked = { active: false, owner: null, loopParked: true, loopOwner: 1000 }
  const state = resolveRunInteraction(parked)
  expect(state.kind).toBe('waiting-loop')
  expect(state.interruptTarget).toBe('loop')
  expect(runStatusPresentation(state).hint).toBe(' · esc twice to stop the loop')

  // First press arms, second confirms; the hint tracks the window.
  expect(controller.requestInterrupt(parked)).toBe('confirm')
  expect(runStatusPresentation(controller.snapshot(parked)).hint).toBe(' · esc again to stop the loop')
  expect(controller.requestInterrupt(parked)).toBe('interrupt')
  expect(controller.snapshot(parked).interruptPending).toBe(false)

  // The window expires like every other interrupt.
  expect(controller.requestInterrupt(parked)).toBe('confirm')
  now += 5000
  expect(controller.requestInterrupt(parked)).toBe('confirm')

  // A restarted loop is a new owner: no inherited confirmation.
  expect(controller.requestInterrupt({ ...parked, loopOwner: 2000 })).toBe('confirm')

  // A turn the user types while parked moves Esc to that run; coming back
  // to the parked loop starts over.
  expect(controller.requestInterrupt({ active: true, owner, loopParked: false, loopOwner: 1000 })).toBe('confirm')
  expect(controller.requestInterrupt(parked)).toBe('confirm')
})

test('parked loop Esc routes to stop-loop and outranks background stop, below overlays and completions', () => {
  const interaction = resolveRunInteraction({ active: false, owner: null, loopParked: true, loopOwner: 1, backgroundTasks: 2 })
  const input = {
    interaction, event: { type: 'escape' as const }, overlay: { kind: 'none' as const },
    editor: { ...createEditorState(), lines: ['keep this draft'] },
    isLoading: false, hasStream: false, exitHint: false, logMode: false, hasQueuedPrompt: false,
  }
  expect(decideReplControl(input)).toEqual([{ kind: 'stop-loop' }])
  expect(input.editor.lines).toEqual(['keep this draft'])
  expect(decideReplControl({ ...input, overlay: { kind: 'help' } })).toEqual([{ kind: 'close-overlay' }])
  const completion = { items: [{ label: '/help', value: '/help ', description: '' }], selectedIndex: 0, replaceStart: 0, replaceEnd: 2 }
  expect(decideReplControl({ ...input, editor: { ...input.editor, completion } })).toEqual([{ kind: 'close-completion' }])
  // Ctrl+C keeps its own meaning while parked.
  expect(decideReplControl({ ...input, event: { type: 'ctrl', key: 'c' } })).toEqual([{ kind: 'clear-editor' }])
})
