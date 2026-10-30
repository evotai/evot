import { describe, test, expect, beforeAll } from 'bun:test'
import {
  createEditorState,
  insertText,
  backspace,
  moveLeft,
  moveRight,
  moveHome,
  moveEnd,
  clearEditor,
  getEditorText,
  isEditorEmpty,
} from '../src/term/input/editor.js'
import { buildPromptBlocks, type PromptVMInput } from '../src/term/viewmodel/prompt.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import { visibleWidth } from '../src/render/wrap.js'
import chalk from 'chalk'

beforeAll(() => { chalk.level = 3 })

function defaultPromptVM(overrides?: Partial<PromptVMInput>): PromptVMInput {
  return {
    lines: [''],
    cursorLine: 0,
    cursorCol: 0,
    active: true,
    model: 'test-model',
    provider: '',
    thinkingLevel: '',
    logMode: false,
    dashboardUrl: null,
    exitHint: false,
    completion: null,
    ghostHint: '',
    columns: 80,
    rows: 24,
    placeholder: true,
    cwd: '/Users/test/project',
    gitBranch: 'main',
    contextTokens: 0,
    contextWindow: 0,
    ...overrides,
  }
}

describe('createEditorState', () => {
  test('creates initial state with empty line', () => {
    const state = createEditorState()
    expect(state.lines).toEqual([''])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(0)
  })
})

describe('insertText', () => {
  test('inserts single character', () => {
    let state = createEditorState()
    state = insertText(state, 'a')
    expect(state.lines).toEqual(['a'])
    expect(state.cursorCol).toBe(1)
  })

  test('inserts at cursor position', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = { ...state, cursorCol: 2 }
    state = insertText(state, 'X')
    expect(state.lines).toEqual(['heXllo'])
    expect(state.cursorCol).toBe(3)
  })

  test('inserts multi-line text', () => {
    let state = createEditorState()
    state = insertText(state, 'line1\nline2\nline3')
    expect(state.lines).toEqual(['line1', 'line2', 'line3'])
    expect(state.cursorLine).toBe(2)
    expect(state.cursorCol).toBe(5)
  })

  test('inserts multi-line in middle of existing text', () => {
    let state = createEditorState()
    state = insertText(state, 'before after')
    state = { ...state, cursorCol: 7 }
    state = insertText(state, 'X\nY')
    expect(state.lines).toEqual(['before X', 'Yafter'])
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(1)
  })
})

describe('backspace', () => {
  test('deletes character before cursor', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = backspace(state)
    expect(state.lines).toEqual(['hell'])
    expect(state.cursorCol).toBe(4)
  })

  test('at start of line joins with previous', () => {
    let state = createEditorState()
    state = insertText(state, 'ab\ncd')
    state = { ...state, cursorLine: 1, cursorCol: 0 }
    state = backspace(state)
    expect(state.lines).toEqual(['abcd'])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(2)
  })

  test('at start of first line does nothing', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = { ...state, cursorCol: 0 }
    state = backspace(state)
    expect(state.lines).toEqual(['hello'])
    expect(state.cursorCol).toBe(0)
  })
})

describe('cursor movement', () => {
  test('moveLeft moves left', () => {
    let state = createEditorState()
    state = insertText(state, 'abc')
    state = moveLeft(state)
    expect(state.cursorCol).toBe(2)
  })

  test('moveLeft at start of line wraps to previous', () => {
    let state = createEditorState()
    state = insertText(state, 'ab\ncd')
    state = { ...state, cursorLine: 1, cursorCol: 0 }
    state = moveLeft(state)
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(2)
  })

  test('moveLeft at start of first line does nothing', () => {
    let state = createEditorState()
    state = moveLeft(state)
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(0)
  })

  test('moveRight moves right', () => {
    let state = createEditorState()
    state = insertText(state, 'abc')
    state = { ...state, cursorCol: 1 }
    state = moveRight(state)
    expect(state.cursorCol).toBe(2)
  })

  test('moveRight at end of line wraps to next', () => {
    let state = createEditorState()
    state = insertText(state, 'ab\ncd')
    state = { ...state, cursorLine: 0, cursorCol: 2 }
    state = moveRight(state)
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
  })

  test('moveRight at end of last line does nothing', () => {
    let state = createEditorState()
    state = insertText(state, 'abc')
    state = moveRight(state)
    expect(state.cursorCol).toBe(3)
  })

  test('moveHome moves to start', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = moveHome(state)
    expect(state.cursorCol).toBe(0)
  })

  test('moveEnd moves to end', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = { ...state, cursorCol: 2 }
    state = moveEnd(state)
    expect(state.cursorCol).toBe(5)
  })
})

