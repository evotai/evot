import { expect, test } from 'bun:test'
import { stripVTControlCharacters } from 'node:util'
import { buildToolCard } from '../../../../src/render/output.js'
import type { UIToolCall } from '../../../../src/render/message-types.js'
import { ConversationTail, assistantRow } from '../../../../src/term/app/remote/conversation.js'

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
      return rows.length
        ? [
            {
              kind: 'tool',
              state: rows[0]!.toolCard!.state,
              text: rows.map((r) => stripVTControlCharacters(r.text)).join('\n'),
            },
          ]
        : []
    })
    expect(assistantRow(content, expanded)?.blocks).toEqual(expected)
    expect(history.view(expanded)[0]?.blocks).toEqual(expected)
    expect(resumed.view(expanded)[0]?.blocks).toEqual(expected)
  }
})
