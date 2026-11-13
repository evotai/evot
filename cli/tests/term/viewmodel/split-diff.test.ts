import { getTheme } from '../../../src/ui/theme/index.js'
import { expect, test } from 'bun:test'
import { createPatch } from 'diff'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { buildDiffLines } from '../../../src/term/viewmodel/diff.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'
import { buildOutputBlocks } from '../../../src/term/viewmodel/output.js'
import { buildToolCard } from '../../../src/render/output.js'

const render = (old: string, next: string, width: number) => blocksToLines([{ lines: buildDiffLines(createPatch('test.rs', old, next), width) }]).map(stripAnsi)

test('wide diff pairs old and new lines; narrow diff stays unified', () => {
  const wide = render('let a = 1;\n', 'let a = 2;\n', 140)
  const change = wide.find(text => text.includes('let a = 1;'))!
  expect(change).toContain('│')
  expect(change).toContain('let a = 2;')
  expect(wide.join('\n')).not.toContain('Before')
  expect(wide.join('\n')).not.toContain('After')
  expect(render('old\n', 'new\n', 80).join('\n')).not.toContain('│')
})

test('function headings appear once per hunk in unified and split layouts', () => {
  const patch = '@@ -8 +8 @@ async fn first() -> Result<()> {\n-old\n+new\n@@ -30 +30 @@ fn second() {\n-before\n+after'
  for (const width of [undefined, 80, 140]) {
    const styled = buildDiffLines(patch, width)
    const rows = blocksToLines([{ lines: styled }]).map(stripAnsi)
    const first = rows.findIndex(row => row.includes('async fn first()'))
    const second = rows.findIndex(row => row.includes('fn second()'))
    expect(first).toBe(0)
    expect(second).toBeGreaterThan(first)
    expect(rows.filter(row => row.includes('async fn first()'))).toHaveLength(1)
    expect(rows.filter(row => row.includes('fn second()'))).toHaveLength(1)
    expect(rows[first]).not.toContain('│')
    expect(rows[second]).not.toContain('│')
    expect(rows.some(row => row.includes('┄') || row.trim() === '…')).toBe(false)
    expect(rows[first + 1]).toContain('old')
    expect(rows[second + 1]).toContain('before')
    expect(rows[first]).toStartWith('  @@ -8,1 +8,1 @@ ')
    expect(rows[second]).toStartWith('  @@ -30,1 +30,1 @@ ')
    expect(styled[first]?.bg).toBe(getTheme().diffHeaderBg)
    expect(styled[second]?.bg).toBe(getTheme().diffHeaderBg)
  }
})

