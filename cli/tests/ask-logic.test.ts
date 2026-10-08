import { describe, test, expect, beforeAll } from 'bun:test'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import {
  createAskState,
  askUp,
  askDown,
  askNextTab,
  askPrevTab,
  askTypeChar,
  askBackspace,
  askClearOther,
  askSelect,
  askCursorLeft,
  askCursorRight,
  askCursorHome,
  askCursorEnd,
  askDelete,
  askPasteText,
  handleAskKeyEvent,
} from '../src/term/ask.js'
import { askStateToResponse, prefixedAskLines } from '../src/term/app/ask-user.js'
import { buildOverlayBlocks } from '../src/term/viewmodel/overlays.js'
import { buildAskRegionLines } from '../src/term/viewmodel/ask.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import stripAnsi from 'strip-ansi'
import chalk from 'chalk'

beforeAll(() => { chalk.level = 3 })

const singleQuestion = [
  {
    header: 'Language',
    question: 'Which language?',
    options: [
      { label: 'Rust', description: 'Systems programming' },
      { label: 'TypeScript', description: 'Web development' },
    ],
  },
]

test('host setup prompts keep transient ownership through navigation and submission', () => {
  const initial = { ...createAskState(singleQuestion), transient: true }
  const moved = handleAskKeyEvent(initial, 'down')
  expect(moved.action).toBe('update')
  if (moved.action !== 'update') throw new Error('expected updated state')
  expect(moved.state.transient).toBe(true)
  const submitted = handleAskKeyEvent(moved.state, 'enter')
  expect(submitted.action).toBe('submit')
  if (submitted.action !== 'submit') throw new Error('expected submitted state')
  expect(submitted.state.transient).toBe(true)
  expect(createAskState(singleQuestion).transient).toBeUndefined()
})

const multiQuestion = [
  {
    header: 'Language',
    question: 'Which language?',
    options: [
      { label: 'Rust', description: 'Systems programming' },
      { label: 'TypeScript', description: 'Web development' },
    ],
  },
  {
    header: 'Style',
    question: 'Which style?',
    options: [
      { label: 'Functional' },
      { label: 'Imperative' },
      { label: 'Mixed' },
    ],
  },
]

function renderAskVM(state: ReturnType<typeof createAskState>): string {
  const lines = blocksToLines(buildOverlayBlocks({ kind: 'ask-user', state }, 80))
  return lines.map(l => stripAnsi(l).replaceAll(CURSOR_MARKER, '')).join('\n')
}

describe('question text', () => {
  test('a pre-painted line (a diff) passes through instead of being re-bolded', () => {
    const painted = '\x1b[31m-old\x1b[39m'
    const state = createAskState([{ header: 'Task', question: `Apply?\n${painted}`, options: [{ label: 'Confirm' }] }])
    const raw = blocksToLines(buildOverlayBlocks({ kind: 'ask-user', state }, 80)).join('\n')
    expect(raw).toContain(painted)
    // The plain first line is still bold; the painted one is not wrapped in bold.
    expect(raw).toMatch(/\x1b\[1m[^\n]*Apply\?/)
    expect(raw).not.toMatch(/\x1b\[1m[^\n]*-old/)
  })
})

describe('createAskState', () => {
  test('creates initial state', () => {
    const state = createAskState(singleQuestion)
    expect(state.currentTab).toBe(0)
    expect(state.focusIndex).toBe(0)
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.inOtherMode).toBe(false)
    expect(ui0.otherText).toBe('')
    expect(state.submitted).toBe(false)
    expect(state.answers).toHaveLength(1)
  })

  test('multi-question creates answers for each', () => {
    const state = createAskState(multiQuestion)
    expect(state.answers).toHaveLength(2)
  })
})

describe('askUp / askDown', () => {
  test('down moves focus', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    expect(state.focusIndex).toBe(1)
  })

  test('down past last option enters other mode', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.inOtherMode).toBe(true)
    expect(state.focusIndex).toBe(2)
  })

  test('up from other mode goes to last option', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askUp(state)
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.inOtherMode).toBe(false)
    expect(state.focusIndex).toBe(1)
  })

  test('up at top does nothing', () => {
    const state = createAskState(singleQuestion)
    const next = askUp(state)
    expect(next.focusIndex).toBe(0)
    expect(next).toBe(state)
  })
})

