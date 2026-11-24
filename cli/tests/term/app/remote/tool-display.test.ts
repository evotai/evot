import { expect, test } from 'bun:test'
import { stripVTControlCharacters } from 'node:util'
import { buildToolCard } from '../../../../src/render/output.js'
import type { UIToolCall } from '../../../../src/render/message-types.js'
import { ConversationTail, assistantRow, diffRows } from '../../../../src/term/app/remote/conversation.js'
import chalk from 'chalk'

// The oracle is the real TUI presenter, not a list of phone-specific labels.
const calls: UIToolCall[] = [
  { id: '1', name: 'bash', status: 'queued', argsComplete: true, args: { command: 'ls -l' } },
  { id: '2', name: 'bash', status: 'running', args: { command: 'make check' }, progress: 'compiling\ntesting' },
  {
    id: '3',
    name: 'bash',
    status: 'done',
    args: { command: 'false' },
    details: { exit_code: 1 },
    result: 'failure preview',
    durationMs: 456,
  },
  { id: '4', name: 'task_output', status: 'running', args: { task_id: 'a' }, previewCommand: 'make check' },
  {
    id: '5',
    name: 'task_output',
    status: 'done',
    args: { task_id: 'a', block: false },
    details: { task_status: 'failed', exit_code: 2, elapsed_ms: 1234 },
  },
  { id: '6', name: 'task_stop', status: 'error', args: { task_id: 'a' }, result: 'task not found' },
  { id: '7', name: 'edit', status: 'done', args: { path: 'a.ts' }, details: { diff: '@@ -1 +1 @@\n-old\n+new' } },
  { id: '8', name: 'ask_user', status: 'done', args: { questions: [] } },
]
test('live, committed and resumed tools reuse compact and expanded TUI display and suppression rules', () => {
  const content = calls.map((toolCall, contentIndex) => ({ type: 'tool_call' as const, contentIndex, toolCall }))
  const history = new ConversationTail(),
    resumed = new ConversationTail()
  history.appendAssistant(content)
  resumed.replace([{ id: 'a', timestamp: 1, role: 'assistant', text: '', content }])
  for (const expanded of [false, true]) {
    const expected = calls.flatMap((call) => {
      const rows = buildToolCard(call, expanded)
      const diff = rows.flatMap((r) => (r.diffText !== undefined ? diffRows(r.diffText, r.diffGutter) : []))
      return rows.length
        ? [
            {
              kind: 'tool',
              state: rows[0]!.toolCard!.state,
              // A patch travels as rows, not as card text.
              text: rows.filter((r) => r.diffText === undefined).map((r) => stripVTControlCharacters(r.text)).join('\n'),
              ...(diff.length ? { diff } : {}),
            },
          ]
        : []
    })
    expect(assistantRow(content, expanded)?.blocks).toEqual(expected)
    expect(history.view(expanded)[0]?.blocks).toEqual(expected)
    expect(resumed.view(expanded)[0]?.blocks).toEqual(expected)
  }
})

test('a Write/Edit patch reaches the phone as the TUI unified rows, with changed words marked and a bounded length', () => {
  const level = chalk.level
  chalk.level = 3
  try {
    const rows = diffRows('@@ -10,3 +10,3 @@ function f()\n keep\n-const a = 1\n+const a = 10\n tail')
    expect(rows.map((r) => [r.kind, r.num ?? null, r.code.map((c) => c.text).join('')])).toEqual([
      ['header', null, '@@ -10,3 +10,3 @@ function f()'],
      ['context', '10', 'keep'], ['remove', '11', 'const a = 1'], ['add', '11', 'const a = 10'], ['context', '12', 'tail']])
    // Only the changed token carries the word fill; no escape bytes reach the phone.
    expect(rows[3]!.code.filter((c) => c.word).map((c) => c.text)).toEqual(['10'])
    expect(JSON.stringify(rows)).not.toContain('\\u001b')
    const tabs = diffRows('@@ -1 +1 @@\n-\told\n+\tnew')
    expect(tabs[1]!.code.map((c) => c.text).join('')).toBe('    new')
    const long = diffRows('@@ -0,0 +1,500 @@\n' + Array.from({ length: 500 }, (_, i) => '+line ' + i).join('\n'), 4)
    expect(long).toHaveLength(401)
    expect(long.at(-1)).toMatchObject({ kind: 'ellipsis', code: [{ text: '… 100 more lines in the TUI' }] })
    expect(long[0]!.num).toBe('   1')
  } finally { chalk.level = level }
})
