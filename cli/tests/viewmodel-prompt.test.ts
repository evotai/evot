import { beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import { getTheme, resetThemeCache } from '../src/render/theme/index.js'
import { visibleWidth } from '../src/render/wrap.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import { joinLeftRight, spansWidth } from '../src/term/viewmodel/width.js'
import { buildPromptBlocks, type PromptVMInput } from '../src/term/viewmodel/prompt.js'
import { buildPromptFooterBlocks } from '../src/term/viewmodel/prompt-footer.js'

beforeAll(() => { chalk.level = 3 })

function defaultInput(overrides: Partial<PromptVMInput> = {}): PromptVMInput {
  return {
    lines: [''],
    cursorLine: 0,
    cursorCol: 0,
    active: true,
    completion: null,
    ghostHint: '',
    columns: 80,
    rows: 24,
    placeholder: true,
    model: 'claude-sonnet',
    provider: '',
    thinkingLevel: '',
    planning: false,
    logMode: false,
    dashboardUrl: null,
    exitHint: false,
    cwd: '/Users/test/project',
    gitBranch: 'main',
    contextTokens: 0,
    contextWindow: 0,
    backgroundProcessCount: 0,
    backgroundPanelDownAvailable: false,
    ...overrides,
  }
}

function render(input: PromptVMInput): string {
  return blocksToLines(buildPromptBlocks(input)).join('\n')
}

function renderPlain(input: PromptVMInput): string {
  return stripAnsi(render(input)).replaceAll(CURSOR_MARKER, '')
}

function renderLines(input: PromptVMInput): string[] {
  return blocksToLines(buildPromptBlocks(input))
}

const isRule = (row: string) => /^─/.test(stripAnsi(row))

/** Rows that belong to the input frame: both rules and everything between. */
function frameLines(input: PromptVMInput): string[] {
  const rows = renderLines(input)
  const first = rows.findIndex(isRule)
  const last = rows.findLastIndex(isRule)
  return first < 0 ? [] : rows.slice(first, last + 1)
}

/** Content rows between the rules, rules excluded. */
function interiorRows(input: PromptVMInput): string[] {
  return frameLines(input).filter(row => !isRule(row))
}

const isBlankRow = (row: string) => stripAnsi(row).trim() === ''

function menuOf(count: number, selectedIndex: number) {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      label: `/cmd${index}`,
      value: `/cmd${index} `,
      description: `does thing ${index}`,
    })),
    selectedIndex,
    replaceStart: 0,
    replaceEnd: 3,
  }
}

/** Candidate labels currently inside the completion viewport, in order. */
function visibleCandidates(input: PromptVMInput): string[] {
  return renderLines(input).flatMap(row => {
    const match = /(\/cmd\d+)/.exec(stripAnsi(row))
    return match ? [match[1]!] : []
  })
}

function completion(labels: string[], selectedIndex = 0) {
  return {
    items: labels.map(label => ({ label, value: `${label} `, description: `Description for ${label}` })),
    selectedIndex,
    replaceStart: 0,
    replaceEnd: 2,
  }
}

