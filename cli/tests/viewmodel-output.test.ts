import { describe, test, expect, beforeAll } from 'bun:test'
import { buildOutputBlocks, THINKING_FOLD_ROWS } from '../src/term/viewmodel/output.js'
import { blocksToLines, styledLineToAnsi, paintBackground, line, colored, dim } from '../src/term/viewmodel/types.js'
import { buildUserMessage, buildAssistantLines, buildToolCard, buildEventCard, buildPrivacyCard, buildPrivacyActionCard, buildPrivacyHappeningCard, type OutputLine } from '../src/render/output.js'
import { getTheme } from '../src/render/theme/index.js'
import { assistantMessageToOutputLines } from '../src/render/assistant.js'
import { colorizeUnifiedDiff } from '../src/render/diff.js'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import chalk from 'chalk'

const OSC133_ZONE_START = '\x1b]133;A\x07'
const OSC133_ZONE_END = '\x1b]133;B\x07\x1b]133;C\x07'

beforeAll(() => {
  chalk.level = 3
})

function render(lines: OutputLine[]): string {
  return blocksToLines(buildOutputBlocks(lines)).join('\n')
}

function renderPlain(lines: OutputLine[]): string {
  return stripAnsi(render(lines))
}

function renderWithColumns(lines: OutputLine[], columns: number): string {
  return blocksToLines(buildOutputBlocks(lines, { columns })).join('\n')
}

function renderPlainWithColumns(lines: OutputLine[], columns: number): string {
  return stripAnsi(renderWithColumns(lines, columns))
}