describe('askNextTab / askPrevTab', () => {
  test('next tab advances', () => {
    let state = createAskState(multiQuestion)
    state = askNextTab(state)
    expect(state.currentTab).toBe(1)
    expect(state.focusIndex).toBe(0)
  })

  test('next tab at last opens submit review', () => {
    let state = createAskState(multiQuestion)
    state = askNextTab(state)
    const next = askNextTab(state)
    expect(next.currentTab).toBe(1)
    expect(next.onSubmitTab).toBe(true)
    expect(next.submitFocus).toBe(0)
  })

  test('right arrow at last question opens submit review', () => {
    let state = createAskState(multiQuestion)
    state = askNextTab(state)
    const result = handleAskKeyEvent(state, 'right')
    expect(result.action).toBe('update')
    if (result.action !== 'update') return
    expect(result.state.currentTab).toBe(1)
    expect(result.state.onSubmitTab).toBe(true)
  })

  test('prev tab goes back', () => {
    let state = createAskState(multiQuestion)
    state = askNextTab(state)
    state = askPrevTab(state)
    expect(state.currentTab).toBe(0)
  })

  test('prev tab at first does nothing', () => {
    const state = createAskState(multiQuestion)
    const next = askPrevTab(state)
    expect(next.currentTab).toBe(0)
    expect(next).toBe(state)
  })
})

describe('askTypeChar / askBackspace / askClearOther', () => {
  test('typing in other mode appends text', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'h')
    state = askTypeChar(state, 'i')
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.otherText).toBe('hi')
  })

  test('typing outside other mode does nothing', () => {
    let state = createAskState(singleQuestion)
    state = askTypeChar(state, 'x')
    const ui0a = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0a.otherText).toBe('')
  })

  test('backspace removes last char', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'b')
    state = askBackspace(state)
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.otherText).toBe('a')
  })

  test('clearOther empties text', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'x')
    state = askTypeChar(state, 'y')
    state = askClearOther(state)
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.otherText).toBe('')
  })
})