describe('clearEditor', () => {
  test('resets to empty', () => {
    let state = createEditorState()
    state = insertText(state, 'hello\nworld')
    state = clearEditor(state)
    expect(state.lines).toEqual([''])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(0)
  })
})

describe('getEditorText', () => {
  test('returns joined lines', () => {
    let state = createEditorState()
    state = insertText(state, 'line1\nline2')
    expect(getEditorText(state)).toBe('line1\nline2')
  })

  test('single line', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    expect(getEditorText(state)).toBe('hello')
  })
})

describe('isEditorEmpty', () => {
  test('true for initial state', () => {
    const state = createEditorState()
    expect(isEditorEmpty(state)).toBe(true)
  })

  test('false after input', () => {
    let state = createEditorState()
    state = insertText(state, 'x')
    expect(isEditorEmpty(state)).toBe(false)
  })

  test('true after clear', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = clearEditor(state)
    expect(isEditorEmpty(state)).toBe(true)
  })
})

describe('renderPrompt', () => {
  test('suggestion replaces only the idle empty placeholder, never the draft', () => {
    const render = (extra: Partial<PromptVMInput>) => blocksToLines(buildPromptBlocks(defaultPromptVM({
      suggestion: '\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5', ...extra,
    }))).join('\n')
    expect(render({})).toContain('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
    expect(render({})).toContain('⇥ next · → accept')
    expect(render({ suggestionPosition: { current: 3, total: 3 } })).toContain('3/3 ⇥ next · → accept')
    expect(render({ busy: true })).not.toContain('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
    expect(render({ active: false })).not.toContain('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
    expect(render({ logMode: true })).not.toContain('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
    expect(render({ lines: ['draft'], cursorCol: 5, placeholder: false })).not.toContain('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
  })

  test('long suggestions retain both acceptance key hints on narrow terminals', () => {
    const output = blocksToLines(buildPromptBlocks(defaultPromptVM({
      columns: 40, suggestion: 'Run the targeted tests and review the results '.repeat(4),
    }))).join('\n')
    expect(output).toContain('⇥ next · → accept')
  })

  test('draft completion renders as ghost text after the cursor, not as the placeholder', () => {
    const render = (extra: Partial<PromptVMInput>) => blocksToLines(buildPromptBlocks(defaultPromptVM({
      lines: ['Run the'], cursorCol: 7, placeholder: false, suggestionCompletion: ' targeted tests',
      suggestionPosition: { current: 1, total: 2 }, ...extra,
    }))).join('\n')
    expect(render({})).toContain('Run the')
    expect(render({})).toContain(' targeted tests  1/2 ⇥ next · → accept')
    expect(render({ busy: true })).not.toContain('targeted tests')
    expect(render({ busy: true, suggestionExplicit: true })).toContain(' targeted tests  1/2 ⇥ next · → accept')
    expect(render({ active: false })).not.toContain('targeted tests')
    expect(render({ lines: [''], cursorCol: 0, placeholder: true })).not.toContain('targeted tests')
  })

  test('cursor rewrites preview only the replacement and preserve the original draft', () => {
    const input = defaultPromptVM({
      lines: ['Run the old suite', 'Old follow-up'], cursorCol: 8, cursorLine: 0, placeholder: false,
      suggestionCompletion: 'new suite\nThen review', suggestionReplacing: true, suggestionExplicit: true,
      suggestionPosition: { current: 2, total: 3 },
    })
    const screen = blocksToLines(buildPromptBlocks(input)).join('\n')
    expect(screen).toContain('Run the')
    expect(screen).toContain('new suite')
    expect(screen).toContain('Then review')
    expect(screen).toContain('2/3 ⇥ next · → replace rest')
    expect(screen).not.toContain('old suite')
    expect(screen).not.toContain('Old follow-up')
    expect(input.lines).toEqual(['Run the old suite', 'Old follow-up'])
    const original = blocksToLines(buildPromptBlocks({ ...input, suggestionCompletion: undefined })).join('\n')
    expect(original).toContain('old suite')
    expect(original).toContain('Old follow-up')
  })

  test('replacement previews at the start and across wrapped rows keep frame widths bounded', () => {
    for (const columns of [18, 35, 80]) {
      const screen = blocksToLines(buildPromptBlocks(defaultPromptVM({
        columns, lines: ['discard old text'], cursorCol: 0, placeholder: false,
        suggestionCompletion: 'A replacement sentence that wraps\nAnd another line',
        suggestionReplacing: true, suggestionExplicit: true,
      })))
      expect(screen.join('\n')).not.toContain('discard old')
      for (const row of screen) expect(visibleWidth(row)).toBeLessThanOrEqual(columns)
    }
  })

  test('Tab feedback renders after the draft: an animated wait, then nothing-to-suggest', () => {
    const render = (extra: Partial<PromptVMInput>) => blocksToLines(buildPromptBlocks(defaultPromptVM({
      lines: ['hi --'], cursorCol: 5, placeholder: false, ...extra,
    }))).join('\n')
    expect(render({ suggestionStatus: 'pending', suggestionFrame: 0 })).toContain('hi --\x1b_pi:c\x07\x1b[38;2;119;119;119m  · suggesting…')
    expect(render({ suggestionStatus: 'pending', suggestionFrame: 2 })).toContain('✳ suggesting…')
    expect(render({ suggestionStatus: 'none' })).toContain('· nothing to suggest · ⇥ retry')
    expect(render({ suggestionStatus: 'failed' })).toContain('suggestion failed · ⇥ retry')
    expect(render({ suggestionStatus: 'timed_out' })).toContain('suggestion timed out · ⇥ retry')
    expect(render({ suggestionStatus: 'unavailable' })).toContain('suggestions unavailable · ⇥ retry')
    expect(render({ lines: [''], cursorCol: 0, placeholder: true, suggestionStatus: 'failed' })).toContain('suggestion failed · ⇥ retry')
    expect(render({})).not.toContain('suggesting')
    expect(render({ suggestionStatus: 'pending', busy: true })).not.toContain('suggesting')
    expect(render({ suggestionStatus: 'pending', busy: true, suggestionExplicit: true })).toContain('suggesting…')
    expect(render({ lines: [''], cursorCol: 0, placeholder: true, busy: true, suggestionExplicit: true, suggestion: 'Change the approach' }))
      .toContain('Change the approach')
    // Switching a cached batch has no loading indicator or refresh state.
    const cached = render({ suggestionCompletion: ' targeted tests', suggestionPosition: { current: 3, total: 3 } })
    expect(cached).toContain('targeted tests  3/3 ⇥ next · → accept')
    expect(cached).not.toContain('more…')
    expect(cached).not.toContain('suggesting…')
  })

  test('returns array of strings', () => {
    const lines = blocksToLines(buildPromptBlocks(defaultPromptVM()))
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  test('contains the caret', () => {
    const lines = blocksToLines(buildPromptBlocks(defaultPromptVM()))
    const joined = lines.join('\n')
    expect(joined).toContain('\x1b_pi:c\x07')
    expect(joined).not.toContain('▍')
  })

  test('contains border', () => {
    const lines = blocksToLines(buildPromptBlocks(defaultPromptVM()))
    const joined = lines.join('\n')
    expect(joined).toContain('─')
  })

  test('shows input text', () => {
    const lines = blocksToLines(buildPromptBlocks(defaultPromptVM({
      lines: ['my input'],
      cursorCol: 8,
      placeholder: false,
    })))
    const joined = lines.join('\n')
    expect(joined).toContain('my input')
  })
})
