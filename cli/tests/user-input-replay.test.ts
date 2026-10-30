import { expect, test } from 'bun:test'
import { replayUserInput } from '../src/session/user-input.js'
import { transcriptToMessages } from '../src/session/transcript.js'
import { messagesToOutputLines } from '../src/render/output.js'
import { SuggestionContext } from '../src/term/app/suggestion.js'
import type { TranscriptItem } from '../src/native/index.js'

const historical = await Bun.file(new URL('../../src/app/tests/fixtures/schema/user-input-view-v0.json', import.meta.url)).json() as TranscriptItem
const current = await Bun.file(new URL('../../src/app/tests/fixtures/schema/user-input-view-v1.json', import.meta.url)).json() as TranscriptItem

test('historical and current application projections keep only authored input in user bubbles and suggestions', () => {
  for (const item of [historical, current]) {
    const original = JSON.stringify(item)
    const messages = transcriptToMessages([item])
    expect(messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Commit'])
    const lines = messagesToOutputLines(messages)
    expect(lines.filter(line => line.kind === 'user').map(line => line.text)).toEqual(['Commit'])
    const context = new SuggestionContext()
    context.restore([item])
    expect(context.snapshot().messages).toEqual([{ role: 'user', text: 'Commit' }])
    expect(JSON.stringify(item)).toBe(original)
    expect(lines.map(line => line.text).join('\n')).not.toContain('system-reminder')
    expect(lines.map(line => line.text).join('\n')).not.toContain('Arbitrary runtime content')
  }
})

test('runtime notices are system rows, not user intent or a second prediction request', () => {
  const messages = transcriptToMessages([current])
  expect(messages.map(message => message.role)).toEqual(['user', 'system'])
  expect(messages[1]!.text).toBe('Runtime context restored')
})

test('the CLI trusts explicit source projections rather than interpreting user-authored XML', () => {
  const text = '<task-notification>\n<task-id>38d5f299-ea7e-4c3d-b24f-aa704129d831</task-id>\n<status>completed</status>\n<summary>Literal user example</summary>\n<output-file>/tmp/example</output-file>\n</task-notification>'
  const item = { type: 'user', text, display_parts: [{ kind: 'user', text }] }
  expect(transcriptToMessages([item])[0]!.role).toBe('user')
  expect(transcriptToMessages([item])[0]!.text).toBe(text)
  expect(replayUserInput({ text: 'model input', display_parts: [] })).toEqual([])
})

test('old addons still replay ordinary input and malformed future display parts are rejected clearly', () => {
  expect(replayUserInput({ text: 'Commit' })).toEqual([{ kind: 'user', text: 'Commit' }])
  expect(() => replayUserInput({ display_parts: [{ kind: 'future', text: 'input' }] })).toThrow('Unsupported transcript display part')
  expect(() => replayUserInput({ display_parts: [null] })).toThrow('Invalid transcript display part')
})

test('legacy runtime reminders are stripped from authored text and never become user intent', () => {
  const reminder = '<system-reminder>\nBackground task from a previous evot process: 668c870e. That process has exited.\n</system-reminder>'
  // Appended after the user's line (orphaned-task notice).
  expect(replayUserInput({ text: `现在测试跑到哪了，有失败的吗？\n${reminder}` })).toEqual([
    { kind: 'user', text: '现在测试跑到哪了，有失败的吗？' }, { kind: 'runtime-context', text: reminder },
  ])
  // The whole message (thinking-only nudge): no user turn at all.
  const nudge = '<system-reminder>\nStatus: Your previous turn produced only internal reasoning.\n</system-reminder>'
  expect(replayUserInput({ text: nudge })).toEqual([{ kind: 'runtime-context', text: nudge }])
  expect(replayUserInput({ text: `${nudge.replaceAll('\n', '\r\n')}\n` })).toEqual([{ kind: 'runtime-context', text: nudge }])
  // Two trailing blocks, oldest first.
  expect(replayUserInput({ text: `Commit\n${nudge}\n${reminder}` }).map(p => p.kind)).toEqual(['user', 'runtime-context', 'runtime-context'])
  // Inline mention, quoted example and incomplete envelope stay user text.
  for (const text of [
    'Explain <system-reminder> literally',
    `Explain this:\n\`\`\`xml\n${reminder}\n\`\`\``,
    `Look:\n\`\`\`\n${reminder}`,
    reminder.replace('</system-reminder>', ''),
    `Commit\n<system-reminder>\nouter <system-reminder> nested\n</system-reminder>`,
  ]) expect(replayUserInput({ text })).toEqual([{ kind: 'user', text }])
  // Explicit source projections are trusted over text matching.
  expect(replayUserInput({ text: nudge, display_parts: [{ kind: 'user', text: nudge }] })).toEqual([{ kind: 'user', text: nudge }])
})

test('runtime reminders reach neither the suggestion context nor resumed user bubbles', () => {
  const reminder = '<system-reminder>\nBackground task from a previous evot process: 668c870e.\n</system-reminder>'
  const nudge = '<system-reminder>\nStatus: Your previous turn produced only internal reasoning.\n</system-reminder>'
  const items = [
    { type: 'user', text: `Run the tests\n${reminder}` },
    { type: 'assistant', content: [{ type: 'thinking', text: 'hmm' }], stop_reason: 'stop' },
    { type: 'user', text: nudge },
    { type: 'assistant', content: [{ type: 'text', text: 'All green.' }], stop_reason: 'stop' },
  ]
  const context = new SuggestionContext()
  context.restore(items)
  const snapshot = context.snapshot()
  expect(snapshot.messages).toEqual([{ role: 'user', text: 'Run the tests' }, { role: 'assistant', text: 'All green.' }])
  // The nudge did not open a second exchange.
  expect(snapshot.workflow.thread).toBeUndefined()
  const messages = transcriptToMessages(items).filter(m => m.text)
  expect(messages.map(m => [m.role, m.text])).toEqual([['user', 'Run the tests'], ['assistant', 'All green.']])
  expect(messages.some(m => m.role === 'system')).toBe(false)
})
