import { describe, expect, test } from 'bun:test'
import { decideReplControl } from '../../../src/term/app/composer/repl-control.js'
import { acceptCompletion, createEditorState, getEditorText, insertText, showCompletions } from '../../../src/term/input/editor.js'
import { createSelectorState } from '../../../src/ui/selector.js'

const editor = createEditorState()
const textEditor = insertText(createEditorState(), 'hello')
const completionEditor = {
  ...editor,
  completion: {
    items: [{ label: '/help', value: '/help ', description: 'Show help' }],
    selectedIndex: 0,
    replaceStart: 0,
    replaceEnd: 2,
  },
}
const none = { kind: 'none' as const }
const help = { kind: 'help' as const }
const selector = { kind: 'selector' as const, state: createSelectorState('T', [{ label: 'one' }]) }
const selectorWithQuery = { kind: 'selector' as const, state: createSelectorState('T', [{ label: 'one' }], undefined, 'o') }
const askUser = { kind: 'ask-user' as const, state: { questions: [], currentIndex: 0, answers: {} } as any }

const kinds = (input: Parameters<typeof decideReplControl>[0]) => decideReplControl(input).map(a => a.kind)
const base = { overlay: none, isLoading: false, hasStream: false, editor, exitHint: false, logMode: false, hasQueuedPrompt: false }

