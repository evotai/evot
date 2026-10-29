import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import {
  backspace,
  createEditorState,
  deleteForward,
  deleteWordBefore,
  getEditorText,
  insertText,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
} from '../src/term/input/editor.js'
import { buildPromptBlocks, type PromptVMInput } from '../src/term/viewmodel/prompt.js'
import { wrapTextByWidth } from '../src/term/viewmodel/width.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import { TermRenderer } from '../src/term/renderer.js'
import { ScreenHarness } from './helpers/screen.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'

function promptInput(text: string, cursorCol: number, columns = 20): PromptVMInput {
  return {
    lines: [text],
    cursorLine: 0,
    cursorCol,
    active: true,
    completion: null,
    ghostHint: '',
    columns,
    rows: 24,
    placeholder: false,
    model: 'test-model',
    provider: '',
    thinkingLevel: '',
    planning: false,
    logMode: false,
    dashboardUrl: null,
    exitHint: false,
    cwd: '/tmp/project',
    gitBranch: null,
    contextTokens: 0,
    contextWindow: 0,
  }
}

describe('grapheme-safe editor', () => {
  test('moves across and deletes a ZWJ emoji as one character', () => {
    const family = '👨‍👩‍👧‍👦'
    let state = insertText(createEditorState(), `a${family}b`)

    state = moveLeft(state)
    expect(state.cursorCol).toBe(1 + family.length)
    state = moveLeft(state)
    expect(state.cursorCol).toBe(1)
    state = moveRight(state)
    expect(state.cursorCol).toBe(1 + family.length)

    state = backspace(state)
    expect(getEditorText(state)).toBe('ab')
    expect(state.cursorCol).toBe(1)
  })

  test('keeps flags and combining marks intact', () => {
    for (const grapheme of ['🇨🇳', 'e\u0301', '👍🏽']) {
      let state = insertText(createEditorState(), `a${grapheme}b`)
      state = moveLeft(state)
      state = backspace(state)
      expect(getEditorText(state)).toBe('ab')
      expect(state.cursorCol).toBe(1)
    }
  })

  test('forward delete removes one complete grapheme', () => {
    const emoji = '👩🏽‍💻'
    let state = insertText(createEditorState(), `a${emoji}b`)
    state = moveLeft(moveLeft(state))
    state = deleteForward(state)
    expect(getEditorText(state)).toBe('ab')
    expect(state.cursorCol).toBe(1)
  })

  test('treats paste and image references as atomic editor units', () => {
    for (const ref of ['[Image #7]', '[Pasted text #4 +12 lines]']) {
      let state = insertText(createEditorState(), `a${ref}b`)
      state = moveLeft(state)
      expect(state.cursorCol).toBe(1 + ref.length)
      state = moveLeft(state)
      expect(state.cursorCol).toBe(1)
      state = moveRight(state)
      state = backspace(state)
      expect(getEditorText(state)).toBe('ab')

      state = insertText(createEditorState(), `a${ref}b`)
      state = { ...state, cursorCol: 1 }
      state = deleteForward(state)
      expect(getEditorText(state)).toBe('ab')
      expect(state.cursorCol).toBe(1)
    }
  })

  test('word deletion never splits references or grapheme clusters', () => {
    for (const word of ['[Image #7]', '[Pasted text #4 +12 lines]', '👩🏽‍💻code']) {
      let state = insertText(createEditorState(), `prefix ${word}`)
      state = deleteWordBefore(state)
      expect(getEditorText(state)).toBe('prefix ')
      expect(state.cursorCol).toBe('prefix '.length)
    }
  })

  test('retains the preferred visual column across soft-wrapped rows', () => {
    let state = insertText(createEditorState(), 'abcdefghi')
    state = { ...state, cursorCol: 7 }

    state = moveUp(state, 4)
    expect(state.cursorCol).toBe(3)
    state = moveDown(state, 4)
    expect(state.cursorCol).toBe(7)
    state = moveDown(state, 4)
    expect(state.cursorCol).toBe(9)
    state = moveUp(state, 4)
    expect(state.cursorCol).toBe(7)
  })

  test('moves past short word-wrapped rows without getting stuck at their end', () => {
    let state = insertText(createEditorState(), 'abc defghij')
    state = { ...state, cursorCol: 8 }

    state = moveUp(state, 6)
    expect(state.cursorCol).toBe(3)
    state = moveDown(state, 6)
    expect(state.cursorCol).toBe(8)
  })

  test.each([32, 120, 200])('traverses padded terminal lines in both directions at width %i', (width) => {
    const lines = [
      'Log: /tmp/session.screen.log 分析最后的错误',
      ' '.repeat(204),
      '  ✦ llm  test-model'.padEnd(204),
      '    ✗ · turn 1 · 2.2s'.padEnd(204),
      '    Invalid request',
    ]
    const text = lines.join('\n')
    let state = insertText(createEditorState(), text)
    for (let step = 0; step < 40; step++) {
      const next = moveUp(state, width)
      if (next === state) break
      expect([next.cursorLine, next.cursorCol]).not.toEqual([state.cursorLine, state.cursorCol])
      state = next
    }
    expect(state.cursorLine).toBe(0)
    for (let step = 0; step < 40; step++) {
      const next = moveDown(state, width)
      if (next === state) break
      expect([next.cursorLine, next.cursorCol]).not.toEqual([state.cursorLine, state.cursorCol])
      state = next
    }
    expect(state.cursorLine).toBe(lines.length - 1)
    expect(getEditorText(state)).toBe(text)
  })

  test('skips wrapped reference rows with no legal cursor boundary', () => {
    const ref = '[Pasted text #4 +12 lines]'
    let state = insertText(createEditorState(), `a${ref}b`)
    state = moveUp(state, 6)
    expect(state.cursorCol).toBe(1)
    state = moveDown(state, 6)
    expect(state.cursorCol).toBe(2 + ref.length)
  })

  test('clamps to a grapheme boundary before a shared wrap boundary', () => {
    let state = insertText(createEditorState(), '你好abcdef')
    state = { ...state, cursorCol: 6 }
    state = moveUp(state, 5)
    expect(state.cursorCol).toBe(1)
    state = moveDown(state, 5)
    expect(state.cursorCol).toBe(6)
  })

  test('navigates the fresh cursor row after an exact-width line', () => {
    let state = insertText(createEditorState(), 'abcd')
    state = moveUp(state, 4)
    expect(state.cursorCol).toBe(0)
    state = moveDown(state, 4)
    expect(state.cursorCol).toBe(4)
  })
})

