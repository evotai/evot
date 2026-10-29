import { test, expect } from 'bun:test'
import { lastAssistantText, parseSessionSearchResults } from '../src/term/app/session-search.js'
import type { UIMessage } from '../src/term/app/types.js'

const A = '019ecf98-a948-7ee1-b28a-e352da2aee40'
const B = '019ecff1-0ee9-76d1-9edf-a8e10b8794b7'

test('parseSessionSearchResults extracts ids in order, once, ignoring prose', () => {
  const text = [
    'Two sessions match:',
    `- ${A} — GHE setup — configured SSO`,
    `* \`${B}\` - Runners - migrated runners`,
    `- ${A} — duplicate — again`,
    '- not-an-id — nope',
    '- 019ecf98 — prefix only — not a full id',
  ].join('\n')
  expect(parseSessionSearchResults(text).map(result => result.sessionId)).toEqual([A, B])
  expect(parseSessionSearchResults('NONE')).toEqual([])
})

test('parseSessionSearchResults accepts dated skill results and incomplete coverage', () => {
  const text = [
    'Only 24 sessions were included; older history was omitted.',
    `- ${B} — Warehouse restarts — 2026-03-09 — Diagnosed memory pressure`,
    `- ${A} — Query costs — 2026-03-08 — Reduced excessive scanning`,
  ].join('\n')
  expect(parseSessionSearchResults(text)).toEqual([
    { sessionId: B, summary: 'Diagnosed memory pressure' },
    { sessionId: A, summary: 'Reduced excessive scanning' },
  ])
  expect(parseSessionSearchResults('No match among the included candidates.\nNONE')).toEqual([])
})

test('result rows keep only the summary, and accept channel session ids', () => {
  const channel = 'ch_cad508a39f2fcee5c9d9abadf6bc6d37'
  const text = [
    `- ${A} — 2026-10-29 — 测了向量与全文检索的冷查询和并发，写成中英文性能文档并提 PR。`,
    // An answer in the older shape, with a title before the date.
    `- ${channel} — tracelake 告警 — 2026-10-27 — 排查告警，顺带估算营收`,
    `- ${B} — No date at all`,
  ].join('\n')
  expect(parseSessionSearchResults(text)).toEqual([
    { sessionId: A, summary: '测了向量与全文检索的冷查询和并发，写成中英文性能文档并提 PR' },
    { sessionId: channel, summary: '排查告警，顺带估算营收' },
    { sessionId: B, summary: 'No date at all' },
  ])
})

test('lastAssistantText joins text blocks of the final assistant message', () => {
  const messages: UIMessage[] = [
    { id: 'u', role: 'user', text: 'find', timestamp: 0 },
    { id: 'a1', role: 'assistant', text: '', timestamp: 1, content: [
      { type: 'text', contentIndex: 0, text: 'old' },
    ] },
    { id: 'u2', role: 'user', text: 'again', timestamp: 2 },
    { id: 'a2', role: 'assistant', text: '', timestamp: 3, content: [
      { type: 'thinking', contentIndex: 0, text: 'hmm' },
      { type: 'text', contentIndex: 1, text: 'first' },
      { type: 'text', contentIndex: 2, text: 'second' },
    ] },
  ]
  expect(lastAssistantText(messages)).toBe('first\nsecond')
  expect(lastAssistantText(messages.slice(0, 1))).toBe('')
  expect(lastAssistantText([{ id: 'x', role: 'assistant', text: 'legacy', timestamp: 0 }])).toBe('legacy')
})
