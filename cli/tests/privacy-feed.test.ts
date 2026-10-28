import { beforeEach, expect, test } from 'bun:test'

import type { PrivacyLive, PrivacyLiveNotice } from '../src/native/contracts/privacy.js'
import { privacyLive as schema } from '../src/native/contracts/privacy.js'
import { decodeResult } from '../src/native/contracts/results.js'
import { buildPrivacyActionCard, buildPrivacyHappeningCard, resetIdCounter } from '../src/render/output.js'
import { PrivacyFeed } from '../src/term/app/privacy-feed.js'

beforeEach(() => resetIdCounter())

let seq = 0
function notice(over: Partial<PrivacyLiveNotice>): PrivacyLiveNotice {
  seq++
  return { seq, time: '2026-05-01T10:10:00+08:00', target: 'llm', session: 's1', blocked: false, kinds: ['SECRET'], reason: 'masked SECRET ×1', tags: ['SECRET_a'], ...over }
}

/** A native feed: returns what was pushed after the cursor, like the addon. */
function native() {
  const all: PrivacyLiveNotice[] = []
  return {
    push: (n: PrivacyLiveNotice) => all.push(n),
    live: (after: number): PrivacyLive => ({ cursor: all.at(-1)?.seq ?? 0, notices: all.filter(n => n.seq > after) }),
  }
}

test('the addon payload decodes with the flattened event and tags', () => {
  const raw = JSON.stringify({ cursor: 3, notices: [{ seq: 3, time: 't', target: 'llm', session: 's', blocked: false, kinds: ['SECRET'], reason: 'masked SECRET ×1', tags: ['SECRET_x'] }] })
  const live = decodeResult(raw, schema)
  expect(live.cursor).toBe(3)
  expect(live.notices[0]!.tags).toEqual(['SECRET_x'])
})

test('a value is announced the first time it is masked, not on every request', () => {
  const n = native()
  const feed = new PrivacyFeed(n.live)
  expect(feed.poll('s1')).toEqual([])
  n.push(notice({ tags: ['SECRET_a', 'PHONE_b'], kinds: ['PHONE', 'SECRET'], reason: 'masked SECRET ×27 · PHONE ×1' }))
  const first = feed.poll('s1')
  expect(first).toHaveLength(1)
  expect(first[0]!.fresh).toBe(2)
  // The next turn masks the same history again: silence.
  n.push(notice({ tags: ['SECRET_a', 'PHONE_b'] }))
  expect(feed.poll('s1')).toEqual([])
  // The user types a new password: one card, one new value.
  n.push(notice({ tags: ['SECRET_a', 'PHONE_b', 'SECRET_c'], reason: 'masked SECRET ×28 · PHONE ×1' }))
  const again = feed.poll('s1')
  expect(again).toHaveLength(1)
  expect(again[0]!.fresh).toBe(1)
  // Polling twice does not replay.
  expect(feed.poll('s1')).toEqual([])
})

test('blocked records and other sessions are left to their own cards', () => {
  const n = native()
  const feed = new PrivacyFeed(n.live)
  n.push(notice({ blocked: true, tags: ['KEY_z'] }))
  n.push(notice({ session: 'other', tags: ['KEY_y'] }))
  n.push(notice({ session: null, tags: ['KEY_x'] }))
  const out = feed.poll('s1')
  expect(out.map(h => h.notice.tags)).toEqual([['KEY_x']])
  // A forgotten session sees its values as new again.
  feed.forget('s1')
  n.push(notice({ tags: ['KEY_x'] }))
  expect(feed.poll('s1')[0]!.fresh).toBe(1)
})

test('an addon without the live feed is silence, not a crash in the event loop', () => {
  const feed = new PrivacyFeed(() => { throw new Error('addon too old') })
  expect(feed.poll('s1')).toEqual([])
})

test('the card says what happened, how many values are new, and where to look', () => {
  const masked = buildPrivacyHappeningCard({ target: 'llm', reason: 'masked SECRET ×1' }, 1)
  expect(masked.map(l => l.text)).toEqual([
    '⊘ privacy  masked request',
    '  ✓ · masked SECRET ×1 · 1 value first seen now',
    '  The model saw placeholders; the reply was restored · /privacy shows the record',
  ])
  expect(masked[0]!.toolCard).toEqual({ state: 'success', first: true, last: false, tone: 'notice' })
  expect(masked[2]!.toolCard).toEqual({ state: 'success', first: false, last: true, tone: 'notice' })
  expect(buildPrivacyHappeningCard({ target: 'share', reason: 'masked EMAIL ×2' }, 2)[1]!.text).toBe('  ✓ · masked EMAIL ×2 · 2 values first seen now')
})

test('a /privacy action renders as a card titled with the command', () => {
  const lines = buildPrivacyActionCard(' term  Project Nightjar', '  term added: Project Nightjar\n  model requests masked · 1 term of yours · uploads scrubbed')
  expect(lines.map(line => line.text)).toEqual([
    '⊘ privacy  term Project Nightjar',
    '  term added: Project Nightjar',
    '  model requests masked · 1 term of yours · uploads scrubbed',
  ])
  expect(lines[0]!.toolCard).toEqual({ state: 'success', first: true, last: false, tone: 'notice' })
  const refused = buildPrivacyActionCard('term rm x', '  no such term', 'error')
  expect(refused[1]!.kind).toBe('error')
})