describe('grapheme-safe prompt layout', () => {
  test('never splits grapheme clusters across wrapped rows', () => {
    const family = '👨‍👩‍👧‍👦'
    const text = `a${family}b`
    const chunks = wrapTextByWidth(text, 2)
    expect(chunks.map(chunk => text.slice(chunk.start, chunk.end))).toEqual(['a', family, 'b'])
  })

  test('native cursor tracks Chinese leading cells without painting a fake background', async () => {
    const level = chalk.level
    chalk.level = 3
    const screen = new ScreenHarness(20, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    const text = 'hah你好啊'
    let cursorCol = 4
    const paint = async () => {
      renderer.requestRender()
      await Bun.sleep(25)
      await screen.settle()
    }
    renderer.init()
    renderer.setRenderCallback(() => blocksToLines(buildPromptBlocks(promptInput(text, cursorCol))))
    try {
      for (const position of [4, 3, 2, 4, 5]) {
        cursorCol = position
        await paint()
        const buffer = screen.terminal.buffer.active
        const row = buffer.getLine(buffer.cursorY + buffer.baseY)
        const x = buffer.cursorX
        const width = position < 3 ? 1 : 2
        expect(row?.getCell(x)?.getChars()).toBe(text[position])
        expect(row?.getCell(x)?.getWidth()).toBe(width)
        // Cells contain normal text; the terminal draws its cursor overlay.
        for (let col = 0; col < screen.columns; col++) {
          expect(row?.getCell(col)?.isBgDefault()).toBe(true)
        }
        expect(row?.translateToString(true)).toBe(text)
      }
    } finally {
      renderer.destroy()
      screen.terminal.dispose()
      chalk.level = level
    }
  })

  test('renders the complete grapheme under the cursor', () => {
    chalk.level = 3
    const emoji = '👩🏽‍💻'
    const rendered = blocksToLines(buildPromptBlocks(promptInput(`${emoji}x`, 0))).join('\n')
    expect(rendered).toContain(`${CURSOR_MARKER}${emoji}x`)
    expect(rendered).not.toContain('\x1b[48;2;154;230;92m')
  })
})