/** SGR that opens a truecolor background for `hex`. */
function bgOpen(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[48;2;${r};${g};${b}m`
}

/** Visible rows of a filled block, trimmed; drops margin and rail-only padding rows. */
function contentRows(plain: string): string[] {
  return plain.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '' && l.trim() !== '┃')
}

describe('buildOutputBlocks', () => {
  test('user message has marginTop=1 and sits on the panel behind a brand rail', () => {
    const lines: OutputLine[] = [{ id: 'u1', kind: 'user', text: 'hello' }]
    const plain = renderPlain(lines)
    expect(plain.startsWith('\n')).toBe(true)
    // opencode's UserMessage: border-left, then the text. No glyph, no bold.
    expect(contentRows(plain)).toEqual(['┃ hello'])
    const ansi = render(lines)
    expect(ansi).toContain(bgOpen(getTheme().panelBg))
    expect(ansi).toContain(chalk.hex(getTheme().brandHex)('┃'))
    expect(ansi).not.toContain('\u258d')
  })

  test('user block is padded with a blank filled row above and below', () => {
    const rows = renderWithColumns([{ id: 'u1', kind: 'user', text: 'hello' }], 12).split('\n')
    // margin, top pad, text, bottom pad
    expect(rows.length).toBe(4)
    expect(rows[0]).toBe('')
    const fill = bgOpen(getTheme().panelBg)
    for (const row of rows.slice(1)) {
      expect(row.startsWith(fill)).toBe(true)
      expect(row.endsWith('\x1b[49m')).toBe(true)
      // Every row spans the full terminal width so the slab reaches the margin.
      expect(stringWidth(stripAnsi(row))).toBe(12)
    }
  })

  test('a timestamped user message shows the clock above the text', () => {
    const at = new Date(2026, 7, 31, 18, 11).getTime()
    const rows = contentRows(renderPlain([{ id: 'u1', kind: 'user', text: 'hello', timestamp: at }]))
    expect(rows[0]).toBe('┃ [18:11:00]')
    expect(rows[1]).toBe('┃ hello')
  })

  test('every rendered row of a user message is a full-width filled row', () => {
    const at = new Date(2026, 7, 31, 6, 5).getTime()
    const rendered = renderWithColumns(
      [{ id: 'u1', kind: 'user', text: 'a'.repeat(40), timestamp: at }],
      20,
    ).split('\n').slice(1)
    expect(stripAnsi(rendered[1]!).trimEnd()).toBe('┃ [06:05:00]')
    for (const row of rendered) expect(stringWidth(stripAnsi(row))).toBe(20)
  })

  test('hard newlines keep each logical line as its own filled row', () => {
    const rows = contentRows(renderPlainWithColumns(
      [{ id: 'u1', kind: 'user', text: 'first\nsecond\nthird' }],
      40,
    ))
    expect(rows).toEqual(['┃ first', '┃ second', '┃ third'])
  })

  test('assistant block starts with marginTop=1', () => {
    const result = renderPlain([
      { id: 'u1', kind: 'user', text: 'hi' },
      { id: 'a1', kind: 'assistant', text: 'response line 1' },
    ])
    const lines = result.split('\n')
    const assistantIdx = lines.findIndex(l => l.includes('response line 1'))
    expect(lines[assistantIdx - 1]).toBe('')
  })

  test('consecutive assistant lines have no margin', () => {
    const result = renderPlain([
      { id: 'a1', kind: 'assistant', text: 'line 1' },
      { id: 'a2', kind: 'assistant', text: 'line 2' },
      { id: 'a3', kind: 'assistant', text: 'line 3' },
    ])
    const lines = result.split('\n')
    const contentLines = lines.filter(l => l.includes('line'))
    expect(contentLines.length).toBe(3)
    const emptyBetween = lines.slice(
      lines.indexOf(contentLines[0]!),
      lines.indexOf(contentLines[2]!) + 1
    ).filter(l => l === '')
    expect(emptyBetween.length).toBe(0)
  })

  test('thinking body is muted, not dim-italic, and sits on the text column', () => {
    const output = assistantMessageToOutputLines([
      { type: 'thinking', contentIndex: 0, text: 'Planning the change' },
    ], false, { streaming: true })
    const rendered = blocksToLines(buildOutputBlocks(output)).join('\n')
    expect(rendered).not.toContain('\x1b[3m')
    expect(rendered).toContain(getTheme().thinkText.paint('Planning the change'))
    expect(stripAnsi(rendered)).toContain('✻ Planning the change')
  })

  test('a finished short thought keeps its original row and position', () => {
    const blocks = [{ type: 'thinking' as const, contentIndex: 0, text: 'line one' }]
    const live = renderPlainWithColumns(assistantMessageToOutputLines(blocks, false, { streaming: true }), 40)
    expect(live).toContain('✻ line one')
    const done = renderPlainWithColumns(assistantMessageToOutputLines(blocks), 40)
    expect(done).toBe(live)
    expect(done).not.toContain('ctrl+o')
    expect(renderPlainWithColumns(assistantMessageToOutputLines(blocks, true), 40)).toBe(done)
  })

  test('reasoning leads with an accent ✻ and indents continuations', () => {
    const lines = renderPlain([{
      id: 'thinking-1',
      kind: 'thinking',
      text: 'first line',
      thinkingStyle: true,
    }, {
      id: 'thinking-2',
      kind: 'thinking',
      text: 'second line',
      thinkingStyle: true,
    }]).split('\n').filter(l => l.length > 0)
    expect(lines).toEqual(['✻ first line', '  second line'])
    // The marker is the accent hue, not the old dim magenta.
    expect(render([{ id: 't', kind: 'thinking', text: 'x', thinkingStyle: true }]))
      .toContain(getTheme().thinkHeader.paint('✻ '))
  })

  test('long thinking lines wrap within terminal width', () => {
    const lines = renderPlainWithColumns([{
      id: 'thinking-long',
      kind: 'thinking',
      text: 'reasoning '.repeat(20),
      thinkingStyle: true,
    }], 40).split('\n').filter(Boolean)

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40)
  })

  test('once the answer starts, the thought stays and the answer keeps its block margin', () => {
    const output = assistantMessageToOutputLines([
      { type: 'thinking', contentIndex: 0, text: 'Investigating config' },
      { type: 'text', contentIndex: 1, text: 'Visible answer' },
    ])
    const plain = stripAnsi(blocksToLines(buildOutputBlocks(output)).join('\n'))
    expect(plain).toBe('\n✻ Investigating config\n\n⏺ Visible answer')
  })

  test('a short block stays in full with no fold hint after streaming finishes', () => {
    const blocks = [{ type: 'thinking' as const, contentIndex: 0, text: 'line one\n\nline two' }]
    const live = renderPlainWithColumns(assistantMessageToOutputLines(blocks, false, { streaming: true }), 40)
    expect(live).toContain('✻ line one')
    expect(live).toContain('line two')
    expect(live).not.toContain('ctrl+o')
    const done = renderPlainWithColumns(assistantMessageToOutputLines(blocks), 40)
    expect(done).toBe(live)
  })

  describe('long reasoning folds', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `reasoning row ${i + 1}`).join('\n\n')
    const longBlock = [{ type: 'thinking' as const, contentIndex: 0, text: longText }]
    const rowsOf = (plain: string) => plain.split('\n').filter(row => row.length > 0)

    test('while streaming, a tail window scrolls in place and stays THINKING_FOLD_ROWS tall', () => {
      const plain = renderPlainWithColumns(assistantMessageToOutputLines(longBlock, false, { streaming: true }), 80)
      const rows = rowsOf(plain)
      expect(rows).toHaveLength(THINKING_FOLD_ROWS)
      // The header counts what scrolled out; the newest rows stay visible.
      expect(rows[0]).toMatch(/^✻ ↑ \d+ rows \(ctrl\+o\)$/)
      expect(plain).toContain('reasoning row 20')
      expect(plain).not.toContain('reasoning row 1\n')

      // A delta that grows the block does not grow the window.
      const grown = [{ ...longBlock[0]!, text: `${longText}\n\nreasoning row 21` }]
      const next = renderPlainWithColumns(assistantMessageToOutputLines(grown, false, { streaming: true }), 80)
      expect(rowsOf(next)).toHaveLength(THINKING_FOLD_ROWS)
      expect(next).toContain('reasoning row 21')
    })

    test('once finished, the exact last window stays visible', () => {
      const live = renderPlainWithColumns(assistantMessageToOutputLines(longBlock, false, { streaming: true }), 80)
      const done = renderPlainWithColumns(assistantMessageToOutputLines(longBlock), 80)
      expect(done).toBe(live)
      expect(rowsOf(done)).toEqual(['✻ ↑ 18 rows (ctrl+o)', '  reasoning row 19', '  reasoning row 20'])
    })

    test('the answer follows the retained window on its own block margin', () => {
      const plain = renderPlainWithColumns(assistantMessageToOutputLines([
        ...longBlock,
        { type: 'text' as const, contentIndex: 1, text: 'Visible answer' },
      ]), 80)
      const window = renderPlainWithColumns(assistantMessageToOutputLines(longBlock), 80)
      expect(plain).toBe(`${window}\n\n⏺ Visible answer`)
    })

    test('ctrl+o (expanded) lifts the fold in both live and finished views', () => {
      for (const streaming of [true, false]) {
        const plain = renderPlainWithColumns(assistantMessageToOutputLines(longBlock, true, { streaming }), 80)
        expect(plain).toContain('reasoning row 1')
        expect(plain).toContain('reasoning row 20')
        expect(plain).not.toContain('ctrl+o')
        expect(plain).not.toContain('Thought')
        expect(rowsOf(plain).length).toBeGreaterThan(THINKING_FOLD_ROWS)
      }
    })

    test('both live and finished folds count visual rows after CJK wrapping and resize', () => {
      const wide = [{ type: 'thinking' as const, contentIndex: 0, text: '我们需要仔细检查每一个渲染路径的宽度计算以及换行行为'.repeat(4) }]
      for (const columns of [24, 40, 80]) {
        const live = rowsOf(renderPlainWithColumns(assistantMessageToOutputLines(wide, false, { streaming: true }), columns))
        expect(live).toHaveLength(THINKING_FOLD_ROWS)
        for (const row of live) expect(stringWidth(row)).toBeLessThanOrEqual(columns)
        const done = rowsOf(renderPlainWithColumns(assistantMessageToOutputLines(wide), columns))
        expect(done).toEqual(live)
      }
    })

    test('both views keep the row budget: at the budget nothing folds, one row over folds', () => {
      const rowsText = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join('\n\n')
      for (const streaming of [true, false]) {
        const atBudget = renderPlainWithColumns(assistantMessageToOutputLines(
          [{ type: 'thinking', contentIndex: 0, text: rowsText(THINKING_FOLD_ROWS) }], false, { streaming }), 80)
        expect(rowsOf(atBudget)).toHaveLength(THINKING_FOLD_ROWS)
        expect(atBudget).not.toContain('ctrl+o')
        const overBudget = renderPlainWithColumns(assistantMessageToOutputLines(
          [{ type: 'thinking', contentIndex: 0, text: rowsText(THINKING_FOLD_ROWS + 1) }], false, { streaming }), 80)
        expect(rowsOf(overBudget)).toHaveLength(THINKING_FOLD_ROWS)
        expect(overBudget).toContain('ctrl+o')
      }
    })

    test('a tool call landing after live reasoning keeps the reasoning window in place', () => {
      const live = renderPlainWithColumns(assistantMessageToOutputLines(longBlock, false, { streaming: true }), 80)
      const after = assistantMessageToOutputLines([
        ...longBlock,
        { type: 'tool_call', contentIndex: 1, toolCall: { id: 'c', name: 'read', args: { path: 'a' }, status: 'running' } },
      ], false, { streaming: true })
      const plain = renderPlainWithColumns(after, 80)
      expect(plain.startsWith(`${live}\n\n`)).toBe(true)
      expect(plain).toContain('◫ read')
    })

    test('real text appends below reasoning, while empty deltas leave its tail untouched', () => {
      const tight = Array.from({ length: 20 }, (_, i) => `reasoning row ${i + 1}`).join('\n')
      const heightAndRows = (text: string) => renderPlainWithColumns(assistantMessageToOutputLines([
        { type: 'thinking' as const, contentIndex: 0, text: tight },
        { type: 'text' as const, contentIndex: 1, text },
      ], false, { streaming: true }), 80).split('\n')
      const live = heightAndRows('')
      expect(live).toHaveLength(1 + THINKING_FOLD_ROWS)
      expect(live[1]).toBe('✻ ↑ 18 rows (ctrl+o)')

      expect(heightAndRows('   ')).toEqual(live)
      const one = heightAndRows('Visible')
      expect(one).toEqual([...live, '', '⏺ Visible'])

      // Growing the answer never rewrites or removes the reasoning window.
      const three = heightAndRows('Visible\n\nanswer')
      expect(three).toEqual([...live, '', '⏺ Visible', '', '  answer'])

      // From here the region only grows.
      expect(heightAndRows('Visible\n\nanswer\n\nmore').length).toBeGreaterThan(three.length)
    })

    test('earlier reasoning windows stay visible while later blocks stream', () => {
      const plain = renderPlainWithColumns(assistantMessageToOutputLines([
        { type: 'thinking' as const, contentIndex: 0, text: longText },
        { type: 'text' as const, contentIndex: 1, text: 'first' },
        { type: 'thinking' as const, contentIndex: 2, text: 'again' },
        { type: 'text' as const, contentIndex: 3, text: 'second' },
      ], false, { streaming: true }), 80)
      expect(plain).toContain('reasoning row 20')
      expect(plain.indexOf('reasoning row 20')).toBeLessThan(plain.indexOf('⏺ first'))
      expect(plain.indexOf('⏺ first')).toBeLessThan(plain.indexOf('✻ again'))
      expect(plain.indexOf('✻ again')).toBeLessThan(plain.indexOf('⏺ second'))
    })

    test('adjacent reasoning blocks retain independent windows in compact and expanded views', () => {
      const content = [
        ...longBlock,
        { type: 'thinking' as const, contentIndex: 1, text: longText.replaceAll('reasoning', 'next') },
      ]
      for (const streaming of [true, false]) {
        for (const expanded of [true, false]) {
          const plain = renderPlainWithColumns(assistantMessageToOutputLines(content, expanded, { streaming }), 80)
          expect(plain).toContain('reasoning row 20')
          expect(plain).toContain('next row 20')
          expect(rowsOf(plain).filter(row => row.startsWith('✻ '))).toHaveLength(2)
          if (expanded) {
            expect(plain).toContain('reasoning row 1\n')
            expect(plain).toContain('next row 1\n')
          } else {
            expect(rowsOf(plain)).toHaveLength(2 * THINKING_FOLD_ROWS)
          }
        }
      }
    })
  })

  test('ordered renderer preserves thinking tool text positions', () => {
    const output = assistantMessageToOutputLines([
      { type: 'thinking', contentIndex: 0, text: 'plan' },
      {
        type: 'tool_call',
        contentIndex: 1,
        toolCall: { id: 'call-1', name: 'read', args: { path: 'a' }, status: 'done' },
      },
      { type: 'text', contentIndex: 2, text: 'answer' },
    ])
    const plain = stripAnsi(blocksToLines(buildOutputBlocks(output)).join('\n'))

    expect(plain).toContain('✻ plan')
    expect(plain.indexOf('✻ plan')).toBeLessThan(plain.indexOf('read'))
    expect(plain.indexOf('read')).toBeLessThan(plain.indexOf('⏺ answer'))
  })

  test('tool card has marginTop=1', () => {
    const result = renderPlain([
      { id: 'a1', kind: 'assistant', text: 'text' },
      { id: 't1', kind: 'tool', text: '⌘ bash  ls -la' },
    ])
    const lines = result.split('\n')
    const toolIdx = lines.findIndex(l => l.includes('bash'))
    expect(lines[toolIdx - 1]).toBe('')
  })

  test('a privacy card wears the accent rail on every row; a tool card keeps a blank border cell', () => {
    const { accentHex, toolCardBg } = getTheme()
    const tool = buildOutputBlocks(buildToolCard({ id: 't', name: 'bash', args: { command: 'ls' }, status: 'running' }), { columns: 60 })
    for (const l of tool.flatMap(b => b.lines)) expect(l.spans[0]).toEqual({ text: ' ' })
    const notice = buildOutputBlocks(buildPrivacyHappeningCard({ target: 'llm', reason: 'masked SECRET ×1' }, 1), { columns: 60 })
    const rows = notice.flatMap(b => b.lines)
    // Padding rows above and below are railed too, so the slab reads as one.
    expect(rows.length).toBe(5)
    for (const l of rows) {
      expect(l.spans[0]).toEqual({ text: '┃', hex: accentHex })
      expect(l.bg).toBe(toolCardBg)
    }
    // The glyph and status keep the shared scheme: the rail is the signal.
    expect(rows[1]!.spans[2]).toMatchObject({ text: '⊘', fg: 'cyan' })
    expect(rows[2]!.spans[2]).toMatchObject({ text: '  ✓', fg: 'green' })
    // Stops and `/privacy` actions are notices as well.
    expect(buildPrivacyCard({ kind: 'blocked', target: 'request', kinds: ['API_KEY'] })[0]!.toolCard?.tone).toBe('notice')
    expect(buildPrivacyActionCard('term x', '  term added: x')[0]!.toolCard?.tone).toBe('notice')
  })

  test('jev prune card has space above it', () => {
    const result = renderPlain([
      { id: 'a1', kind: 'assistant', text: 'text' },
      ...buildEventCard('[JEV] ✂ · removed 1 · truncated 2 · 26k → 11k (−15k)'),
    ])
    const lines = result.split('\n')
    const pruneIdx = lines.findIndex(l => l.includes('jev prune'))
    // The card leads with its own padded blank row, like any tool card.
    expect(lines[pruneIdx - 1]!.trim()).toBe('')
    expect(lines[pruneIdx]).toContain('✂ jev prune  26k → 11k')
    expect(lines[pruneIdx + 1]).toContain('✓ · removed 1 · truncated 2')
  })

  test('long tool command wraps instead of truncating', () => {
    const cmd = 'cd /Users/bohu/github/evotai/evot && rg -n "first_line|before_turn|after_turn" src/ --glob "*.rs" | head -20'
    const result = renderPlainWithColumns([{ id: 't1', kind: 'tool', text: `⌘ bash  ${cmd}` }], 72)
    // No ellipsis truncation — the full command survives across wrapped lines.
    expect(result).not.toContain('…')
    expect(result.replace(/\n\s*/g, '')).toContain('head -20')
    // Continuation lines are indented to align under the arg (after `⌘ bash  `).
    const lines = result.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]!.startsWith('        ')).toBe(true)
  })

  test('long diff line wraps instead of truncating', () => {
    const longAdded = 'x'.repeat(200)
    const diff = `@@ -1,1 +1,1 @@\n-short old line\n+${longAdded}`
    const colored = colorizeUnifiedDiff(diff)
    const result = renderPlainWithColumns([{ id: 'd1', kind: 'tool', text: colored }], 40)
    // The full added content survives across wrapped lines (no truncation).
    expect(result.replace(/\n/g, '')).toContain(longAdded)
    // Every rendered line fits within the terminal width.
    for (const l of result.split('\n')) {
      expect(stringWidth(l)).toBeLessThanOrEqual(40)
    }
  })

  test('tool detail lines have no margin', () => {
    const result = renderPlain([
      { id: 't1', kind: 'tool', text: '⌘ bash  ls -la' },
      { id: 't2', kind: 'tool_result', text: '  output' },
    ])
    const lines = result.split('\n')
    const detailIdx = lines.findIndex(l => l.includes('output'))
    expect(lines[detailIdx - 1]).toContain('bash')
  })

  test('verbose badge has marginTop=1', () => {
    const result = renderPlain([
      { id: 'a1', kind: 'assistant', text: 'text' },
      { id: 'v1', kind: 'verbose', text: '[LLM] ● · started model=gpt-4' },
    ])
    const lines = result.split('\n')
    const verboseIdx = lines.findIndex(l => l.includes('LLM'))
    expect(lines[verboseIdx - 1]).toBe('')
  })

  test('verbose status colors are unified', () => {
    const result = render([
      { id: 'v1', kind: 'verbose', text: '[COMPACT] ● · 1 msgs' },
      { id: 'v2', kind: 'verbose', text: '[COMPACT] ✓ · skipped · within budget' },
      { id: 'v3', kind: 'verbose', text: '[LLM] ✓ · gpt-5.5 · turn 1 · 3.1s' },
    ])
    expect(result).toContain('\x1b[36m')
    expect(result).not.toContain('\x1b[32m')
    expect(result).not.toContain('\x1b[31m')
  })

  test('tool card glyph uses unified color', () => {
    const result = render([{ id: 't1', kind: 'tool', text: '⌘ bash  ls -la' }])
    expect(result).toContain('\x1b[36m')
    expect(result).not.toContain('\x1b[32m')
  })

  test('tool queued and running marks use cyan', () => {
    const result = render([
      { id: 'queued', kind: 'tool', text: '  ○ · preparing arguments' },
      { id: 'running', kind: 'tool', text: '  ● · running' },
    ])
    expect(result.match(/\x1b\[36m/g)).toHaveLength(2)
  })

  test('tool status line ok mark uses green', () => {
    const result = render([{ id: 't1', kind: 'tool', text: '  ✓ · 1.2s' }])
    expect(result).toContain('\x1b[32m')
  })

  test('tool status line fail mark uses the themed error ink, not ANSI red', () => {
    const result = render([{ id: 't1', kind: 'tool', text: '  ✗ · exit 1' }])
    expect(result).toContain(chalk.hex(getTheme().errorHex)('  ✗'))
    expect(result).not.toContain('\x1b[31m')
    // The metadata after the mark stays muted; the mark alone carries failure.
    expect(result).toContain(chalk.hex(getTheme().mutedHex)(' · exit 1'))
  })

  test('tool status line retry mark uses yellow', () => {
    const result = render([{ id: 't1', kind: 'tool', text: '  ↻ · retrying' }])
    expect(result).toContain('\x1b[33m')
  })

  test('JSON result body is not dimmed', () => {
    const result = render([{ id: 'r1', kind: 'tool_result', text: '  {"status":"ok"}' }])
    expect(result).not.toContain('\x1b[2m')
  })

  test('continuation spacer keeps assistant marker from repeating', () => {
    const result = renderPlain([
      { id: 'a1', kind: 'assistant', text: 'Intro' },
      { id: 'sep', kind: 'assistant', text: '', isContinuationSpacer: true },
      { id: 'a2', kind: 'assistant', text: 'Long paragraph' },
    ])

    expect(result).toContain('⏺ Intro\n\n  Long paragraph')
    expect(result).not.toContain('⏺ Long paragraph')
  })

  test('long assistant line reflows on resize instead of truncating', () => {
    const longText = 'reflow '.repeat(30).trim()
    // Committed assistant text must wrap to the current render width (prefix
    // is 2 cols) so a terminal shrink reflows rather than truncates.
    const result = renderPlainWithColumns([{ id: 'a1', kind: 'assistant', text: longText }], 40)
    for (const l of result.split('\n')) {
      expect(stringWidth(l)).toBeLessThanOrEqual(40)
    }
    // Full content survives across wrapped lines.
    expect(result.replace(/\n\s*/g, ' ')).toContain(longText)
    // Continuation lines align under the text (2-space indent).
    const lines = result.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]!.startsWith('  ')).toBe(true)
  })

  test('box-drawing table rows are not reflowed on resize (no torn borders)', () => {
    // A table rendered wide, then re-rendered at a narrow width. Border rows
    // must stay intact (clipped by the renderer, never word-wrapped) — wrapping
    // a border line mid-cell shatters the grid. Matches the markdown wrapper's
    // box-drawing guard and pi, which never re-wraps structural block art.
    const boxRows = [
      '┌───────┬──────────┬──────────┐',
      '│ 类别  │ 池子总量 │ 实际训练 │',
      '├───────┼──────────┼──────────┤',
      '│ count │ 8        │ 15 步    │',
      '└───────┴──────────┴──────────┘',
    ]
    const lines: OutputLine[] = boxRows.map((text, i) => ({
      id: `box${i}`, kind: 'assistant' as const, text, rawMarkdown: '',
    }))
    // Narrow terminal (30 cols) — each box row is wider than that.
    const result = renderPlainWithColumns(lines, 30)
    // No continuation fragment: a torn border shows up as a 2-space-indented
    // line beginning with a horizontal-rule run (mid-border split).
    const fragments = result.split('\n').filter(l => /^  ─{2,}/.test(l))
    expect(fragments).toEqual([])
    // Every rendered box row still begins with a corner/edge glyph.
    const rendered = result.split('\n').filter(l => /[┌│├└]/.test(l))
    expect(rendered.length).toBe(boxRows.length)
    for (const l of rendered) expect(/^(⏺ |  )[┌│├└]/.test(l)).toBe(true)
  })

  test('long system and verbose lines wrap within terminal width', () => {
    const columns = 32
    const result = renderWithColumns([
      { id: 'system-long', kind: 'system', text: `  ${'system detail '.repeat(12)}` },
      { id: 'verbose-long', kind: 'verbose', text: `[LLM] ● ${'provider detail '.repeat(12)}` },
    ], columns)

    for (const line of stripAnsi(result).split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  test('system notices have a blank row after conversation output', () => {
    for (const prevKind of ['assistant', 'thinking', 'tool', 'tool_result', 'user', 'error']) {
      const blocks = buildOutputBlocks([
        { id: 'sys-upd', kind: 'system', text: '  checking for updates...' },
      ], { prevKind, columns: 80 })
      expect(blocksToLines(blocks).map(stripAnsi)).toEqual(['', '  checking for updates...'])
    }
  })

  test('consecutive system notices stay compact, including incremental renders', () => {
    const assistant: OutputLine = { id: 'a1', kind: 'assistant', text: 'The release is published after a successful build.' }
    const notices: OutputLine[] = [
      { id: 'sys-upd', kind: 'system', text: '  checking for updates...' },
      { id: 'sys-upd-ok', kind: 'system', text: '  ✓ evot is up to date.' },
    ]
    const whole = blocksToLines(buildOutputBlocks([assistant, ...notices], { columns: 80 }))
    const incremental = [
      ...blocksToLines(buildOutputBlocks([assistant], { columns: 80 })),
      ...blocksToLines(buildOutputBlocks(notices.slice(0, 1), { prevKind: 'assistant', columns: 80 })),
      ...blocksToLines(buildOutputBlocks(notices.slice(1), { prevKind: 'system', columns: 80 })),
    ]
    expect(incremental).toEqual(whole)
    expect(whole.map(stripAnsi)).toEqual([
      '', '⏺ The release is published after a successful build.', '',
      '  checking for updates...', '  ✓ evot is up to date.',
    ])
  })

  test('system output does not gain redundant leading whitespace', () => {
    const notice: OutputLine = { id: 's1', kind: 'system', text: '  some info' }
    expect(renderPlain([notice])).toBe('  some info')
    for (const columns of [undefined, 40]) {
      for (const text of ['', '\n  Skills', chalk.gray('  ') + '\n  Skills']) {
        const blocks = buildOutputBlocks([
          { ...notice, text, preStyled: true },
        ], { prevKind: 'assistant', columns })
        expect(blocks[0]?.marginTop ?? 0).toBe(0)
      }
    }
  })

  test('system lines are dim', () => {
    const result = render([{ id: 's1', kind: 'system', text: '  some info' }])
    expect(result).toContain('\x1b[38;2;119;119;119m')
  })

  test('pre-styled system lines keep their own colours', () => {
    // `/skill` paints its own hierarchy. Re-tinting the whole line would flatten
    // it back to the single gray this flag exists to escape.
    const styled = `  ${chalk.hex('#b5bcf9').bold('Skills')}  ${chalk.hex('#777777')('3 units')}`
    const result = render([{ id: 's1', kind: 'system', text: styled, preStyled: true }])
    expect(result).toContain('\x1b[38;2;181;188;249m')
    expect(stripAnsi(result)).toBe('  Skills  3 units')
  })

  test('pre-styled system lines still wrap to the terminal width', () => {
    const styled = chalk.hex('#777777')(`  ${'member-name '.repeat(20)}`)
    const rendered = renderWithColumns([{ id: 's1', kind: 'system', text: styled, preStyled: true }], 40)
    for (const row of rendered.split('\n')) {
      expect(stringWidth(row)).toBeLessThanOrEqual(40)
    }
  })

  test('interrupted lines are yellow and not dim', () => {
    const result = render([{ id: 'interrupted', kind: 'cancelled', text: '  Interrupted.' }])
    expect(result).toContain('\x1b[33m')
    expect(result).not.toContain('\x1b[38;2;119;119;119m')
  })

  test('error body rows carry no colour at all', () => {
    // Failure ink belongs to the status glyph; the reason reads as plain text.
    const result = render([{ id: 'e1', kind: 'error', text: '  something broke' }])
    expect(result).toBe('  something broke')
  })

  test('a standalone Error row becomes a themed ✗ mark with a plain message', () => {
    const result = render([{ id: 'e1', kind: 'error', text: 'Error: connection interrupted' }])
    expect(result).toBe(`${chalk.hex(getTheme().errorHex)('✗ ')}connection interrupted`)
    expect(result).not.toContain('\x1b[31m')
    expect(stripAnsi(result)).not.toContain('Error:')
  })

  test('a wrapped standalone Error row hangs continuations under the message', () => {
    const msg = `Error: ${'word '.repeat(30).trim()}`
    const result = renderPlainWithColumns([{ id: 'e1', kind: 'error', text: msg }], 40)
    const lines = result.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]!.startsWith('✗ word')).toBe(true)
    for (const l of lines.slice(1)) expect(l.startsWith('  word')).toBe(true)
  })

  test('long error wraps instead of truncating', () => {
    const msg = '  rate_limit_error: You have reached your usage limit for this period. Your quota will be refreshed in the next period. Upgrade to get more at the console.'
    const result = renderPlainWithColumns([{ id: 'e1', kind: 'error', text: msg }], 72)
    expect(result).not.toContain('…')
    expect(result.replace(/\n\s*/g, '')).toContain('console.')
    const lines = result.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    // Wrapped continuations keep the 2-space indent.
    expect(lines[1]!.startsWith('  ')).toBe(true)
  })

  test('user message wraps when columns is provided', () => {
    // 20 columns minus rail+gap (2) and right pad (1) = 17 chars per line
    const longText = 'a'.repeat(40)
    const result = renderPlainWithColumns([{ id: 'u1', kind: 'user', text: longText }], 20)
    const lines = contentRows(result)
    // Should wrap into 3 lines: 17 + 17 + 6
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe('┃ ' + 'a'.repeat(17))
    expect(lines[1]).toBe('┃ ' + 'a'.repeat(17))
    expect(lines[2]).toBe('┃ ' + 'a'.repeat(6))
  })

  test('user message wraps CJK characters correctly', () => {
    // Each CJK char is 2 columns wide. With 23 columns, avail = 20.
    // Each char takes 2 cols, so 10 chars per line.
    const cjkText = '你'.repeat(25)
    const result = renderPlainWithColumns([{ id: 'u1', kind: 'user', text: cjkText }], 23)
    const lines = contentRows(result)
    // 25 chars at 2-width each = 50 cols, avail = 20, so 10 chars/line => 3 lines
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe('┃ ' + '你'.repeat(10))
    expect(lines[1]).toBe('┃ ' + '你'.repeat(10))
    expect(lines[2]).toBe('┃ ' + '你'.repeat(5))
  })
})

describe('tool cards: lifecycle-tinted slabs', () => {
  const call = (status: 'queued' | 'running' | 'done' | 'error', extra: Record<string, unknown> = {}) => ({
    id: 't1',
    name: 'bash',
    args: { command: 'ls' },
    status,
    ...extra,
  }) as Parameters<typeof buildToolCard>[0]

  test('every card is one full-width slab with blank padded rows top and bottom', () => {
    const rows = renderWithColumns(buildToolCard(call('done', { result: 'a\nb\nc', durationMs: 3 })), 40).split('\n')
    expect(rows[0]).toBe('')
    const body = rows.slice(1)
    const fill = bgOpen(getTheme().toolCardBg)
    expect(stripAnsi(body[0]!).trim()).toBe('')
    expect(stripAnsi(body[body.length - 1]!).trim()).toBe('')
    for (const row of body) {
      expect(row.startsWith(fill)).toBe(true)
      expect(stringWidth(stripAnsi(row))).toBe(40)
    }
    // pi's Box: the border cell stays blank so card content sits on the same
    // column as the rail-led user text. No rail glyph on tool cards.
    expect(stripAnsi(body[1]!).startsWith('  ⌘ bash')).toBe(true)
    // Headline, status row (which carries the fold), nothing else.
    expect(stripAnsi(body[2]!)).toMatch(/3 lines .*\(ctrl\+o\)/)
    expect(body).toHaveLength(4)
    expect(stripAnsi(rows.join('\n'))).not.toContain('┃')
  })

  test('every lifecycle state shares one neutral fill; the glyph carries the outcome', () => {
    const theme = getTheme()
    const fill = bgOpen(theme.toolCardBg)
    for (const card of [
      buildToolCard(call('queued')),
      buildToolCard(call('running')),
      buildToolCard(call('done', { result: 'ok' })),
      buildToolCard(call('error', { result: 'boom' })),
      buildToolCard(call('done', { result: 'x', details: { exit_code: 1 } })),
    ]) {
      expect(render(card)).toContain(fill)
    }
    expect(stripAnsi(render(buildToolCard(call('done', { result: 'ok' }))))).toContain('✓')
    expect(stripAnsi(render(buildToolCard(call('error', { result: 'boom' }))))).toContain('✗')
  })

  test('the tool fill is distinct from the user panel', () => {
    const theme = getTheme()
    expect(theme.toolCardBg).not.toBe(theme.panelBg)
  })

  test('the fill survives a failed card and only the mark is red', () => {
    const rows = renderWithColumns(buildToolCard(call('error', { result: 'not found' })), 40).split('\n').slice(1)
    const fill = bgOpen(getTheme().toolCardBg)
    const bodyRow = rows.find(r => stripAnsi(r).includes('not found'))!
    expect(bodyRow.startsWith(fill)).toBe(true)
    expect(bodyRow).toContain(chalk.hex(getTheme().errorHex)('  ✗'))
    expect(bodyRow).not.toContain('\x1b[31m')
    // Padding rows share the card fill, so the slab has no seam.
    expect(rows[0]!.startsWith(fill)).toBe(true)
    expect(rows[rows.length - 1]!.startsWith(fill)).toBe(true)
  })

  test('diff rows inside a card swap the fill for the add/remove tints', () => {
    const theme = getTheme()
    const rows = renderWithColumns(buildToolCard({
      id: 'e1',
      name: 'edit',
      args: { path: 'a.ts' },
      status: 'done',
      result: 'ok',
      details: { diff: '@@ -1,3 +1,3 @@\n ctx\n-old\n+new' },
    } as Parameters<typeof buildToolCard>[0]), 40).split('\n')
    const added = rows.find(r => /^\s*\d+ new\s*$/.test(stripAnsi(r)))!
    const removed = rows.find(r => /^\s*\d+ old\s*$/.test(stripAnsi(r)))!
    const context = rows.find(r => stripAnsi(r).includes(' ctx'))!
    expect(added.startsWith(bgOpen(theme.diffAddedBg))).toBe(true)
    expect(removed.startsWith(bgOpen(theme.diffRemovedBg))).toBe(true)
    expect(context.startsWith(bgOpen(theme.toolCardBg))).toBe(true)
    for (const row of [added, removed, context]) expect(stringWidth(stripAnsi(row))).toBe(40)
  })

  test('completed writes replace retained content with one authoritative diff', () => {
    for (const name of ['write', 'file_write']) {
      for (const expanded of [false, true]) {
        for (const created of [false, true]) {
          const diff = created ? '@@ -0,0 +1 @@\n+new' : '@@ -1 +1 @@\n-old\n+new'
          const call = {
            id: `write-diff-${name}-${expanded}-${created}`, name,
            args: { path: 'a.txt', content: 'new\n' }, status: 'done' as const,
            result: 'Wrote 4 bytes to a.txt', details: { created, bytes: 4, diff },
          }
          const card = buildToolCard(call, expanded)
          expect(card.filter(row => row.diffText === diff)).toHaveLength(1)
          const rows = renderWithColumns(card, 40).split('\n')
          const added = rows.find(row => /^\s*1 new\s*$/.test(stripAnsi(row))) ?? ''
          expect(added.startsWith(bgOpen(getTheme().diffAddedBg))).toBe(true)
          if (!created) {
            const removed = rows.find(row => /^\s*1 old\s*$/.test(stripAnsi(row))) ?? ''
            expect(removed.startsWith(bgOpen(getTheme().diffRemovedBg))).toBe(true)
          }
          for (const failed of [
            { ...call, status: 'error' as const },
            { ...call, details: { ...call.details, error: true } },
          ]) {
            // A failed call keeps the streamed body but never claims the
            // engine's authoritative diff.
            expect(buildToolCard(failed, expanded).some(row => row.diffText === diff)).toBe(false)
          }
        }
      }
    }
  })

  test('streamed write bodies are additions diffs from the first delta', () => {
    for (const name of ['write', 'file_write']) {
      const call = {
        id: `write-stream-${name}`, name, status: 'queued' as const, argsComplete: false,
        args: { path: 'a.py', content: 'import calc\n\ndef test_add():\n' },
      }
      const card = buildToolCard(call)
      expect(card.map(row => row.diffText).filter(Boolean)).toEqual(['@@ -0,0 +1,3 @@\n+import calc\n+\n+def test_add():'])
      expect(card.map(row => row.text).join('\n')).toContain('import calc')

      // Model-supplied terminal controls never reach the diff rows.
      const injected = buildToolCard({
        ...call,
        id: `write-controls-${name}`,
        args: { path: 'a.txt', content: 'safe\x1b]133;A\x07visible' },
      })
      const text = injected.map(row => row.text).join('\n') + injected.map(row => row.diffText).join('\n')
      expect(text).toContain('safe\ufffd]133;A\ufffdvisible')
      expect(text).not.toContain('\x07')
      expect(text).not.toContain('\x1b]133')
    }
  })

  test('a settling write appends below its body instead of pushing it down', () => {
    for (const name of ['write', 'file_write']) {
      const content = 'import calc\n\ndef test_add():\n'
      const diff = '@@ -0,0 +1,3 @@\n+import calc\n+\n+def test_add():'
      const args = { path: 'a.py', content }
      const frames = [
        { id: `settle-${name}`, name, args, status: 'queued' as const, argsComplete: true },
        { id: `settle-${name}`, name, args, status: 'running' as const },
        {
          id: `settle-${name}`, name, args, status: 'done' as const,
          result: 'Wrote 28 bytes to a.py', details: { created: true, bytes: 28, diff },
        },
      ]
      // The renderer only appends to native scrollback, so a row that has been
      // painted can never move. Every frame must keep the body rows at the same
      // index, with all mutable metadata strictly below them.
      const bodyRows = ['1 import calc', '2', '3 def test_add():']
      for (const frame of frames) {
        const rows = contentRows(renderPlainWithColumns(buildToolCard(frame), 60))
        const body = rows.map(row => row.trim()).slice(1, 1 + bodyRows.length)
        expect(body).toEqual(bodyRows)
        const status = rows.findIndex(row => /[○●✓✗] ·/.test(row))
        expect(status).toBe(1 + bodyRows.length)
      }
    }
  })

  test('diffs render in full, as the block the engine sent', () => {
    const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i}`)].join('\n')
    const call = {
      id: 'full-diff', name: 'edit', args: { path: 'a.ts' }, status: 'done' as const,
      result: 'Updated a.ts.', details: { diff: patch },
    }
    for (const expanded of [false, true]) {
      const card = buildToolCard(call, expanded)
      expect(card.filter(row => row.diffText === patch)).toHaveLength(1)
      const text = card.map(row => row.text).join('\n')
      expect(text).toContain('+line 0')
      expect(text).toContain('+line 39')
      expect(text).not.toContain('ctrl+o to expand')
    }
  })

  test('expanding keeps the card on the same fill, only the body grows', () => {
    const c = call('done', { result: 'a\nb\nc', durationMs: 3 })
    const fill = bgOpen(getTheme().toolCardBg)
    const collapsed = renderWithColumns(buildToolCard(c, false), 40)
    const expandedView = renderWithColumns(buildToolCard(c, true), 40)
    expect(collapsed).toContain(fill)
    expect(expandedView).toContain(fill)
    expect(expandedView.split('\n').length).toBeGreaterThan(collapsed.split('\n').length)
  })

  test('consecutive cards stay separate slabs with a margin between them', () => {
    const rows = renderPlainWithColumns([
      ...buildToolCard(call('done', { result: 'ok' })),
      ...buildToolCard({ ...call('done', { result: 'ok' }), id: 't2' } as Parameters<typeof buildToolCard>[0]),
    ], 30).split('\n')
    // margin, pad, head, status, pad, margin, pad, head, status, pad
    const margins = rows.map((r, i) => (r === '' ? i : -1)).filter(i => i >= 0)
    expect(margins).toEqual([0, 5])
    expect(rows).toHaveLength(10)
  })

  test('a card after a retained thought opens with its own margin and pad', () => {
    const rows = renderPlainWithColumns([
      { id: 'th', kind: 'thinking', text: 'plan', thinkingFold: 'tail' } as OutputLine,
      ...buildToolCard(call('done', { result: 'ok' })),
    ], 30).split('\n')
    expect(rows).toContain('✻ plan')
    const head = rows.findIndex(r => r.includes('⌘ bash'))
    expect(rows[head - 1]).toBe(' '.repeat(30))
    expect(rows[head - 2]).toBe('')
  })

  test('bare tool lines without card membership keep the unfilled layout', () => {
    const ansi = renderWithColumns([{ id: 't1', kind: 'tool', text: '⌘ bash  ls -la' }], 40)
    expect(ansi).not.toContain('\x1b[48;2;')
    expect(stripAnsi(ansi)).toContain('⌘ bash  ls -la')
  })
})