describe('repl control', () => {
  test('ctrl-c never interrupts a loading stream; esc owns interrupt', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' }, isLoading: true, hasStream: true })).toEqual(['show-exit-hint'])
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' }, isLoading: true, hasStream: true, editor: textEditor })).toEqual(['clear-editor'])
  })

  test('escape cancels manual compaction without requiring a query stream', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, isLoading: true, isCompacting: true })).toEqual(['interrupt'])
  })

  test('compaction escape respects modal and completion priority', () => {
    const compacting = { ...base, event: { type: 'escape' as const }, isLoading: true, isCompacting: true }
    // A visible layer must consume Esc before confirmation. Otherwise the
    // host clears confirmation for that layer on every keypress, indefinitely.
    expect(kinds({ ...compacting, overlay: help })).toEqual(['close-overlay'])
    expect(kinds({ ...compacting, overlay: selectorWithQuery })).toEqual(['clear-selector-query'])
    expect(kinds({ ...compacting, editor: completionEditor })).toEqual(['close-completion'])
    expect(kinds(compacting)).toEqual(['interrupt'])
  })

  test('ctrl-c during manual compaction follows the normal exit path', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' }, isLoading: true, isCompacting: true })).toEqual(['show-exit-hint'])
  })

  test('ctrl-c shows exit hint on empty editor', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' } })).toEqual(['show-exit-hint'])
  })

  test('ctrl-c exits when exit hint is already visible', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' }, exitHint: true })).toEqual(['exit'])
  })

  test('ctrl-c clears non-empty editor', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' }, editor: textEditor })).toEqual(['clear-editor'])
  })

  test('non ctrl-c clears exit hint then continues', () => {
    expect(kinds({ ...base, event: { type: 'char', char: 'x' }, exitHint: true })).toEqual(['clear-exit-hint', 'normal-key'])
  })

  test('escape cancels ask overlay with stream', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, overlay: askUser, hasStream: true })).toEqual(['cancel-ask'])
  })

  test('ctrl-c during an ask overlay cancels the ask like escape does', () => {
    // Regression guard: the pending ask promise must be resolved by whichever
    // key dismisses it, or the suspended host-tool dispatch hangs the loop.
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'c' }, overlay: askUser, isLoading: true, hasStream: true })).toEqual(['cancel-ask'])
  })

  test('escape clears selector query before closing overlay', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, overlay: selectorWithQuery })).toEqual(['clear-selector-query'])
  })

  test('escape closes overlay without query', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, overlay: selector })).toEqual(['close-overlay'])
  })

  test('escape closes completion before clearing input', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, editor: completionEditor })).toEqual(['close-completion'])
  })

  test('escape pulls back the newest pending prompt before it may interrupt', () => {
    const running = { ...base, event: { type: 'escape' as const }, isLoading: true, hasStream: true }
    expect(kinds({ ...running, hasQueuedPrompt: true })).toEqual(['restore-queued'])
    expect(kinds(running)).toEqual(['interrupt'])
    // A draft during a run never turns Esc into an interrupt while prompts
    // are pending: the pull-back action explains itself instead.
    const draft = insertText(createEditorState(), 'draft')
    expect(kinds({ ...running, hasQueuedPrompt: true, editor: draft })).toEqual(['restore-queued'])
    expect(kinds({ ...running, editor: draft })).toEqual(['interrupt'])
    // Idle (paused backlog): the same rule; a draft is cleared first.
    const idle = { ...base, event: { type: 'escape' as const }, hasQueuedPrompt: true }
    expect(kinds(idle)).toEqual(['restore-queued'])
    expect(kinds({ ...idle, editor: draft })).toEqual(['clear-editor'])
    expect(kinds({ ...base, event: { type: 'escape' } })).toEqual([])
  })

  test('escape interrupts loading stream without queued prompts', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, isLoading: true, hasStream: true })).toEqual(['interrupt'])
  })

  test('escape always interrupts, even with work that could be backgrounded', () => {
    // The two gestures are kept separate on purpose: esc means kill regardless
    // of state, so its outcome never depends on something the user cannot see.
    // Backgrounding lives on ctrl+b.
    expect(kinds({
      ...base,
      event: { type: 'escape' },
      isLoading: true,
      hasStream: true,
      canReclaimTurn: true,
    })).toEqual(['interrupt'])
  })

  test('ctrl-b backgrounds the running work instead of killing it', () => {
    expect(kinds({
      ...base,
      event: { type: 'ctrl', key: 'b' },
      isLoading: true,
      hasStream: true,
      canReclaimTurn: true,
    })).toEqual(['reclaim-turn'])
  })

  test('ctrl-b falls through to the editor when there is nothing to background', () => {
    // It must never become a second interrupt: this key is non-destructive by
    // contract, so with nothing running it is just an ordinary keypress.
    expect(kinds({
      ...base,
      event: { type: 'ctrl', key: 'b' },
      isLoading: true,
      hasStream: true,
      canReclaimTurn: false,
    })).toEqual(['normal-key'])
  })

  test('ctrl-b is inert while idle', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'b' } })).toEqual(['normal-key'])
  })

  test('a pending prompt is pulled back before Esc interrupts, backgroundable work or not', () => {
    const running = { ...base, event: { type: 'escape' as const }, isLoading: true, hasStream: true, canReclaimTurn: true }
    expect(kinds({ ...running, hasQueuedPrompt: true })).toEqual(['restore-queued'])
    expect(kinds(running)).toEqual(['interrupt'])
  })

  test('ctrl-c does not become a stop gesture while work is backgroundable', () => {
    // Esc stops, ctrl+b detaches, ctrl+c stays out of the run entirely.
    expect(kinds({
      ...base,
      event: { type: 'ctrl', key: 'c' },
      isLoading: true,
      hasStream: true,
      canReclaimTurn: true,
    })).toEqual(['show-exit-hint'])
  })

  test('compaction escape interrupts regardless of waited-on work', () => {
    expect(kinds({
      ...base,
      event: { type: 'escape' },
      isLoading: true,
      isCompacting: true,
      canReclaimTurn: true,
    })).toEqual(['interrupt'])
  })

  test('escape clears editor before exiting log mode', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, editor: textEditor, logMode: true })).toEqual(['clear-editor'])
  })

  test('escape exits log mode when editor is empty', () => {
    expect(kinds({ ...base, event: { type: 'escape' }, logMode: true })).toEqual(['exit-log-mode'])
  })

  test('help overlay closes on any key', () => {
    expect(kinds({ ...base, event: { type: 'char', char: 'x' }, overlay: help })).toEqual(['close-overlay'])
  })

  test('selector overlay delegates key', () => {
    expect(kinds({ ...base, event: { type: 'down' }, overlay: selector })).toEqual(['selector-key'])
  })

  test('down reaches the editor while loading, so ↓ can open the task panel', () => {
    // Shells usually run mid-turn. If loading swallowed ↓ the way it swallows
    // typed characters, the gesture the prompt advertises would never fire.
    expect(kinds({ ...base, event: { type: 'down' }, isLoading: true, hasStream: true }))
      .toEqual(['normal-key'])
  })

  test('ask overlay delegates key', () => {
    expect(kinds({ ...base, event: { type: 'char', char: 'y' }, overlay: askUser })).toEqual(['ask-key'])
  })

  test('completion confirmation and navigation outrank submission both idle and loading', () => {
    for (const isLoading of [false, true]) {
      for (const type of ['enter', 'tab', 'up', 'down'] as const) {
        expect(kinds({ ...base, isLoading, hasStream: isLoading, editor: completionEditor, event: { type } }))
          .toEqual(['normal-key'])
      }
    }
  })

  test('enter selects a relative path during a run; only the next enter submits', () => {
    const draft = 'favicon icon要是 ../evot'
    const pathEditor = showCompletions(insertText(createEditorState(), draft), [
      { label: '../evot-site/', value: '../evot-site/' },
      { label: '../evot/', value: '../evot/' },
    ], draft.indexOf('../'))
    const input = { ...base, isLoading: true, hasStream: true, event: { type: 'enter' as const }, editor: pathEditor }
    expect(kinds(input)).toEqual(['normal-key'])
    const accepted = acceptCompletion(pathEditor)
    expect(getEditorText(accepted)).toBe('favicon icon要是 ../evot-site/')
    expect(accepted.completion).toBeNull()
    expect(kinds({ ...input, editor: accepted })).toEqual(['loading-enter'])
  })

  test('empty completion notice does not swallow enter during a run', () => {
    const editor = showCompletions(textEditor, [], 0, 5, 'No matches')
    expect(kinds({ ...base, editor, isLoading: true, event: { type: 'enter' } })).toEqual(['loading-enter'])
  })

  test('overlays retain priority over an editor completion', () => {
    for (const isLoading of [false, true]) {
      for (const [overlay, action] of [[help, 'close-overlay'], [selector, 'selector-key'], [askUser, 'ask-key']] as const) {
        expect(kinds({ ...base, overlay, isLoading, editor: completionEditor, event: { type: 'enter' } }))
          .toEqual([action])
      }
    }
  })

  test('loading enter/char/paste have loading actions', () => {
    expect(kinds({ ...base, event: { type: 'enter' }, isLoading: true })).toEqual(['loading-enter'])
    expect(kinds({ ...base, event: { type: 'char', char: 'x' }, isLoading: true })).toEqual(['loading-char'])
    expect(kinds({ ...base, event: { type: 'paste', text: 'x' }, isLoading: true })).toEqual(['loading-paste'])
  })

  test('ctrl-o toggles expanded view while loading', () => {
    expect(kinds({ ...base, event: { type: 'ctrl', key: 'o' }, isLoading: true })).toEqual(['toggle-expanded'])
  })

  test('loading movement falls through to normal key', () => {
    expect(kinds({ ...base, event: { type: 'left' }, isLoading: true })).toEqual(['normal-key'])
  })
})
