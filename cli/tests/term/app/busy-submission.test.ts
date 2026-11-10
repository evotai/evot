import { expect, test } from 'bun:test'
import { busySubmissionAction, type BusySubmission } from '../../../src/term/app/queue/busy-submission.js'

const base: BusySubmission = { displayText: '', expandedText: '', hasImages: false, compacting: false, editingQueue: false, hasRun: true }

test('commands never enter model queues even with attached images', () => {
  for (const command of ['/compact', '/model', '/clear', '/unknown']) {
    for (const hasImages of [false, true]) {
      const input = { ...base, displayText: command, expandedText: command, hasImages }
      expect(busySubmissionAction(input)).toBe('blocked_run_command')
      expect(busySubmissionAction({ ...input, compacting: true })).toBe('blocked_compaction_command')
    }
  }
  expect(busySubmissionAction({ ...base, displayText: '/compact', hasImages: true })).toBe('blocked_run_command')
})

test('compaction, queue editing and log routing retain priority', () => {
  expect(busySubmissionAction({ ...base, expandedText: '/log' })).toBe('show_log')
  expect(busySubmissionAction({ ...base, expandedText: '/log', compacting: true })).toBe('blocked_compaction_command')
  expect(busySubmissionAction({ ...base, expandedText: '/log', editingQueue: true })).toBe('edit_queue')
  expect(busySubmissionAction({ ...base, expandedText: 'hello', compacting: true, editingQueue: true })).toBe('queue_compaction')
})

test('bare read-only commands run mid-stream; arguments and mutators stay blocked', () => {
  for (const command of ['/version', '/v', '/help']) {
    expect(busySubmissionAction({ ...base, expandedText: command })).toBe('run_readonly_command')
    expect(busySubmissionAction({ ...base, expandedText: command, compacting: true })).toBe('blocked_compaction_command')
    expect(busySubmissionAction({ ...base, expandedText: command, hasRun: false })).toBe('none')
  }
  for (const command of ['/help compact', '/version now', '/model', '/model gpt', '/env', '/skill']) {
    expect(busySubmissionAction({ ...base, expandedText: command })).toBe('blocked_run_command')
  }
})

test('text and image prompts route only to an available execution owner', () => {
  for (const input of [{ ...base, expandedText: 'hello' }, { ...base, hasImages: true }]) {
    expect(busySubmissionAction(input)).toBe('steer')
    expect(busySubmissionAction({ ...input, compacting: true })).toBe('queue_compaction')
    expect(busySubmissionAction({ ...input, hasRun: false })).toBe('none')
  }
  expect(busySubmissionAction(base)).toBe('none')
  expect(busySubmissionAction({ ...base, compacting: true, expandedText: '  ' })).toBe('none')
  expect(busySubmissionAction({ ...base, expandedText: '/' })).toBe('steer')
})
