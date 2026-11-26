import { expect, test } from 'bun:test'
import { CONFIRM_MS, delivered, photoExpired, refused, requestTimeout } from '../../../src/features/remote/phone-send.js'

test('a photo upload gets time for a slow phone uplink; ordinary requests keep their short deadline', () => {
  expect(requestTimeout('/state')).toBe(8000)
  expect(requestTimeout('/action', 200)).toBe(8013)
  expect(requestTimeout('/sessions?limit=40&catalog=1')).toBe(30000)
  expect(requestTimeout('/open', 300)).toBe(15000)
  // One phone-sized photo (~1.4 MB as base64) may take well over the old 8 s.
  expect(requestTimeout('/action', 1_400_000)).toBeGreaterThan(80_000)
  expect(requestTimeout('/action', 14 * 1024 * 1024)).toBe(300_000)
})

test('only an answer from the computer is a refusal; a lost reply may still have delivered the photos', () => {
  expect(refused(Object.assign(Error('The run changed.'), { status: 409 }))).toBe(true)
  expect(refused(Object.assign(Error('Too large'), { status: 413 }))).toBe(true)
  for (const unknown of [new DOMException('timed out', 'TimeoutError'), new TypeError('Load failed'),
    Object.assign(Error('Bad gateway'), { status: 502 }), undefined]) expect(refused(unknown)).toBe(false)
  expect(CONFIRM_MS).toBeGreaterThan(0)
})

test('a photo message counts as delivered once the transcript or the queue has its id', () => {
  const view = { messages: [{ role: 'user', text: 'look\n[Image from phone]', photoId: 'p1' }, { role: 'assistant', text: 'ok', photoId: 'p3' }],
    pendingDrafts: ['p2'] }
  expect(delivered(view, 'p1')).toBe(true)
  expect(delivered(view, 'p2')).toBe(true) // queued behind a running turn
  expect(delivered(view, 'p3')).toBe(false) // only the user's own row can confirm it
  expect(delivered({ messages: [], pendingSteers: ['p4'] }, 'p4')).toBe(true) // older windows
  expect(delivered(view, undefined)).toBe(false)
  expect(delivered(null, 'p1')).toBe(false)
})

test('only a missing uploaded photo asks for an inline resend', () => {
  expect(photoExpired(Object.assign(Error('expired'), { status: 412 }))).toBe(true)
  expect(photoExpired(Object.assign(Error('changed'), { status: 409 }))).toBe(false)
  expect(photoExpired(new TypeError('Load failed'))).toBe(false)
})