describe('prompt editor', () => {
  test('renders rules, caret and placeholder', () => {
    const ansi = render(defaultInput())
    const plain = stripAnsi(ansi).replaceAll(CURSOR_MARKER, '')
    expect(plain.split('\n').filter(row => row === '─'.repeat(80))).toHaveLength(2)
    expect(plain).not.toContain('▍')
    expect(plain).toContain('❭ Enter a coding task or / for commands')
    expect(ansi).toContain(CURSOR_MARKER)
  })

  test('rules take the subtle structural tone; only the caret carries the brand colour', () => {
    const previousTheme = process.env.EVOT_THEME
    try {
      for (const [scheme, brand, subtle] of [['dark', '#b5bcf9', '#4a4a4a'], ['light', '#5769f7', '#b8b8b8']] as const) {
        process.env.EVOT_THEME = scheme
        resetThemeCache()
        const lines = render(defaultInput()).split('\n')
        // Rules are separators: they recede so the transcript and the draft lead.
        expect(lines.filter(line => line === chalk.hex(subtle)('─'.repeat(80)))).toHaveLength(2)
        // The caret is where you type, so it is the one brand-coloured mark.
        expect(lines.some(line => line.startsWith(chalk.hex(brand)('❭ ')))).toBe(true)
        expect(lines.some(line => line.includes(chalk.hex(brand)('─'.repeat(80))))).toBe(false)
      }
    } finally {
      if (previousTheme === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = previousTheme
      resetThemeCache()
    }
  })

  test('renders input and known command styling', () => {
    const input = defaultInput({ lines: ['/plan remove unwraps'], cursorCol: 5, placeholder: false })
    // The cursor is mid-line, so the character it sits on becomes a block; the
    // rest of the text is contiguous.
    expect(renderPlain(input)).toContain('/plan remove unwraps')
    // Known commands share the frame's brand hue rather than a fixed ANSI cyan.
    expect(render(input)).toContain(chalk.bold(chalk.hex('#b5bcf9')('/plan')))
  })

  test('does not style unknown slash text as a command', () => {
    const ansi = render(defaultInput({ lines: ['/unknown text'], cursorCol: 8, placeholder: false }))
    expect(ansi).not.toContain(chalk.bold(chalk.hex('#b5bcf9')('/unknown')))
  })

  test('wraps ASCII and CJK input within terminal width', () => {
    for (const text of ['a'.repeat(50), '改进不过测试一定要在目录']) {
      const plain = renderPlain(defaultInput({ columns: 20, lines: [text], cursorCol: text.length, placeholder: false }))
      for (const row of plain.split('\n')) expect(stringWidth(row)).toBeLessThanOrEqual(20)
    }
  })

  test('puts an end caret on a fresh row when the previous row is full', () => {
    // At 20 columns the frame degrades, so text gets all 20: a 20-character
    // draft fills the row exactly and the caret has to wrap.
    const ansi = render(defaultInput({ columns: 20, lines: ['a'.repeat(20)], cursorCol: 20, placeholder: false }))
    const rows = stripAnsi(ansi).split('\n')
    expect(rows).toContain('a'.repeat(20))
    expect(rows[rows.indexOf('a'.repeat(20)) + 1]).toBe(CURSOR_MARKER)
  })

  test('keeps the cursor on an empty line after a newline', () => {
    const rows = interiorRows(defaultInput({ columns: 60, lines: ['first line:', ''], cursorLine: 1, cursorCol: 0, placeholder: false }))
    const caretRow = rows.findIndex(row => row.includes(CURSOR_MARKER))
    expect(caretRow).toBeGreaterThan(rows.findIndex(row => stripAnsi(row).includes('first line:')))
    expect(stripAnsi(rows[caretRow]!)).toBe(`  ${CURSOR_MARKER}`)
  })

  test('limits long input to 30 percent of terminal rows and follows the cursor', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
    const plain = renderPlain(defaultInput({
      lines,
      cursorLine: 11,
      cursorCol: lines[11]!.length,
      rows: 20,
      placeholder: false,
    }))
    expect(plain).toContain('↑ 6 lines')
    expect(plain).not.toContain('line 1\n')
    expect(plain).toContain('line 12')
  })

  test('shows lines below when the cursor is near the top', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `row ${index + 1}`)
    const plain = renderPlain(defaultInput({ lines, cursorLine: 0, cursorCol: 0, rows: 20, placeholder: false }))
    expect(plain).toContain('↓ 4 lines')
    expect(plain).toContain('row 1')
    expect(plain).not.toContain('row 10')
  })

  test('places the cursor before the ghost without adding a display cell', () => {
    const ansi = render(defaultInput({ lines: ['/ha'], cursorCol: 3, placeholder: false, ghostHint: 'rden  [plan changes arch <subject>]' }))
    expect(stripAnsi(ansi)).toContain(`/ha${CURSOR_MARKER}rden`)
    expect(stripAnsi(ansi).replaceAll(CURSOR_MARKER, '')).toContain('/harden')
    expect(ansi).not.toContain('▍')
    expect(ansi).not.toContain('\x1b[48;2;154;230;92m')
  })

  test('marks start, middle and end of Unicode input without changing glyph styles', () => {
    for (const text of ['输入框', 'abc', 'a👩‍💻e\u0301中']) {
      const boundaries = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
        .map(segment => segment.index).concat(text.length)
      for (const cursorCol of boundaries) {
        const ansi = render(defaultInput({ lines: [text], cursorCol, placeholder: false }))
        expect(stripAnsi(ansi)).toContain(text.slice(0, cursorCol) + CURSOR_MARKER + text.slice(cursorCol))
        expect(ansi).not.toContain('\x1b[48;2;154;230;92m')
        expect(ansi).not.toContain('▍')
      }
    }
  })

  test('marks the character boundary without highlighting it', () => {
    const input = defaultInput({ lines: ['/model '], cursorCol: 6, placeholder: false, ghostHint: '[<name>]' })
    const ansi = render(input)
    // The cursor sits on the trailing space, which becomes a block; the text
    // stays contiguous rather than being split by an inserted bar.
    expect(stripAnsi(ansi).replaceAll(CURSOR_MARKER, '')).toContain('/model [<name>]')
    expect(ansi).not.toContain('\x1b[48;2;154;230;92m')
    expect(stripAnsi(ansi)).toContain(`/model${CURSOR_MARKER} [<name>]`)
  })

  test('renders a five-row completion viewport with descriptions and position', () => {
    const plain = renderPlain(defaultInput({ completion: completion(['/a', '/b', '/c', '/d', '/e', '/f'], 5) }))
    expect(plain).not.toContain('/a')
    expect(plain).toContain('/f')
    expect(plain).toContain('Description for /f')
    expect(plain).toContain('6/6')
  })

  test('keeps completion rows within terminal width', () => {
    const plain = renderPlain(defaultInput({
      columns: 24,
      completion: completion(['/very-long-command-one', '/very-long-command-two']),
    }))
    for (const row of plain.split('\n')) expect(stringWidth(row)).toBeLessThanOrEqual(24)
  })

  test('preserves prompt spacing and attached layout', () => {
    expect(buildPromptBlocks(defaultInput())[0]!.marginTop).toBe(1)
    expect(buildPromptBlocks(defaultInput(), { attachedAbove: true })[0]!.marginTop).toBe(0)
  })


  test('shows exit hint', () => {
    expect(renderPlain(defaultInput({ exitHint: true }))).toContain('Press Ctrl+C again to exit')
  })

  test('uses fallback dimensions for non-finite terminal sizes', () => {
    const plain = renderPlain(defaultInput({ columns: Infinity, rows: Infinity }))
    expect(plain.split('\n')).toContain('─'.repeat(80))
  })
})