describe('askSelect', () => {
  test('single question: selecting option auto-submits', () => {
    const state = createAskState(singleQuestion)
    const { state: next, done } = askSelect(state)
    expect(done).toBe(true)
    expect(next.submitted).toBe(true)
    expect(next.answers[0]!.selectedOption).toBe(0)
    expect(next.answers[0]!.customText).toBeNull()
  })

  test('single question: down + select picks second option', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    const { state: next, done } = askSelect(state)
    expect(done).toBe(true)
    expect(next.answers[0]!.selectedOption).toBe(1)
  })

  test('single question: other text submits custom', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 't')
    state = askTypeChar(state, 'e')
    state = askTypeChar(state, 's')
    state = askTypeChar(state, 't')
    const { state: next, done } = askSelect(state)
    expect(done).toBe(true)
    expect(next.answers[0]!.selectedOption).toBeNull()
    expect(next.answers[0]!.customText).toBe('test')
  })

  test('single question: empty other text does not submit', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    const { state: next, done } = askSelect(state)
    expect(done).toBe(false)
    expect(next.submitted).toBe(false)
  })

  test('multi question: first select advances to next tab', () => {
    const state = createAskState(multiQuestion)
    const { state: next, done } = askSelect(state)
    expect(done).toBe(false)
    expect(next.currentTab).toBe(1)
    expect(next.answers[0]!.selectedOption).toBe(0)
  })

  test('multi question: answering all enters submit review', () => {
    let state = createAskState(multiQuestion)
    let result = askSelect(state)
    state = result.state
    result = askSelect(state)
    // Should enter submit review page, not auto-submit
    expect(result.done).toBe(false)
    expect(result.state.onSubmitTab).toBe(true)
    expect(result.state.answers[0]!.selectedOption).toBe(0)
    expect(result.state.answers[1]!.selectedOption).toBe(0)
  })

  test('submit review: enter on submit confirms', () => {
    let state = createAskState(multiQuestion)
    let result = askSelect(state)
    state = result.state
    result = askSelect(state)
    state = result.state
    // On submit tab, press enter with submitFocus=0
    const keyResult = handleAskKeyEvent(state, 'enter')
    expect(keyResult.action).toBe('submit')
    expect(keyResult.state.submitted).toBe(true)
  })

  test('submit review: enter on cancel cancels', () => {
    let state = createAskState(multiQuestion)
    let result = askSelect(state)
    state = result.state
    result = askSelect(state)
    state = result.state
    // Switch to cancel option
    state = { ...state, submitFocus: 1 }
    const keyResult = handleAskKeyEvent(state, 'enter')
    expect(keyResult.action).toBe('cancel')
  })

  test('j/k and ctrl+n/p navigate options', () => {
    let state = createAskState(singleQuestion)
    state = handleAskKeyEvent(state, 'char', 'j').state
    expect(state.focusIndex).toBe(1)
    state = handleAskKeyEvent(state, 'ctrl+p', 'p').state
    expect(state.focusIndex).toBe(0)
    state = handleAskKeyEvent(state, 'ctrl+n', 'n').state
    expect(state.focusIndex).toBe(1)
    state = handleAskKeyEvent(state, 'char', 'k').state
    expect(state.focusIndex).toBe(0)
  })

  test('j/k type normally in other mode', () => {
    let state = createAskState(singleQuestion)
    state = handleAskKeyEvent(state, 'char', '3').state
    state = handleAskKeyEvent(state, 'char', 'j').state
    state = handleAskKeyEvent(state, 'char', 'k').state
    const ui0 = state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.otherText).toBe('jk')
  })

  test('submit review supports j/k after answering last question with other text', () => {
    let state = createAskState(multiQuestion)
    state = handleAskKeyEvent(state, 'char', '1').state
    state = handleAskKeyEvent(state, 'char', '4').state
    state = handleAskKeyEvent(state, 'char', 'x').state
    state = handleAskKeyEvent(state, 'enter').state
    expect(state.onSubmitTab).toBe(true)
    state = handleAskKeyEvent(state, 'char', 'j').state
    expect(state.submitFocus).toBe(1)
    state = handleAskKeyEvent(state, 'char', 'k').state
    expect(state.submitFocus).toBe(0)
  })

  test('shift-tab moves to previous question', () => {
    let state = createAskState(multiQuestion)
    state = askNextTab(state)
    const keyResult = handleAskKeyEvent(state, 'shift-tab')
    expect(keyResult.state.currentTab).toBe(0)
  })

  test('paste enters other mode and appends text', () => {
    const state = createAskState(singleQuestion)
    const keyResult = handleAskKeyEvent(state, 'paste', 'hello\nworld')
    const ui0 = keyResult.state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.inOtherMode).toBe(true)
    expect(ui0.otherText).toBe('hello world')
    expect(keyResult.state.focusIndex).toBe(2)
  })

  test('whitespace-only paste leaves state unchanged', () => {
    const state = createAskState(singleQuestion)
    const keyResult = handleAskKeyEvent(state, 'paste', '\n\n')
    const ui0 = keyResult.state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(ui0.inOtherMode).toBe(false)
    expect(keyResult.state.focusIndex).toBe(0)
  })

  test('number key selects an option', () => {
    const state = createAskState(singleQuestion)
    const keyResult = handleAskKeyEvent(state, 'char', '2')
    expect(keyResult.action).toBe('submit')
    expect(keyResult.state.answers[0]!.selectedOption).toBe(1)
  })

  test('number key focuses other without submitting', () => {
    const state = createAskState(singleQuestion)
    const keyResult = handleAskKeyEvent(state, 'char', '3')
    const ui0 = keyResult.state.uiStates.get(0) ?? { inOtherMode: false, otherText: '', focusIndex: 0 }
    expect(keyResult.action).toBe('update')
    expect(ui0.inOtherMode).toBe(true)
    expect(ui0.otherText).toBe('')
  })
})

