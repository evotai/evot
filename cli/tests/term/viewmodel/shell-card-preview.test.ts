import { expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { buildToolCard } from '../../../src/render/output.js'
import { buildOutputBlocks } from '../../../src/term/viewmodel/output.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'

test('background commands use the full result command and dim header styling', () => {
  const command = 'bun test ' + 'some-long-test.ts '.repeat(30)
  const card = (expanded = false) => buildToolCard({ id: 't', name: 'task_output', args: { task_id: 'id' }, status: 'done', previewCommand: 'bun t…', details: { command, status: 'completed' } }, expanded)
  const blocks = buildOutputBlocks(card(), { columns: 100 })
  const text = blocksToLines(blocks).map(stripAnsi)
  expect(text.join('\n')).toContain('some-long-test.ts')
  expect(text.every(row => stringWidth(row) <= 100)).toBe(true)
  const commandRows = text.filter(row => row.includes('some-long-test'))
  expect(commandRows).toHaveLength(2)
  expect(commandRows.at(-1)?.trimEnd()).toEndWith('…')
  const spans = blocks.flatMap(block => block.lines.flatMap(line => line.spans))
  expect(spans.some(span => span.text.includes('bun test') && span.dim)).toBe(true)
  expect(blocksToLines(buildOutputBlocks(card(true), { columns: 100 })).length).toBeGreaterThan(text.length)
})

test('compact task cards hide output and count only output, not the protocol envelope', () => {
  const result = 'Task ID: id\nStatus: completed\nOutput file: /tmp/out\nExit code: 0\nOutput:\nfirst\nsecond\n'
  const call = { id: 't', name: 'task_output', args: { task_id: 'id' }, status: 'done' as const, result }
  const compact = buildToolCard(call)
  expect(compact.map(row => row.text).join('\n')).not.toContain('first')
  expect(compact.map(row => row.text).join('\n')).not.toContain('second')
  expect(compact.map(row => row.text).join('\n')).not.toContain('Output file:')
  expect(compact.map(row => row.text).join('\n')).toContain('2 lines')
  expect(compact.map(row => row.text).join('\n')).toContain('(ctrl+o)')
  expect(buildToolCard(call, true).map(row => row.text).join('\n')).toContain('Output file:')
})

test('bash hides all successful output, including a single line, until expanded', () => {
  for (const result of ['one', 'one\ntwo\nthree\nfour\nfive\n']) {
    const call = { id: 'b', name: 'bash', args: { command: 'test' }, status: 'done' as const, result }
    const compact = buildToolCard(call).map(row => stripAnsi(row.text)).join('\n')
    expect(compact).not.toContain('one')
    expect(compact).not.toContain('five')
    expect(compact).toContain(result === 'one' ? '1 line' : '5 lines')
    // The fold rides on the status row; the card has no hint row of its own.
    expect(compact).toContain('(ctrl+o)')
    expect(buildToolCard(call)).toHaveLength(2)
    expect(buildToolCard(call, true).map(row => row.text).join('\n')).toContain('one')
  }
})

test('failed background tasks name the error on the status row and fold the body', () => {
  const card = buildToolCard({ id: 't', name: 'task_output', args: { task_id: 'id' }, status: 'done', details: { status: 'failed', exit_code: 1 }, result: 'Task ID: id\nStatus: failed\nOutput:\ncompilation failed\nsecond line' })
  const status = card.find(row => row.text.startsWith('  ✗'))
  expect(status?.text).toContain('compilation failed')
  expect(card.some(row => row.kind === 'error')).toBe(false)
  expect(card.map(row => row.text).join('\n')).toContain('2 lines (ctrl+o)')
  expect(card.map(row => row.text).join('\n')).not.toContain('second line')
})

test('empty task output adds no body or folding hint', () => {
  const card = buildToolCard({ id: 't', name: 'task_output', args: { task_id: 'id' }, status: 'done', result: 'Task ID: id\nStatus: completed\nOutput file: /tmp/out\nExit code: 0' })
  expect(card).toHaveLength(2)
  expect(card.map(row => row.text).join('\n')).not.toContain('ctrl+o')
})