describe('prompt frame', () => {
  const states: [string, Partial<PromptVMInput>][] = [
    ['empty placeholder', {}],
    ['single line', { lines: ['fix the retry backoff'], cursorCol: 21, placeholder: false }],
    ['ghost hint', { lines: ['/model '], cursorCol: 7, placeholder: false, ghostHint: '[<name>]' }],
    ['completion menu', { lines: ['/cm'], cursorCol: 3, placeholder: false, completion: menuOf(6, 0) }],
    ['exit hint', { exitHint: true }],
    ['multiline overflow', {
      placeholder: false,
      rows: 20,
      lines: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`),
      cursorLine: 11,
      cursorCol: 7,
    }],
    ['CJK wrap', { placeholder: false, lines: ['帮我把输入框换成圆角盒子并让选中行铺满整行'], cursorCol: 21 }],
  ]

  test.each(states)('draws both rules at the exact terminal width: %s', (_label, overrides) => {
    for (const columns of [30, 48, 80, 120]) {
      const rules = frameLines(defaultInput({ columns, ...overrides })).filter(isRule)
      expect(rules).toHaveLength(2)
      for (const row of rules) expect(visibleWidth(row)).toBe(columns)
    }
  })

  test.each(states)('leaves no trailing blanks on unselected rows: %s', (_label, overrides) => {
    // Terminals copy a mouse selection cell by cell. Padding a plain row out
    // to the edge would only put whitespace on the clipboard.
    for (const columns of [30, 48, 80, 120]) {
      for (const row of interiorRows(defaultInput({ columns, ...overrides }))) {
        if (row.includes('\x1b[48;2;')) continue
        expect(stripAnsi(row)).toBe(stripAnsi(row).trimEnd())
      }
    }
  })

  test.each(states)('never overflows the terminal width: %s', (_label, overrides) => {
    for (const columns of [12, 20, 29, 30, 48, 80]) {
      for (const row of renderLines(defaultInput({ columns, ...overrides }))) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(columns)
      }
    }
  })

  test('draws plain rules with no vertical rails', () => {
    // A boxed editor puts `│` at both ends of every line a mouse selection
    // crosses. Rules sit on their own rows, so copying the draft stays clean.
    const plain = frameLines(defaultInput({ columns: 40 })).map(stripAnsi)
    expect(plain[0]).toBe('─'.repeat(40))
    expect(plain[plain.length - 1]).toBe('─'.repeat(40))
    for (const row of plain) {
      for (const glyph of ['│', '╭', '╮', '╰', '╯']) expect(row).not.toContain(glyph)
    }
  })

  test('leads the first draft row with a caret and indents the rest to match', () => {
    const rows = interiorRows(defaultInput({
      columns: 40,
      placeholder: false,
      lines: ['first', 'second', 'third', 'fourth'],
      cursorLine: 3,
      cursorCol: 6,
    })).map(row => stripAnsi(row).replaceAll(CURSOR_MARKER, ''))
    expect(rows[0]).toBe('❭ first')
    expect(rows.slice(1)).toEqual(['  second', '  third', '  fourth'])
  })

  test('keeps the caret width constant as the terminal grows', () => {
    // Text starts at the same column on every width, so a draft copied from
    // a narrow terminal reads the same as one copied from a wide one.
    for (const columns of [40, 60, 100, 200]) {
      const row = interiorRows(defaultInput({ columns })).map(stripAnsi).find(line => line.includes(CURSOR_MARKER))
      expect(row!.startsWith(`❭ ${CURSOR_MARKER}`)).toBe(true)
    }
  })

  test('truncates overflowing input to the width behind the caret', () => {
    for (const columns of [40, 60, 100]) {
      const row = interiorRows(defaultInput({
        columns,
        placeholder: false,
        lines: ['x'.repeat(columns * 2)],
        cursorCol: 0,
      })).map(row => stripAnsi(row).replaceAll(CURSOR_MARKER, '')).find(line => line.includes('x'))!
      expect(row).toBe(`❭ ${'x'.repeat(columns - 2)}`)
    }
  })

  test('gives the full width back to content once degraded', () => {
    // No caret column below the threshold: the cursor leads.
    const row = stripAnsi(render(defaultInput({ columns: 29 })))
      .split('\n').find(line => line.includes(CURSOR_MARKER))
    expect(row!.startsWith(CURSOR_MARKER)).toBe(true)
  })

  test('keeps a blank-row floor under a short draft', () => {
    // Rows between the rules, rules excluded.
    const railRows = (o: Partial<PromptVMInput>) => interiorRows(defaultInput(o)).length

    expect(railRows({})).toBe(3)
    expect(railRows({ lines: ['one line'], cursorCol: 8, placeholder: false })).toBe(3)
    expect(railRows({ lines: ['a', 'b'], cursorLine: 1, cursorCol: 1, placeholder: false })).toBe(3)
    // Once the draft reaches the floor the composer grows with the content.
    expect(railRows({ lines: ['a', 'b', 'c'], cursorLine: 2, cursorCol: 1, placeholder: false })).toBe(3)
    expect(railRows({ lines: ['a', 'b', 'c', 'd'], cursorLine: 3, cursorCol: 1, placeholder: false })).toBe(4)
  })

  test('centres a one-line draft between the rules', () => {
    // Blank rows above and below the draft, rules excluded.
    const padding = (o: Partial<PromptVMInput>) => {
      const rail = interiorRows(defaultInput(o))
      const first = rail.findIndex(row => !isBlankRow(row))
      const last = rail.findLastIndex(row => !isBlankRow(row))
      return { above: first, below: rail.length - 1 - last }
    }
    // Equal blanks on both sides. This is what forces an odd interior: a
    // 2-row composer would have to put its one spare row on a single side.
    expect(padding({})).toEqual({ above: 1, below: 1 })
    expect(padding({ lines: ['one line'], cursorCol: 8, placeholder: false })).toEqual({ above: 1, below: 1 })
    // Two lines leave one spare row, which goes below.
    expect(padding({ lines: ['a', 'b'], cursorLine: 1, cursorCol: 1, placeholder: false })).toEqual({ above: 0, below: 1 })
    expect(padding({ lines: ['a', 'b', 'c'], cursorLine: 2, cursorCol: 1, placeholder: false })).toEqual({ above: 0, below: 0 })
  })

  test('drops the floor on terminals too short to spare the rows', () => {
    const railRows = (rows: number) => interiorRows(defaultInput({ rows })).length
    expect(railRows(19)).toBe(1)
    expect(railRows(20)).toBe(3)
  })

  test('lets the completion menu absorb the height instead of stacking', () => {
    // Without this the floor's blanks and the menu both apply, pushing the
    // candidates several rows away from what was typed.
    const rows = renderLines(defaultInput({
      lines: ['/cm'],
      cursorCol: 3,
      placeholder: false,
      completion: menuOf(3, 0),
    })).map(stripAnsi)
    const input = rows.findIndex(row => row.includes('/cm'))
    const firstCandidate = rows.findIndex(row => row.includes('/cmd0'))
    // Exactly one separator row between the input and the first candidate.
    expect(firstCandidate - input).toBe(2)
  })

  test('adds no bare blank rows when the frame degrades', () => {
    // The blanks only read as composer space behind a caret; without one they
    // are indistinguishable from stray whitespace.
    const rows = stripAnsi(render(defaultInput({ columns: 29 }))).split('\n')
    const caretIndex = rows.findIndex(row => row.includes(CURSOR_MARKER))
    expect(rows[caretIndex + 1]).toBe('─'.repeat(29))
  })

  test('keeps overflow markers on the frame in their existing wording', () => {
    const plain = renderPlain(defaultInput({
      placeholder: false,
      rows: 20,
      lines: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`),
      cursorLine: 11,
      cursorCol: 7,
    }))
    expect(plain).toContain('── ↑ 6 lines ─')
    expect(plain).toContain('── ↓ 8 lines ─')
  })

  test('truncates a rule label that cannot fit', () => {
    for (const row of frameLines(defaultInput({
      columns: 30,
      rows: 12,
      placeholder: false,
      lines: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`),
      cursorLine: 39,
      cursorCol: 7,
    })).filter(isRule)) {
      expect(visibleWidth(row)).toBe(30)
    }
  })

  test('drops the caret column below the minimum framed width', () => {
    const plain = renderPlain(defaultInput({ columns: 29 })).split('\n')
    expect(plain.filter(row => row === '─'.repeat(29))).toHaveLength(2)
    expect(plain.some(row => row.startsWith('❭ '))).toBe(false)
  })

  test('spends no width on the caret once degraded', () => {
    // The full 29 columns stay available to content, unlike the framed path
    // which reserves two for the caret.
    const wide = renderPlain(defaultInput({ columns: 29, placeholder: false, lines: ['a'.repeat(40)], cursorCol: 40 }))
    expect(wide).toContain('a'.repeat(27))
  })

  test('places the cursor marker behind the caret', () => {
    const row = renderLines(defaultInput({ columns: 40 })).find(line => line.includes(CURSOR_MARKER))
    expect(row).toBeDefined()
    // Everything before the marker is measurable, so the renderer can derive
    // the hardware cursor column. Only `❭ ` sits ahead of it.
    const prefix = row!.slice(0, row!.indexOf(CURSOR_MARKER))
    expect(visibleWidth(prefix)).toBe(2)
  })

  test('drops the rules entirely on a terminal too short to spare the rows', () => {
    // At 9 rows the two rule rows plus footer would leave the transcript
    // nothing, so the composer keeps only its cursor row.
    const plain = renderPlain(defaultInput({ rows: 9 })).split('\n')
    expect(plain.filter(isRule)).toEqual([])
    expect(render(defaultInput({ rows: 5 }))).toContain(CURSOR_MARKER)
  })

  test('keeps the rules down to the height where it still pays', () => {
    const plain = renderPlain(defaultInput({ rows: 10 })).split('\n')
    expect(plain.filter(isRule)).toHaveLength(2)
  })

  test('reclaims rows as the terminal shortens rather than crowding out history', () => {
    const height = (rows: number) => renderLines(defaultInput({ rows })).length
    // Each step down sheds chrome: blank filler rows first, then the border.
    expect(height(40)).toBe(8)
    expect(height(14)).toBe(6)
    expect(height(9)).toBe(4)
    // A 9-row terminal must keep most of itself for the transcript.
    expect(height(9)).toBeLessThan(9 / 2 + 1)
  })

  test('an active mode colours its label only; rules and caret keep their tones', () => {
    const { accentHex, brandHex, subtleHex } = getTheme()
    const rows = renderLines(defaultInput({ planning: true }))
    const top = rows.find(row => stripAnsi(row).includes('(plan)'))
    expect(top).toBeDefined()
    // The mode word is the one accent-coloured thing on the rule.
    expect(top).toContain(chalk.hex(accentHex)(' (plan) '))
    expect(top).not.toContain(chalk.hex(accentHex)('──'))
    // Dashes on either side stay subtle, so the whole frame does not turn yellow
    // for a fact one word already states.
    expect(top!.startsWith(chalk.hex(subtleHex)('─').slice(0, -'─\x1b[39m'.length))).toBe(true)
    // The caret stays brand-coloured in every mode.
    expect(rows.some(row => row.startsWith(chalk.hex(brandHex)('❭ ')))).toBe(true)
    expect(rows.some(row => row.startsWith(chalk.hex(accentHex)('❭ ')))).toBe(false)
  })

  test('names the mode at the right end of the top rule, not just by hue', () => {
    // Colour alone fails on monochrome terminals and for colour-blind users.
    // Right-aligned so it does not compete with the caret for where reading starts.
    const plan = renderPlain(defaultInput({ planning: true })).split('\n').find(row => row.includes('(plan)'))
    expect(plan).toBe('─'.repeat(80 - ' (plan) '.length - 1) + ' (plan) ─')
    expect(renderPlain(defaultInput({ logMode: true }))).toContain(' (log) ─')
    expect(renderPlain(defaultInput({ logMode: true, planning: true }))).toContain(' (log · plan) ─')
  })

  test('pushes an unfocused draft into the background', () => {
    const draft = { lines: ['fix the retry backoff'], cursorCol: 21, placeholder: false }
    const focused = render(defaultInput({ ...draft, active: true }))
    const blurred = render(defaultInput({ ...draft, active: false }))

    expect(blurred).not.toBe(focused)
    // The text survives; only its weight changes. `dim` paints as a muted hex
    // rather than SGR 2, so the assertion follows the renderer.
    expect(stripAnsi(blurred)).toContain('fix the retry backoff')
    expect(blurred).toContain(chalk.hex('#777777')('fix the retry backoff'))
    expect(focused).not.toContain(chalk.hex('#777777')('fix the retry backoff'))
  })

  test('drops hue and weight from an unfocused command, not just brightness', () => {
    // A bold brand-coloured command stays loud under dim alone, and that is
    // exactly the text that should recede while a modal owns the screen.
    const { brandHex } = getTheme()
    const command = { lines: ['/model'], cursorCol: 6, placeholder: false }
    expect(render(defaultInput({ ...command, active: true }))).toContain(chalk.hex(brandHex)('/model'))

    const blurred = render(defaultInput({ ...command, active: false }))
    expect(blurred).not.toContain(chalk.hex(brandHex)('/model'))
    expect(blurred).not.toContain('\x1b[1m')
    expect(stripAnsi(blurred)).toContain('/model')
  })

  test('hides the caret entirely while unfocused', () => {
    const draft = { lines: ['draft'], cursorCol: 5, placeholder: false }
    expect(render(defaultInput({ ...draft, active: true }))).toContain(CURSOR_MARKER)
    expect(render(defaultInput({ ...draft, active: false }))).not.toContain(CURSOR_MARKER)
  })

  test('puts scroll overflow at the left of the rule and the mode at the right', () => {
    const plain = renderPlain(defaultInput({
      columns: 60,
      rows: 20,
      planning: true,
      placeholder: false,
      lines: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`),
      cursorLine: 11,
      cursorCol: 7,
    }))
    const top = plain.split('\n').find(row => row.includes('↑'))
    expect(top).toMatch(/^── ↑ \d+ lines ─+ \(plan\) ─$/)
    expect(top!.length).toBe(60)
  })

  test('the placeholder follows state before mode', () => {
    const hint = (input: Partial<PromptVMInput>) =>
      interiorRows(defaultInput(input)).map(row => stripAnsi(row).replaceAll(CURSOR_MARKER, '')).find(row => row.startsWith('❭ '))
    expect(hint({})).toBe('❭ Enter a coding task or / for commands')
    expect(hint({ planning: true })).toBe('❭ Describe what to plan — no edits until you approve')
    // While a turn runs, typing steers it: say so, whatever mode the next turn starts in.
    expect(hint({ busy: true })).toBe('❭ Guide the agent while it works')
    expect(hint({ busy: true, planning: true })).toBe('❭ Guide the agent while it works')
    expect(hint({ busy: true, queuedCount: 1 })).toBe('❭ 1 message queued · Ctrl+G to manage')
    expect(hint({ busy: true, queuedCount: 2 })).toBe('❭ 2 messages queued · Ctrl+G to manage')
    // A queue with nothing running is stale state, not a prompt to manage it.
    expect(hint({ busy: false, queuedCount: 2 })).toBe('❭ Enter a coding task or / for commands')
    // Narrow terminals get the short forms.
    expect(hint({ columns: 40, busy: true })).toBe('❭ Guide while it works')
    expect(hint({ columns: 40, busy: true, queuedCount: 1 })).toBe('❭ 1 queued · Ctrl+G')
  })
})