describe('renderAsk via viewmodel', () => {
  test('single question shows question text', () => {
    const state = createAskState(singleQuestion)
    expect(renderAskVM(state)).toContain('Which language?')
  })

  test('shows all options', () => {
    const state = createAskState(singleQuestion)
    const text = renderAskVM(state)
    expect(text).toContain('1. Rust')
    expect(text).toContain('2. TypeScript')
    expect(text).toContain('3. Type something.')
  })

  test('shows descriptions', () => {
    const state = createAskState(singleQuestion)
    const text = renderAskVM(state)
    expect(text).toContain('Systems programming')
    expect(text).toContain('Web development')
  })

  test('shows focus indicator', () => {
    const state = createAskState(singleQuestion)
    expect(renderAskVM(state)).toContain('·')
  })

  test('multi question shows tab bar', () => {
    const state = createAskState(multiQuestion)
    const text = renderAskVM(state)
    expect(text).toContain('Language')
    expect(text).toContain('Style')
  })

  test('other mode keeps input option structure while typing', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'h')
    state = askTypeChar(state, 'i')
    const text = renderAskVM(state)
    expect(text).toContain('3. hi')
    expect(text).toContain('hi')
  })

  test('selected option shows trailing checkmark', () => {
    let state = createAskState(multiQuestion)
    state = askSelect(state).state
    state = askPrevTab(state)
    const text = renderAskVM(state)
    expect(text).toContain('1. Rust')
    expect(text).toContain('✓')
  })

  test('other mode shows placeholder when empty', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    const text = renderAskVM(state)
    expect(text).toContain('3. Type something.')
  })

  test('submit review warns when questions are unanswered', () => {
    let state = createAskState(multiQuestion)
    state = askNextTab(state)
    state = askNextTab(state)
    const text = renderAskVM(state)
    expect(text).toContain('✓ Submit')
    expect(text).toContain('→')
    expect(text).toContain('Review your answers')
    expect(text).toContain('⚠ You have not answered all questions')
    expect(text).toContain('Ready to submit your answers?')
    expect(text).not.toContain('→ —')
  })

  test('submit review lists only answered questions', () => {
    let state = createAskState(multiQuestion)
    state = askSelect(state).state
    state = askNextTab(state)
    const text = renderAskVM(state)
    expect(text).toContain('• Which language?')
    expect(text).toContain('→ Rust')
    expect(text).not.toContain('• Which style?')
  })

  test('multiline questions use hanging indentation in review and committed history', () => {
    const question = 'Run “Daily report” now?\nResult: feishu · p2p:*'
    expect(prefixedAskLines(question, '  • ')).toEqual([
      '  • Run “Daily report” now?',
      '    Result: feishu · p2p:*',
    ])

    let state = createAskState([{
      header: 'Run task',
      question,
      options: [{ label: 'Run now', description: '' }, { label: 'Cancel', description: '' }],
    }])
    state = { ...state, onSubmitTab: true, answers: [{ questionIndex: 0, selectedOption: 0, customText: null }] }
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'ask-user', state }, 80)).map(stripAnsi)
    expect(lines).toContain('  • Run “Daily report” now?')
    expect(lines).toContain('    Result: feishu · p2p:*')
  })

  test('renders ask_user as a full-width editor replacement rather than a centered modal', () => {
    const state = createAskState(singleQuestion)
    const lines = buildAskRegionLines(state, 40).map(line => stripAnsi(line))

    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('─'.repeat(40))
    expect(lines.join('\n')).toContain('Which language?')
    expect(lines.join('\n')).toContain('Rust')
    expect(lines.at(-1)).toBe('─'.repeat(40))
  })

  test('other mode shows cursor before placeholder when empty', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    const blocks = buildOverlayBlocks({ kind: 'ask-user', state }, 80)
    const otherLine = blocks.flatMap(b => b.lines).find(l => l.spans.some(s => s.text.includes('Type something.')))
    const spans = otherLine?.spans ?? []
    const cursorIndex = spans.findIndex(span => span.text === CURSOR_MARKER)
    const placeholderIndex = spans.findIndex(span => span.text === 'Type something.')

    expect(cursorIndex).toBeGreaterThan(-1)
    expect(placeholderIndex).toBeGreaterThan(-1)
    expect(cursorIndex).toBeLessThan(placeholderIndex)
    expect(spans.map(span => span.text).join('')).toContain(`3. ${CURSOR_MARKER}Type something.`)
  })

  test('selected other shows label, green checkmark, and custom text', () => {
    let state = createAskState(multiQuestion)
    state = handleAskKeyEvent(state, 'char', '3').state
    state = handleAskKeyEvent(state, 'char', 'c').state
    state = handleAskKeyEvent(state, 'char', 'u').state
    state = handleAskKeyEvent(state, 'char', 's').state
    state = handleAskKeyEvent(state, 'char', 't').state
    state = handleAskKeyEvent(state, 'char', 'o').state
    state = handleAskKeyEvent(state, 'char', 'm').state
    state = handleAskKeyEvent(state, 'enter').state
    state = askPrevTab(state)
    const text = renderAskVM(state)
    expect(text).toContain('3. custom ✓')
    expect(text).toContain('custom')

    const blocks = buildOverlayBlocks({ kind: 'ask-user', state }, 80)
    const otherLine = blocks.flatMap(b => b.lines).find(l => l.spans.some(s => s.text === 'custom'))
    const spans = otherLine?.spans ?? []
    const textIndex = spans.findIndex(span => span.text === 'custom')
    const tickIndex = spans.findIndex(span => span.text === '✓' && span.fg === 'green')
    expect(textIndex).toBeGreaterThan(-1)
    expect(tickIndex).toBeGreaterThan(-1)
    expect(tickIndex).toBeGreaterThan(textIndex)
  })

})