test('metadata headings never turn the real declaration into a header row', () => {
  const patch = '@@ -1,3 +1,3 @@ fn load() {\n fn load() {\n-old();\n+new();\n }'
  for (const width of [80, 140]) {
    const rows = buildDiffLines(patch, width)
    const text = blocksToLines([{ lines: rows }]).map(stripAnsi)
    expect(text[0]).toBe('  @@ -1,3 +1,3 @@ fn load() {')
    expect(rows[0]?.bg).toBe(getTheme().diffHeaderBg)
    expect(text[1]).toMatch(/^1\s+fn load\(\) \{/)
    expect(rows[1]?.bg).toBeUndefined()
    expect(rows[1]?.spans.some(span => span.hex === getTheme().diffHeaderFg)).toBe(false)
  }
})

test('long function headings wrap at the full card width without losing Unicode', () => {
  const signature = `fn load_${'中文🙂'.repeat(80)}() {`
  const patch = `@@ -8 +8 @@ ${signature}\n-old\n+new`
  for (const width of [40, 80, 140]) {
    const rows = blocksToLines([{ lines: buildDiffLines(patch, width) }]).map(stripAnsi)
    const codeIndex = rows.findIndex(row => row.includes('old'))
    expect(rows.slice(0, codeIndex).join('').trim()).toBe(`@@ -8,1 +8,1 @@ ${signature}`)
    expect(buildDiffLines(patch, width).slice(0, codeIndex).every(row => row.bg === getTheme().diffHeaderBg)).toBe(true)
    expect(rows.every(row => stringWidth(row) <= width)).toBe(true)
  }
})

test('completed edit cards retain the engine function heading', () => {
  const patch = '@@ -8 +8 @@ fn load() {\n-old\n+new'
  for (const width of [80, 150]) {
    const card = buildToolCard({ id: 'edit', name: 'edit', args: { path: 'a.rs' }, status: 'done', details: { diff: patch }, result: 'updated' })
    const blocks = buildOutputBlocks(card, { columns: width })
    const rows = blocksToLines(blocks).map(stripAnsi)
    expect(rows.filter(row => row.includes('fn load() {'))).toHaveLength(1)
    const header = blocks.flatMap(block => block.lines).find(row =>
      stripAnsi(row.spans.map(span => span.text).join('')).includes('@@ -8,1 +8,1 @@'))!
    expect(header.bg).toBe(getTheme().diffHeaderBg)
    expect(stringWidth(blocksToLines([{ lines: [header] }]).map(stripAnsi)[0]!)).toBe(width)
  }
})

test('split handles unequal changes and independent line numbers', () => {
  const lines = render('a\nb\nc\n', 'a\nx\ny\nc\n', 140)
  const context = lines.find(text => /3\s+c/.test(text))
  expect(context).toMatch(/4\s+c/)
  expect(lines.filter(text => text.includes('│')).length).toBeGreaterThan(3)
})

test('long Unicode lines wrap within their own pane without losing content', () => {
  const lines = render('old\n', '中文🙂'.repeat(90) + '\n', 140)
  expect(lines.every(text => stringWidth(text) <= 140)).toBe(true)
  expect(lines.join('').match(/🙂/g)).toHaveLength(90)
})

test('edit gutters omit rails and signs while retaining diff fills and code', () => {
  const patch = createPatch('a', 'old - value\n', 'new + value ' + 'word '.repeat(60) + '\n')
  for (const width of [80, 140]) {
    const lines = buildDiffLines(patch, width)
    const fills = lines.flatMap(row => [row.bg, ...row.spans.map(span => span.bg)])
    expect(fills).toContain(getTheme().diffRemovedBg)
    expect(fills).toContain(getTheme().diffAddedBg)
    const plain = blocksToLines([{ lines }]).map(stripAnsi)
    expect(plain.join('\n')).not.toMatch(/\d+\s+[+-]\s/)
    expect(plain.join('\n')).toContain('old - value')
    expect(plain.join('\n')).toContain('new + value')
    expect(plain.every(row => stringWidth(row) <= width)).toBe(true)
    expect(plain.join('\n')).not.toContain('▎')
  }
})

test('live and settled cards share responsive layout', () => {
  const patch = createPatch('a', 'before\n', 'after\n')
  for (const status of ['running', 'done'] as const) {
    const lines = buildToolCard({ id: 'edit', name: 'edit', args: { path: 'a' }, status, details: { diff: patch }, result: 'updated' })
    expect(blocksToLines(buildOutputBlocks(lines, { columns: 150 })).map(stripAnsi).join('\n')).toContain('│')
    expect(blocksToLines(buildOutputBlocks(lines, { columns: 80 })).map(stripAnsi).join('\n')).not.toContain('│')
  }
})

/** Two hunks far enough apart that the patch keeps them separate. */
const twoHunkPatch = () => {
  const base = Array.from({ length: 40 }, (_, index) => `line ${index}`)
  const next = [...base]
  next[2] = 'changed early'
  next[33] = 'changed late'
  return createPatch('a.ts', base.join('\n') + '\n', next.join('\n') + '\n')
}

test('skipped regions read as a rule, in both unified and split layouts', () => {
  for (const width of [80, 140]) {
    const rows = buildDiffLines(twoHunkPatch(), width).map(row => stripAnsi(row.spans.map(s => s.text).join('')))
    const rule = rows.find(row => row.includes('┄'))
    expect(rule).toBeDefined()
    // Indented like the rest of the body, and never wider than the pane.
    expect(rule!.startsWith('  ')).toBe(true)
    expect(stringWidth(rule!)).toBe(width)
    expect(rows.some(row => row.trim() === '…')).toBe(false)
  }
})

test('an unknown width falls back to the ellipsis, which needs no measure', () => {
  const rows = buildDiffLines(twoHunkPatch()).map(row => stripAnsi(row.spans.map(s => s.text).join('')))
  expect(rows.some(row => row.includes('┄'))).toBe(false)
  expect(rows.some(row => row.trim() === '…')).toBe(true)
})

test('one gutter width spans every hunk in split layout', () => {
  const rows = buildDiffLines(twoHunkPatch(), 140)
    .map(row => stripAnsi(row.spans.map(s => s.text).join('')))
    .filter(row => row.includes('│'))
  const widths = new Set(rows.map(row => row.match(/^(\s*\d+) /)?.[1]?.length))
  expect(widths.size).toBe(1)
  expect([...widths][0]).toBe(2)
})

test('diff chrome shares one recessed hue across gutter, rule, and divider', () => {
  const theme = getTheme()
  const rows = buildDiffLines(twoHunkPatch(), 140)
  const hues = rows.flatMap(row => row.spans.filter(s => s.text.includes('│') || s.text.includes('┄')).map(s => s.hex))
  expect(hues.length).toBeGreaterThan(0)
  expect(new Set(hues)).toEqual(new Set([theme.diffGutterFg]))
})

test('a new file is one column at any width: no blank left pane', () => {
  const body = Array.from({ length: 6 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n'
  const lines = render('', body, 160)
  expect(lines.join('\n')).not.toContain('│')
  for (let i = 0; i < 6; i++) expect(lines.some(text => text.includes(`export const v${i} = ${i};`))).toBe(true)
  // Code still gets the full width rather than half of it.
  const longBody = 'x'.repeat(120) + '\n'
  const wide = render('', longBody, 160)
  expect(wide.some(text => text.includes('x'.repeat(120)))).toBe(true)
})

test('single-column wrapped code stays outside the line-number gutter', () => {
  const code = '已完成 Pinecone 与 Databend Cloud 查询测试 $12,000/月。'.repeat(20)
  for (const width of [40, 80, 160]) {
    for (const removed of [false, true]) {
      const lines = render(removed ? `${code}\n` : '', removed ? '' : `${code}\n`, width)
      expect(lines.length).toBeGreaterThan(1)
      expect(lines[0]).toStartWith('1 ')
      for (const text of lines.slice(1)) expect(text).toStartWith('  ')
      for (const text of lines) expect(stringWidth(text)).toBeLessThanOrEqual(width)
      const rejoined = lines.map(text => text.slice(2)).join('').replace(/\s/g, '')
      expect(rejoined).toBe(code.replace(/\s/g, ''))
    }
  }
})

test('a deleted file is one column too', () => {
  const lines = render('gone\nall\n', '', 160)
  expect(lines.join('\n')).not.toContain('│')
  expect(lines.some(text => text.includes('gone'))).toBe(true)
})