describe('prompt completion menu', () => {
  test('fills the selected row to the right edge', () => {
    const rows = renderLines(defaultInput({
      columns: 60,
      lines: ['/cm'],
      cursorCol: 3,
      placeholder: false,
      completion: menuOf(6, 1),
    }))
    const selected = rows.find(row => stripAnsi(row).includes('/cmd1'))
    expect(selected).toBeDefined()
    // The band spans the whole row, caret indent included: nothing follows
    // the final background reset and nothing unpainted leads it.
    expect(stripAnsi(selected!.slice(selected!.lastIndexOf('\x1b[49m')))).toBe('')
    expect(visibleWidth(selected!)).toBe(60)
    expect(selected!.indexOf('\x1b[48;2;')).toBe(0)

    const unselected = rows.find(row => stripAnsi(row).includes('/cmd2'))
    expect(unselected).not.toContain('\x1b[49m')
  })

  test('uses theme-aware selection colors', () => {
    const previousTheme = process.env.EVOT_THEME
    try {
      for (const [scheme, bgHex] of [['dark', '#2c2f4a'], ['light', '#dfe3fd']] as const) {
        process.env.EVOT_THEME = scheme
        resetThemeCache()
        const rows = renderLines(defaultInput({
          lines: ['/cm'],
          cursorCol: 3,
          placeholder: false,
          completion: menuOf(3, 0),
        }))
        const selected = rows.find(row => stripAnsi(row).includes('/cmd0'))
        expect(selected).toContain(chalk.bgHex(bgHex)('').split('\x1b[49m')[0])
      }
    } finally {
      if (previousTheme === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = previousTheme
      resetThemeCache()
    }
  })

  test('keeps the selection near the middle of the viewport', () => {
    const input = (selectedIndex: number) => defaultInput({
      rows: 20,
      lines: ['/cm'],
      cursorCol: 3,
      placeholder: false,
      completion: menuOf(20, selectedIndex),
    })
    expect(visibleCandidates(input(10))).toEqual(['/cmd8', '/cmd9', '/cmd10', '/cmd11', '/cmd12'])
    // Near either end the viewport stops sliding rather than showing blanks.
    expect(visibleCandidates(input(0))).toEqual(['/cmd0', '/cmd1', '/cmd2', '/cmd3', '/cmd4'])
    expect(visibleCandidates(input(19))).toEqual(['/cmd15', '/cmd16', '/cmd17', '/cmd18', '/cmd19'])
  })

  test('shows more candidates on taller terminals', () => {
    const at = (rows: number) => visibleCandidates(defaultInput({
      rows,
      lines: ['/cm'],
      cursorCol: 3,
      placeholder: false,
      completion: menuOf(20, 0),
    })).length
    expect(at(24)).toBe(5)
    expect(at(40)).toBe(12)
  })

  test('shows the position counter only when candidates are hidden', () => {
    const hasCounter = (count: number, rows: number) => renderPlain(defaultInput({
      rows,
      lines: ['/cm'],
      cursorCol: 3,
      placeholder: false,
      completion: menuOf(count, 0),
    })).includes(`1/${count}`)
    expect(hasCounter(5, 24)).toBe(false)
    expect(hasCounter(6, 24)).toBe(true)
    expect(hasCounter(12, 40)).toBe(false)
    expect(hasCounter(13, 40)).toBe(true)
  })

  test('renders an advisory note below candidates and their counter', () => {
    const note = 'files up to 6 levels deep — install fd to search deeper'
    const lines = renderPlain(defaultInput({
      rows: 24,
      lines: ['@src'],
      cursorCol: 4,
      placeholder: false,
      completion: { ...menuOf(6, 0), note },
    })).split('\n')

    const counter = lines.findIndex(row => row.includes('1/6'))
    const advisory = lines.findIndex(row => row.includes(note))
    expect(counter).toBeGreaterThan(-1)
    expect(advisory).toBe(counter + 1)
  })

  test('renders a note-only empty result without a fake candidate', () => {
    const note = 'no matches · files up to 6 levels deep'
    const plain = renderPlain(defaultInput({
      lines: ['@deep'],
      cursorCol: 5,
      placeholder: false,
      completion: {
        items: [],
        selectedIndex: 0,
        replaceStart: 0,
        replaceEnd: 5,
        note,
      },
    }))
    expect(plain).toContain(note)
    expect(plain).not.toContain('❯')
    expect(plain).not.toMatch(/\d+\/0/)
  })

  test('truncates a completion note to the menu width', () => {
    const columns = 32
    const note = 'files up to 6 levels deep — install fd to search deeper'
    const rows = renderLines(defaultInput({
      columns,
      lines: ['@src'],
      cursorCol: 4,
      placeholder: false,
      completion: { ...menuOf(2, 0), note },
    }))
    const advisory = rows.find(row => stripAnsi(row).includes('files up to'))
    expect(advisory).toBeDefined()
    expect(stripAnsi(advisory!)).toContain('…')
    expect(visibleWidth(advisory!)).toBeLessThanOrEqual(columns)
  })

  test('keeps the file name when a completion path is wider than the label column', () => {
    const path = 'src/app/[language]/(home)/gallery/components/GalleryCard.tsx'
    const plain = renderPlain(defaultInput({
      columns: 40,
      lines: ['@GalleryCard'],
      cursorCol: 12,
      placeholder: false,
      completion: {
        items: [{ label: path, value: `@${path} ` }],
        selectedIndex: 0,
        replaceStart: 0,
        replaceEnd: 12,
      },
    }))
    expect(plain).toContain('GalleryCard.tsx')
    expect(plain).toContain('…')
    expect(plain).not.toContain('src/app/[language]')
  })

  test('gives file candidates the full row when they have no description', () => {
    const path = 'src/app/[language]/(home)/gallery/components/GalleryCard.tsx'
    const at = (columns: number) => renderPlain(defaultInput({
      columns,
      lines: ['@GalleryCard'],
      cursorCol: 12,
      placeholder: false,
      completion: {
        items: [{ label: path, value: `@${path} ` }],
        selectedIndex: 0,
        replaceStart: 0,
        replaceEnd: 12,
      },
    }))
    // 80 columns is enough for the whole path once the 45% description reserve
    // is released; 40 columns still has to keep the leaf and drop the head.
    expect(at(80)).toContain(path)
    expect(at(80)).not.toContain('…')
    expect(at(40)).toContain('GalleryCard.tsx')
    expect(at(40)).toContain('…')
  })

  test('shrinks candidates so the prompt never exceeds a short terminal', () => {
    const note = 'files up to 6 levels deep — install fd to search deeper'
    for (const rows of [5, 6, 9, 10, 12, 14]) {
      for (const backgroundProcessCount of [0, 1]) {
        const rendered = renderLines(defaultInput({
          rows,
          lines: ['@src'],
          cursorCol: 4,
          placeholder: false,
          backgroundProcessCount,
          completion: { ...menuOf(20, 0), note },
        }))
        expect(rendered.length).toBeLessThanOrEqual(rows)
      }
    }
  })

  test('budgets spinner and queue rows before choosing candidate count', () => {
    const rows = 10
    const prompt = blocksToLines(buildPromptBlocks(defaultInput({
      rows,
      lines: ['@src'],
      cursorCol: 4,
      placeholder: false,
      completion: {
        ...menuOf(20, 0),
        note: 'files up to 6 levels deep — install fd to search deeper',
      },
    }), {
      attachedAbove: true,
      reservedAboveRows: 2,
    }))
    expect(prompt.length + 2).toBeLessThanOrEqual(rows)
  })

  test('separates the input from candidates only while framed', () => {
    const blankRows = (columns: number) => interiorRows(defaultInput({
      columns,
      lines: ['/cm'],
      cursorCol: 3,
      placeholder: false,
      completion: menuOf(3, 0),
    })).filter(isBlankRow).length
    expect(blankRows(60)).toBe(1)
    expect(blankRows(29)).toBe(0)
  })
})

describe('prompt overflow guards', () => {
  test('truncates a ghost hint that is wider than the terminal', () => {
    const hint = '  [help  resume  new  model  plan  harden  skill  copy  clip  share  compact  clear]'
    for (const columns of [12, 40, 80]) {
      const input = defaultInput({ columns, lines: ['/'], cursorCol: 1, placeholder: false, ghostHint: hint })
      for (const row of renderLines(input)) expect(visibleWidth(row)).toBeLessThanOrEqual(columns)
    }
    // The hint still renders when there is room for part of it.
    expect(renderPlain(defaultInput({ columns: 40, lines: ['/'], cursorCol: 1, placeholder: false, ghostHint: hint })))
      .toContain('[help')
  })

  test('truncates the placeholder on a narrow terminal', () => {
    for (const columns of [3, 4, 20]) {
      const input = defaultInput({ columns })
      for (const row of renderLines(input)) expect(visibleWidth(row)).toBeLessThanOrEqual(columns)
    }
  })

  test('drops the commands half of the placeholder below 65 columns', () => {
    const hintRow = (columns: number) => renderPlain(defaultInput({ columns }))
      .split('\n').find(row => row.includes('Enter a coding task'))
    expect(hintRow(65)).toContain('Enter a coding task or / for commands')
    expect(hintRow(64)).toContain('Enter a coding task')
    expect(hintRow(64)).not.toContain('/ for commands')
    // The short hint fits outright, so it is never cut mid-word.
    expect(hintRow(45)).not.toContain('…')
  })

  test('truncates the exit hint on a narrow terminal', () => {
    for (const row of renderLines(defaultInput({ columns: 10, exitHint: true }))) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(10)
    }
  })

  test('measures the zero-width cursor marker as zero columns', () => {
    // `stringWidth` counts the APC marker as five columns, which would make
    // every padded row four cells short.
    expect(visibleWidth(`❯ hi${CURSOR_MARKER}x`)).toBe(5)
  })
})