describe('Other field cursor movement', () => {
  test('native cursor movement and deletion preserve complete Unicode graphemes', () => {
    for (const grapheme of ['好', '👩🏽‍💻', 'e\u0301']) {
      let state = askDown(askDown(createAskState(singleQuestion)))
      state = askTypeChar(state, `a${grapheme}b`)
      state = askCursorLeft(state)
      expect(state.uiStates.get(0)?.otherCursor).toBe(1 + grapheme.length)
      state = askCursorLeft(state)
      expect(state.uiStates.get(0)?.otherCursor).toBe(1)
      expect(blocksToLines(buildOverlayBlocks({ kind: 'ask-user', state }, 80)).join(''))
        .toContain(`a${CURSOR_MARKER}${grapheme}b`)
      expect(askDelete(state).uiStates.get(0)?.otherText).toBe('ab')
      state = askCursorRight(state)
      expect(state.uiStates.get(0)?.otherCursor).toBe(1 + grapheme.length)
      state = askBackspace(state)
      expect(state.uiStates.get(0)?.otherText).toBe('ab')
      expect(state.uiStates.get(0)?.otherCursor).toBe(1)
    }
  })
  test('left/right moves cursor within Other text', () => {
    let state = createAskState(singleQuestion)
    // Navigate to Other (last option)
    state = askDown(state)
    state = askDown(state)
    // Type some text
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'b')
    state = askTypeChar(state, 'c')
    const ui0 = state.uiStates.get(0)!
    expect(ui0.otherText).toBe('abc')
    expect(ui0.otherCursor).toBe(3)

    // Move left
    state = askCursorLeft(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(2)
    state = askCursorLeft(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(1)

    // Insert at cursor
    state = askTypeChar(state, 'X')
    expect(state.uiStates.get(0)!.otherText).toBe('aXbc')
    expect(state.uiStates.get(0)!.otherCursor).toBe(2)

    // Move right
    state = askCursorRight(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(3)
  })

  test('left at position 0 is a no-op', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'x')
    state = askCursorLeft(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(0)
    state = askCursorLeft(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(0)
  })

  test('right at end of text is a no-op', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'x')
    expect(state.uiStates.get(0)!.otherCursor).toBe(1)
    state = askCursorRight(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(1)
  })

  test('home moves cursor to start', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'b')
    state = askTypeChar(state, 'c')
    state = askCursorHome(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(0)
  })

  test('end moves cursor to end', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'b')
    state = askTypeChar(state, 'c')
    state = askCursorHome(state)
    state = askCursorEnd(state)
    expect(state.uiStates.get(0)!.otherCursor).toBe(3)
  })

  test('delete removes character at cursor', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'b')
    state = askTypeChar(state, 'c')
    state = askCursorHome(state)
    state = askDelete(state)
    expect(state.uiStates.get(0)!.otherText).toBe('bc')
    expect(state.uiStates.get(0)!.otherCursor).toBe(0)
  })

  test('delete at end of text is a no-op', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'x')
    state = askDelete(state)
    expect(state.uiStates.get(0)!.otherText).toBe('x')
  })

  test('backspace at cursor removes character before cursor', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'b')
    state = askTypeChar(state, 'c')
    state = askCursorLeft(state)
    state = askBackspace(state)
    expect(state.uiStates.get(0)!.otherText).toBe('ac')
    expect(state.uiStates.get(0)!.otherCursor).toBe(1)
  })

  test('paste inserts at cursor position', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'a')
    state = askTypeChar(state, 'c')
    state = askCursorLeft(state)
    state = askPasteText(state, 'XY')
    expect(state.uiStates.get(0)!.otherText).toBe('aXYc')
    expect(state.uiStates.get(0)!.otherCursor).toBe(3)
  })

  test('entering Other mode via down sets cursor to end of text', () => {
    let state = createAskState(singleQuestion)
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'hi')
    // Leave Other mode
    state = askUp(state)
    expect(state.uiStates.get(0)!.inOtherMode).toBe(false)
    // Re-enter Other mode
    state = askDown(state)
    state = askDown(state)
    expect(state.uiStates.get(0)!.inOtherMode).toBe(true)
    expect(state.uiStates.get(0)!.otherCursor).toBe(2)
  })
})

