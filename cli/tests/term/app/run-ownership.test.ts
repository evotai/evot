import { describe, expect, test } from 'bun:test'
import { RunOwnership } from '../../../src/term/app/run/run-ownership.js'
import { RunInteraction } from '../../../src/term/app/run/run-interaction.js'
import { decideReplControl } from '../../../src/term/app/composer/repl-control.js'
import { createEditorState } from '../../../src/term/input/editor.js'
import { TerminalInputBuffer } from '../../../src/term/input/buffer.js'
import type { SpinnerPhase } from '../../../src/term/widgets/spinner.js'
import { LoopSession } from '../../../src/features/loop/session.js'

describe('RunOwnership', () => {
  test('Esc owns setup and retains confirmation across streaming/retry phases', () => {
    const ownership = new RunOwnership()
    const generation = ownership.begin()
    const controller = new RunInteraction()
    const keyboard = new TerminalInputBuffer()
    const phases: SpinnerPhase[] = ['thinking', 'retrying', 'quota_waiting', 'outage_waiting', 'executing']
    for (const phase of phases) {
      controller.clear()
      const input = { active: true, owner: ownership.owner, phase }
      keyboard.write('\x1b')
      const [event] = keyboard.flushPending()
      if (!event) throw new Error('Escape was not decoded')
      expect(decideReplControl({
        event, interaction: controller.snapshot(input), overlay: { kind: 'none' },
        isLoading: true, hasStream: false, editor: createEditorState(),
        exitHint: false, logMode: false, hasQueuedPrompt: false,
      })).toEqual([{ kind: 'interrupt' }])
      expect(controller.requestInterrupt(input)).toBe('confirm')
      // The native query resolves between presses. Its stream identity must
      // not replace the operation identity or reset confirmation.
      expect(controller.requestInterrupt({ ...input, phase: 'responding' })).toBe('interrupt')
    }
    ownership.revoke()
    expect(ownership.owns(generation)).toBe(false)
    // A late query result must be aborted, never installed into a newer run.
    const replacement = ownership.begin()
    expect(ownership.owner).toBe(replacement)
    expect(ownership.owns(generation)).toBe(false)
  })

  test('terminal sequences cannot interrupt a loop; a genuine turn interrupt preserves it', () => {
    const loop = new LoopSession({
      runTurn: () => {}, canWake: () => true, notify: () => {}, requestRender: () => {},
    })
    const ownership = new RunOwnership()
    const controller = new RunInteraction()
    const keyboard = new TerminalInputBuffer()
    const generation = ownership.begin()
    let active = true
    loop.handleCommand('/loop watch PR', 'watch PR')
    const handle = (event: Parameters<typeof decideReplControl>[0]['event']) => {
      const input = {
        active, owner: active ? ownership.owner : null,
        loopParked: loop.waiting && !loop.runInFlight, loopOwner: loop.snapshot?.startedAt,
      }
      for (const action of decideReplControl({
        event, interaction: controller.snapshot(input), overlay: { kind: 'none' },
        isLoading: input.active, hasStream: input.active, editor: createEditorState(),
        exitHint: false, logMode: false, hasQueuedPrompt: false,
      })) {
        if (action.kind === 'interrupt' && controller.requestInterrupt(input) === 'interrupt') {
          ownership.revoke()
          active = false
          loop.endRun('interrupted')
        }
        if (action.kind === 'stop-loop' && controller.requestInterrupt(input) === 'interrupt') loop.cancelWait()
      }
    }
    const pressEsc = () => {
      keyboard.write('\x1b')
      for (const event of keyboard.flushPending()) handle(event)
    }
    const noise = '\x1bOP\x1bOQ\x1bx\x1b[15~\x1b[I\x1b[O\x1b[27;1:2u\x1b[27;1:3u'
    try {
      pressEsc() // a real first press must not be confirmed by terminal noise
      for (const event of keyboard.write(noise)) handle(event)
      expect(ownership.owns(generation)).toBe(true)
      expect(loop.runInFlight).toBe(true)
      expect(loop.active).toBe(true)
      pressEsc()
      expect(ownership.owns(generation)).toBe(false)
      expect(loop.runInFlight).toBe(false)
      expect(loop.active).toBe(true)
      expect(loop.extension).toBeDefined()
      expect(loop.waiting).toBe(true)
      pressEsc()
      for (const event of keyboard.write(noise)) handle(event)
      expect(loop.active).toBe(true)
      pressEsc() // explicit double Esc while parked still stops the loop
      expect(loop.active).toBe(false)
    } finally {
      loop.dispose()
    }
  })

  test('revokes an interrupted run before a replacement starts', () => {
    const ownership = new RunOwnership()
    const interrupted = ownership.begin()

    ownership.revoke()
    const replacement = ownership.begin()

    expect(ownership.owns(interrupted)).toBe(false)
    expect(ownership.owns(replacement)).toBe(true)
  })

  test('starting a new run prevents an older finally block from owning state', () => {
    const ownership = new RunOwnership()
    const first = ownership.begin()
    const second = ownership.begin()

    expect(ownership.owns(first)).toBe(false)
    expect(ownership.owns(second)).toBe(true)
  })
})
