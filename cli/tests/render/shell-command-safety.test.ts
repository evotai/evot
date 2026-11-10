import { expect, test } from 'bun:test'
import { buildToolCall } from '../../src/render/output.js'
import { formatBashCommandDisplay } from '../../src/ui/format.js'

test('unvalidated streamed command fields never reach string operations', () => {
  for (const value of [null, undefined, false, 42, {}, [], { command: 'nested' }]) {
    for (const tool of ['bash', 'task_output', 'task_stop']) {
      for (const expanded of [false, true]) {
        expect(() => buildToolCall(tool, { command: value, task_id: value }, undefined, expanded)).not.toThrow()
      }
    }
    expect(formatBashCommandDisplay(value)).toEqual({ headline: '', detailLines: [] })
  }
})

test('expanded shell command retains the complete single line', () => {
  const command = 'echo ' + '中文🙂'.repeat(100)
  expect(formatBashCommandDisplay(command, true).headline).toBe(command)
  expect(formatBashCommandDisplay(command).headline).not.toBe(command)
})