describe('left/right after answer submission', () => {
  test('left/right switches tabs after Other answer is submitted', () => {
    let state = createAskState(multiQuestion)
    // Go to Other on first tab
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'custom')
    // Submit (enter) — advances to next tab
    const result = askSelect(state)
    state = result.state
    expect(state.currentTab).toBe(1)

    // Go back to first tab
    state = askPrevTab(state)
    expect(state.currentTab).toBe(0)
    // Focus is still on Other with submitted answer
    expect(state.answers[0]!.customText).toBe('custom')

    // Now left/right should switch tabs, not move cursor
    const r1 = handleAskKeyEvent(state, 'right', '')
    expect(r1.action).toBe('update')
    if (r1.action === 'update') {
      expect(r1.state.currentTab).toBe(1)
    }
  })

  test('left/right moves cursor in Other when not yet submitted', () => {
    let state = createAskState(multiQuestion)
    // Go to Other on first tab
    state = askDown(state)
    state = askDown(state)
    state = askTypeChar(state, 'abc')
    // NOT submitted yet — left should move cursor
    const r1 = handleAskKeyEvent(state, 'left', '')
    expect(r1.action).toBe('update')
    if (r1.action === 'update') {
      expect(r1.state.currentTab).toBe(0) // stays on same tab
      expect(r1.state.uiStates.get(0)!.otherCursor).toBe(2) // cursor moved
    }
  })

  test('left/right switches tabs after regular option is submitted', () => {
    let state = createAskState(multiQuestion)
    // Select first option (Rust) — advances to next tab
    const result = askSelect(state)
    state = result.state
    expect(state.currentTab).toBe(1)

    // Go back to first tab
    state = askPrevTab(state)
    expect(state.currentTab).toBe(0)
    expect(state.answers[0]!.selectedOption).toBe(0)

    // Right should switch tab
    const r1 = handleAskKeyEvent(state, 'right', '')
    expect(r1.action).toBe('update')
    if (r1.action === 'update') {
      expect(r1.state.currentTab).toBe(1)
    }
  })
})

describe('askStateToResponse', () => {
  test('keeps unanswered questions as skipped when submitting incomplete review', () => {
    let state = createAskState(multiQuestion)
    state = askSelect(state).state
    state = askNextTab(state)
    const response = askStateToResponse(state)
    expect(response).toEqual([
      { header: 'Language', question: 'Which language?', answer: 'Rust' },
      { header: 'Style', question: 'Which style?', answer: 'Skipped' },
    ])
  })
})

describe('free-text question (no options)', () => {
  const freeText = [
    { header: 'Instruction', question: 'What should the task do differently?', options: [] },
  ]

  test('opens directly in text mode and renders a single input row', () => {
    const state = createAskState(freeText)
    const text = renderAskVM(state)
    expect(text).toContain('What should the task do differently?')
    expect(text).toContain('Type your answer.')
    expect(text).not.toContain('1.')
    expect(text).toContain('enter submit · esc cancel')
    expect(text).not.toContain('↑↓ navigate')
  })

  test('typed characters go straight into the answer', () => {
    let state = createAskState(freeText)
    for (const ch of 'no status') {
      const r = handleAskKeyEvent(state, 'char', ch)
      if (r.action === 'update') state = r.state
    }
    expect(renderAskVM(state)).toContain('no status')
    const r = handleAskKeyEvent(state, 'enter')
    expect(r.action).toBe('submit')
    if (r.action === 'submit') {
      expect(askStateToResponse(r.state)).toEqual([
        { header: 'Instruction', question: 'What should the task do differently?', answer: 'no status' },
      ])
    }
  })

  test('up/down/j/k/page keys stay in text mode and type j/k literally', () => {
    let state = createAskState(freeText)
    for (const ev of ['up', 'down', 'page-up', 'page-down'] as const) {
      const r = handleAskKeyEvent(state, ev)
      if (r.action === 'update') state = r.state
    }
    for (const ch of 'jk') {
      const r = handleAskKeyEvent(state, 'char', ch)
      if (r.action === 'update') state = r.state
    }
    expect(renderAskVM(state)).toContain('jk')
  })

  test('enter with empty text does nothing', () => {
    const state = createAskState(freeText)
    const r = handleAskKeyEvent(state, 'enter')
    expect(r.action).toBe('update')
  })

  test('escape cancels', () => {
    const state = createAskState(freeText)
    expect(handleAskKeyEvent(state, 'escape').action).toBe('cancel')
  })
})