describe('prompt footer', () => {
  test('renders repository state and model identity', () => {
    const plain = renderPlain(defaultInput({
      planning: true,
      logMode: true,
      provider: 'anthropic',
      thinkingLevel: 'xhigh',
      columns: 160,
    }))
    // The top rule names the modes, so the footer drops its own prefix rather
    // than repeating the same words two rows apart.
    expect(plain).toContain(' (log · plan) ─')
    expect(plain).not.toContain('[log]')
    expect(plain).not.toContain('[plan]')
    expect(plain).toContain('/Users/test/project (main)')
    expect(plain).toContain('claude-sonnet • xhigh')
    expect(plain).not.toContain('@anthropic')
  })

  test('footer keeps the mode prefix when no border carries it', () => {
    // Below the rule threshold nothing above the footer names the mode, so
    // the footer stays authoritative.
    const plain = renderPlain(defaultInput({ planning: true, logMode: true, rows: 9, columns: 160 }))
    expect(plain).not.toContain('╭')
    expect(plain).toContain('[log] [plan]')
  })

  test('footer keeps the mode prefix when asked directly, as overlays do', () => {
    // Selector and ask overlays replace the composer but keep the footer, so
    // the default must carry the mode.
    const footer = blocksToLines(buildPromptFooterBlocks(defaultInput({ planning: true, columns: 160 })))
      .map(stripAnsi)[0]!
    expect(footer).toContain('[plan]')
  })

  test('labels disabled thinking', () => {
    expect(renderPlain(defaultInput({ thinkingLevel: 'off' }))).toContain('thinking off')
  })

  test('renders context and dashboard when space allows', () => {
    const plain = renderPlain(defaultInput({
      columns: 220,
      contextTokens: 105800,
      contextWindow: 272000,
      dashboardUrl: 'http://127.0.0.1:8788',
    }))
    expect(plain).toContain('context: 38.9% (105.8k/272k)')
    expect(plain).toContain('http://127.0.0.1:8788')
    // Session token totals are call/log data, not footer state.
    expect(plain).not.toContain('↑')
    expect(plain).not.toContain('cache')
  })

  test('right-aligns the dashboard link', () => {
    const columns = 120
    const footer = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns,
      dashboardUrl: 'http://127.0.0.1:8082',
    }))).map(stripAnsi)[0]!

    expect(stringWidth(footer)).toBe(columns)
    expect(footer).toEndWith('dashboard http://127.0.0.1:8082')
  })

  test('matches the full context footer format from the terminal', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp/home'
    const footer = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 160,
      cwd: `${home}/github/evotai/evot`,
      gitBranch: 'main',
      model: 'gpt-5.6-sol',
      provider: 'anthropic',
      thinkingLevel: 'high',
      contextTokens: 105800,
      contextWindow: 272000,
    }))).map(stripAnsi)[0]!

    expect(footer).toBe('~/github/evotai/evot (main) │ gpt-5.6-sol • high │ context: 38.9% (105.8k/272k)')
  })

  test('badges the context with jev prune while the catalog publishes a judge', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp/home'
    const footer = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 160,
      cwd: `${home}/github/evotai/evot`,
      gitBranch: 'main',
      model: 'gpt-5.6-sol',
      provider: 'anthropic',
      thinkingLevel: 'high',
      contextTokens: 105800,
      contextWindow: 272000,
      judge: 'jev-latest',
    }))).map(stripAnsi)[0]!

    expect(footer).toBe('~/github/evotai/evot (main) │ gpt-5.6-sol • high │ context: 38.9% (105.8k/272k) • jev prune')
  })

  test('shows the jev prune badge before the first call, and never without a judge', () => {
    const on = blocksToLines(buildPromptFooterBlocks(defaultInput({ columns: 160, judge: 'jev-latest' }))).map(stripAnsi)[0]!
    expect(on).toContain('│ jev prune')
    const off = blocksToLines(buildPromptFooterBlocks(defaultInput({ columns: 160 }))).map(stripAnsi)[0]!
    expect(off).not.toContain('jev')
  })

  test('carries no cache segment: per-call cache usage belongs to the spinner', () => {
    const footerAt = (columns: number) => blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns,
      model: 'gpt-5.6-sol',
      provider: 'anthropic',
      thinkingLevel: 'high',
      contextTokens: 105800,
      contextWindow: 272000,
    }))).map(stripAnsi)[0]!

    for (const columns of [200, 160, 80]) {
      expect(footerAt(columns)).not.toContain('cache')
    }
    const wide = footerAt(160)
    expect(wide).toContain('context: 38.9% (105.8k/272k)')
    expect(wide).not.toContain('@anthropic')
  })

  test('the footer hides provider labels even for cloud models while the model picker retains them', () => {
    const footer = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 160, model: 'gpt-6-sol', provider: 'Evot Premium', thinkingLevel: 'high',
    }))).map(stripAnsi)[0]!
    expect(footer).toContain('gpt-6-sol • high')
    expect(footer).not.toContain('@Evot Premium')
  })

  test('compact dashboard port keeps the full clickable URL', () => {
    const address = 'http://127.0.0.1:8788'
    const blocks = buildPromptFooterBlocks(defaultInput({
      columns: 80,
      model: 'gpt-5.6-sol',
      thinkingLevel: 'max',
      dashboardUrl: address,
      contextTokens: 105800,
      contextWindow: 272000,
    }))
    const links = blocks.flatMap(block => block.lines.flatMap(row => row.spans)).filter(span => span.link)
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(':8788')
    expect(links[0]?.link).toBe(address)
  })

  test('degrades footer details in priority order as width narrows', () => {
    const footerAt = (columns: number) => blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns,
      model: 'gpt-5.6-sol',
      provider: 'anthropic',
      thinkingLevel: 'max',
      dashboardUrl: 'http://127.0.0.1:8082',
      contextTokens: 105800,
      contextWindow: 272000,
    }))).map(stripAnsi)[0]!

    const withDashboard = footerAt(119)
    expect(withDashboard).toContain('dashboard')
    expect(withDashboard).toContain('context: 38.9% (105.8k/272k)')

    const compactDashboard = footerAt(80)
    expect(compactDashboard).toEndWith('dashboard :8082')
    expect(compactDashboard).toContain('context: 38.9%')
    expect(compactDashboard).not.toContain('http://')

    const compactContext = footerAt(70)
    expect(compactContext).toContain('gpt-5.6-sol • max')
    expect(compactContext).toContain('context: 38.9%')
    expect(compactContext).not.toContain('105.8k')
    expect(compactContext).not.toContain('(main)')
    expect(compactContext).toEndWith('dashboard :8082')

    const withoutBranch = footerAt(60)
    expect(withoutBranch).not.toContain('(main)')
    expect(withoutBranch).toContain('context: 38.9%')

    const withoutContext = footerAt(40)
    expect(withoutContext).toContain('gpt-5.6-sol • max')
    expect(withoutContext).not.toContain('context:')

    for (const columns of [119, 80, 70, 60, 50, 40, 30, 20]) {
      expect(stringWidth(footerAt(columns))).toBeLessThanOrEqual(columns)
      expect(footerAt(columns)).toContain('dashboard')
    }
    expect(footerAt(10)).not.toContain('dashboard')
    expect(stringWidth(footerAt(10))).toBeLessThanOrEqual(10)
  })

  test('truncates a wide CJK cwd only after optional segments are gone', () => {
    const columns = 24
    const footer = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns,
      cwd: '/项目/非常长的中文目录名称/子目录',
      gitBranch: 'feature/very-long-branch',
      model: 'a-very-long-model-name',
      provider: 'provider',
    }))).map(stripAnsi)[0]!
    expect(stringWidth(footer)).toBeLessThanOrEqual(columns)
    expect(footer).toStartWith('…')
  })

  test('idle background stop hint shares the count row and confirmation takes priority over management', () => {
    for (const [hint, columns] of [
      ['esc twice to stop all', 100],
      ['esc again to stop all 2 tasks', 100],
      ['esc again to stop all 2 tasks', 40],
      ['Stopping…', 40],
    ] as const) {
      const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
        columns, backgroundProcessCount: 2, backgroundPanelDownAvailable: true,
        backgroundStopHint: hint,
      }))).map(stripAnsi)
      expect(lines[0]).toContain(hint)
      expect(lines[0]).toStartWith('2 ')
      expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(columns)
    }
  })

  test('footer chip advertises ↓ while the composer is empty', () => {
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 100,
      backgroundProcessCount: 2,
      backgroundPanelDownAvailable: true,
    }))).map(stripAnsi)
    expect(lines[0]).toBe('2 background shells running · ↓ to manage')
    expect(lines[1]).toContain('/Users/test/project')
    expect(lines[2]).toBe('')
  })

  test('with text in the composer the chip stays quiet instead of advertising Ctrl+T', () => {
    // ↓ still moves the caret there, so advertising it would be a lie.
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 100,
      backgroundProcessCount: 2,
      backgroundPanelDownAvailable: false,
    }))).map(stripAnsi)
    expect(lines[0]).toBe('2 background shells running')
  })

  test('a single shell reads in the singular', () => {
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 100,
      backgroundProcessCount: 1,
      backgroundPanelDownAvailable: true,
    }))).map(stripAnsi)
    expect(lines[0]).toBe('1 background shell running · ↓ to manage')
  })

  test('no chip is rendered when nothing runs in the background', () => {
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 100,
      backgroundProcessCount: 0,
    }))).map(stripAnsi)
    expect(lines[0]).toContain('/Users/test/project')
  })

  test('a narrow terminal drops the hint before the count', () => {
    // The count is the actionable part, so the gesture is what gives way. Next to
    // go is the word "background", which is context rather than information: the
    // full label is 27 wide and character-truncating it produced
    // "…ound shells running", losing the count itself.
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 20,
      backgroundProcessCount: 3,
      backgroundPanelDownAvailable: true,
    }))).map(stripAnsi)
    expect(lines[0]).toBe('3 shells running')
    expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(20)
  })

  test('a terminal wide enough for the label but not the gesture keeps the full wording', () => {
    // The rung between the two cases above: "background" only gives way once the
    // label alone no longer fits, not as soon as the hint is dropped.
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({
      columns: 30,
      backgroundProcessCount: 3,
      backgroundPanelDownAvailable: true,
    }))).map(stripAnsi)
    expect(lines[0]).toBe('3 background shells running')
    expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(30)
  })

  test('footer remains available without the editor', () => {
    const lines = blocksToLines(buildPromptFooterBlocks(defaultInput({ provider: 'openai', model: 'gpt-5.6-sol' }))).map(stripAnsi)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('gpt-5.6-sol')
    expect(lines[0]).not.toContain('@openai')
    expect(lines[1]).toBe('')
    expect(lines.join('\n')).not.toContain('Enter a coding task or / for commands')
  })
})

describe('joinLeftRight', () => {
  test('right-aligns the trailing spans on one row', () => {
    const left = [{ text: '* Waiting for model… (7.5s) · esc to interrupt' }]
    const right = [{ text: '⬇ Auto-updating to v2026.8.26.2…' }]
    const columns = 120
    const joined = joinLeftRight(left, right, columns)
    expect(spansWidth(joined)).toBe(columns)
    expect(joined.map(span => span.text).join('')).toEndWith('⬇ Auto-updating to v2026.8.26.2…')
    expect(joined[1]!.text.startsWith(' ')).toBe(true)
  })

  test('keeps a one-column gap when the two sides collide', () => {
    const joined = joinLeftRight([{ text: 'left' }], [{ text: 'right' }], 8)
    expect(joined.map(span => span.text).join('')).toBe('left right')
  })
})
