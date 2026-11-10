import { describe, expect, test } from 'bun:test'
import { mergeQueuedIntoEditorText } from '../../../src/term/app/queue/queue-restore.js'

describe('mergeQueuedIntoEditorText', () => {
  test('returns editor text when queue is empty', () => {
    expect(mergeQueuedIntoEditorText([], 'draft')).toBe('draft')
    expect(mergeQueuedIntoEditorText([], '')).toBe('')
  })

  test('restores a single queued message into an empty editor', () => {
    expect(mergeQueuedIntoEditorText(['fix the bug'], '')).toBe('fix the bug')
    expect(mergeQueuedIntoEditorText(['fix the bug'], '   ')).toBe('fix the bug')
  })

  test('joins multiple queued messages in order', () => {
    expect(mergeQueuedIntoEditorText(['first', 'second'], '')).toBe('first\nsecond')
  })

  test('keeps an existing draft under the restored queue', () => {
    expect(mergeQueuedIntoEditorText(['queued'], 'draft')).toBe('queued\ndraft')
    expect(mergeQueuedIntoEditorText(['a', 'b'], 'draft')).toBe('a\nb\ndraft')
  })

  test('drops empty queued entries', () => {
    expect(mergeQueuedIntoEditorText(['', 'keep', ''], '')).toBe('keep')
  })
})