describe('paintBackground', () => {
  test('wraps the row and re-arms the fill after an embedded full reset', () => {
    const open = bgOpen('#2a2d44')
    const painted = paintBackground('a\x1b[0mb', '#2a2d44')
    expect(painted).toBe(`${open}a\x1b[0m${open}b\x1b[49m`)
  })

  test('an inner background close hands back to the row fill', () => {
    const open = bgOpen('#2a2d44')
    const painted = paintBackground(`x${bgOpen('#000000')}y\x1b[49mz`, '#2a2d44')
    expect(painted).toBe(`${open}x${bgOpen('#000000')}y${open}z\x1b[49m`)
  })
})

describe('OSC 133 semantic zone markers', () => {
  test('a user message is wrapped in one balanced zone', () => {
    const raw = render(buildUserMessage('hello there'))
    expect(raw).toContain(OSC133_ZONE_START)
    expect(raw).toContain(OSC133_ZONE_END)
    // Exactly one zone (one start, one end) for a single message.
    expect(raw.split(OSC133_ZONE_START).length - 1).toBe(1)
    expect(raw.split(OSC133_ZONE_END).length - 1).toBe(1)
    // The start marker precedes the visible text.
    expect(raw.indexOf(OSC133_ZONE_START)).toBeLessThan(raw.indexOf('hello there'))
  })

  test('a multi-line assistant message has exactly one zone spanning all lines', () => {
    const raw = render(buildAssistantLines('line one\n\nline two\n\nline three'))
    expect(raw.split(OSC133_ZONE_START).length - 1).toBe(1)
    expect(raw.split(OSC133_ZONE_END).length - 1).toBe(1)
    // Start comes before the first content, end after the last.
    expect(raw.indexOf(OSC133_ZONE_START)).toBeLessThan(raw.indexOf('line one'))
    expect(raw.indexOf('line three')).toBeLessThan(raw.indexOf(OSC133_ZONE_END))
  })

  test('markers are stripped by strip-ansi so line widths are unaffected', () => {
    const withMarkers = render(buildUserMessage('hello'))
    const plain = stripAnsi(withMarkers)
    expect(plain).not.toContain('133')
    expect(plain).toContain('┃ hello')
  })

  test('non-message kinds (tool, system) get no zone markers', () => {
    const raw = render([
      { id: 't1', kind: 'tool', text: '⌘ bash  ls' },
      { id: 's1', kind: 'system', text: 'note' },
    ])
    expect(raw).not.toContain(OSC133_ZONE_START)
    expect(raw).not.toContain(OSC133_ZONE_END)
  })

  test('consecutive user and assistant messages form separate zones', () => {
    const raw = render([
      ...buildUserMessage('question'),
      ...buildAssistantLines('answer line 1\n\nanswer line 2'),
    ])
    // Two messages => two zones.
    expect(raw.split(OSC133_ZONE_START).length - 1).toBe(2)
    expect(raw.split(OSC133_ZONE_END).length - 1).toBe(2)
  })
})
