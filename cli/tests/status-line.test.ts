import { describe, expect, test } from 'bun:test'
import type { OutputLine } from '../src/render/output.js'
import { isStatusLineId, replaceOrPushStatusLine, statusLineSlot } from '../src/term/app/status-line.js'

function sys(id: string, text: string): OutputLine {
  return { id, kind: 'system', text }
}

function user(id: string, text: string): OutputLine {
  return { id, kind: 'user', text }
}

describe('replaceOrPushStatusLine', () => {
  test('appends when history is empty', () => {
    const lines: OutputLine[] = []
    expect(replaceOrPushStatusLine(lines, sys('sys-model', '  Model → a'))).toBe(false)
    expect(lines).toEqual([sys('sys-model', '  Model → a')])
  })

  test('replaces trailing model with another model', () => {
    const lines = [user('u1', 'hi'), sys('sys-model', '  Model → a')]
    expect(replaceOrPushStatusLine(lines, sys('sys-model', '  Model → b'))).toBe(true)
    expect(lines).toEqual([user('u1', 'hi'), sys('sys-model', '  Model → b')])
  })

  test('model and thinking share one trailing status slot', () => {
    const lines = [sys('sys-model', '  Model → a')]
    expect(replaceOrPushStatusLine(lines, sys('sys-think', '  Thinking level → high'))).toBe(true)
    expect(lines).toEqual([sys('sys-think', '  Thinking level → high')])
    expect(replaceOrPushStatusLine(lines, sys('sys-model', '  Model → b'))).toBe(true)
    expect(lines).toEqual([sys('sys-model', '  Model → b')])
  })

  test('does not replace when trailing line is not a status line', () => {
    const lines = [sys('sys-model', '  Model → a'), user('u1', 'hi')]
    expect(replaceOrPushStatusLine(lines, sys('sys-think', '  Thinking level → low'))).toBe(false)
    expect(lines).toEqual([
      sys('sys-model', '  Model → a'),
      user('u1', 'hi'),
      sys('sys-think', '  Thinking level → low'),
    ])
  })

  test('does not treat other system ids as status slots', () => {
    const lines = [sys('sys-log-mode', '  log mode: on')]
    expect(replaceOrPushStatusLine(lines, sys('sys-model', '  Model → a'))).toBe(false)
    expect(lines).toHaveLength(2)
  })

  test('cloud session progress collapses into its own outcome', () => {
    // "restoring" must be replaced by the result, not left above a line that
    // says the opposite.
    const lines = [sys('sys-cloud-session', '  Cloud session expired · restoring')]
    expect(replaceOrPushStatusLine(lines, sys('sys-cloud-session', '  Cloud session restored'))).toBe(true)
    expect(lines).toEqual([sys('sys-cloud-session', '  Cloud session restored')])
  })

  test('cloud session and model occupy separate slots', () => {
    // A session update must never overwrite the model line above it.
    const lines = [sys('sys-model', '  Model → a')]
    expect(replaceOrPushStatusLine(lines, sys('sys-cloud-session', '  Cloud session expired · restoring'))).toBe(false)
    expect(lines).toEqual([
      sys('sys-model', '  Model → a'),
      sys('sys-cloud-session', '  Cloud session expired · restoring'),
    ])
  })
})

describe('statusLineSlot', () => {
  test('groups ids that collapse into each other', () => {
    expect(statusLineSlot('sys-model')).toBe(statusLineSlot('sys-think'))
    expect(statusLineSlot('sys-cloud-session')).not.toBe(statusLineSlot('sys-model'))
    expect(statusLineSlot('sys-plan')).toBeUndefined()
  })
})

describe('isStatusLineId', () => {
  test('recognizes the known status ids only', () => {
    expect(isStatusLineId('sys-model')).toBe(true)
    expect(isStatusLineId('sys-think')).toBe(true)
    expect(isStatusLineId('sys-cloud-session')).toBe(true)
    expect(isStatusLineId('sys-m')).toBe(false)
    expect(isStatusLineId('sys-plan')).toBe(false)
  })
})
