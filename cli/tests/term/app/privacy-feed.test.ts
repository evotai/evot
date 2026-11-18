import { beforeEach, expect, test } from 'bun:test'

import type { PrivacyLive, PrivacyLiveNotice } from '../../../src/native/contracts/privacy.js'
import { privacyLive as schema } from '../../../src/native/contracts/privacy.js'
import { decodeResult } from '../../../src/native/contracts/results.js'
import { buildPrivacyCommandCard, resetIdCounter } from '../../../src/render/output.js'
import { PrivacyFeed } from '../../../src/term/app/privacy-feed.js'

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
  expect(first[0]!.notice.tags).toEqual(['SECRET_a', 'PHONE_b'])
  expect(first[0]!.fresh).toEqual(new Set(['SECRET_a', 'PHONE_b']))
  // The next turn masks the same history again: silence.
  n.push(notice({ tags: ['SECRET_a', 'PHONE_b'] }))
  expect(feed.poll('s1')).toEqual([])
  // The user types a new password: one notice for that record.
  n.push(notice({ tags: ['SECRET_a', 'PHONE_b', 'SECRET_c'], reason: 'masked SECRET ×28 · PHONE ×1' }))
  const again = feed.poll('s1')
  expect(again).toHaveLength(1)
  expect(again[0]!.notice.reason).toBe('masked SECRET ×28 · PHONE ×1')
  expect(again[0]!.fresh).toEqual(new Set(['SECRET_c']))
  // Polling twice does not replay.
  expect(feed.poll('s1')).toEqual([])
})

test('blocked records, other sessions and session-less records are left to their own cards', () => {
  const n = native()
  const feed = new PrivacyFeed(n.live)
  n.push(notice({ blocked: true, tags: ['KEY_z'] }))
  n.push(notice({ session: 'other', tags: ['KEY_y'] }))
  n.push(notice({ session: null, tags: ['KEY_w'] }))
  n.push(notice({ tags: ['KEY_x'] }))
  const out = feed.poll('s1')
  expect(out.map(h => h.notice.tags)).toEqual([['KEY_x']])
  // A forgotten session sees its values as new again.
  feed.forget('s1')
  n.push(notice({ tags: ['KEY_x'] }))
  expect(feed.poll('s1').map(h => [...h.fresh])).toEqual([['KEY_x']])
})

test('an addon without the live feed is silence, not a crash in the event loop', () => {
  const feed = new PrivacyFeed(() => { throw new Error('addon too old') })
  expect(feed.poll('s1')).toEqual([])
})

test('a /privacy action renders as a card titled with the command', () => {
  const lines = buildPrivacyCommandCard(' term  Project Nightjar', '  term added: Project Nightjar\n  model requests masked · 1 term of yours · uploads scrubbed')
  expect(lines.map(line => line.text)).toEqual([
    '⊘ privacy  term Project Nightjar',
    '  term added: Project Nightjar',
    '  model requests masked · 1 term of yours · uploads scrubbed',
  ])
  expect(lines[0]!.toolCard).toEqual({ state: 'success', first: true, last: false, tone: 'notice' })
  const refused = buildPrivacyCommandCard('term rm x', '  no such term', 'error')
  expect(refused[1]!.kind).toBe('error')
})

test('the addon payload decodes the record detail, and older payloads without it', () => {
  const raw = JSON.stringify({ cursor: 1, notices: [{ seq: 1, time: 't', target: 'llm', session: 's', blocked: true, kinds: ['PRIVATE_KEY'], reason: 'contains PRIVATE_KEY ×1',
    provider: 'p', model: 'm', rules: [{ rule: 'secrets.ssh-private-key', values: 1 }], origins: [{ at: 'Bash result', label: 'cat ~/.ssh/id_ed25519', n: 1 }], tags: ['PRIVATE_KEY_a'] }] })
  const live = decodeResult(raw, schema)
  expect(live.notices[0]!.origins).toEqual([{ at: 'Bash result', label: 'cat ~/.ssh/id_ed25519', n: 1 }])
  expect(live.notices[0]!.model).toBe('m')
  const finding = { tag: 'TOKEN_new', kind: 'TOKEN', rule: 'contexts.authorization', action: 'mask' as const,
    at: 'read result', label: 'config.toml', path: './config.toml', line: 108, preview: 'Authorization: Basic [mask]' }
  const next = decodeResult(JSON.stringify({ cursor: 2, notices: [notice({ findings: [finding] })] }), schema)
  expect(next.notices[0]!.findings).toEqual([finding])
  expect(() => decodeResult(JSON.stringify({ cursor: 2, notices: [notice({ findings: [{ ...finding, line: '108' }] })] }), schema)).toThrow()
  // No detail at all is still a valid notice.
  expect(() => decodeResult(JSON.stringify({ cursor: 1, notices: [notice({})] }), schema)).not.toThrow()
})

test('a block is kept for its error card, per session, and does not earn a happening card', () => {
  const n = native()
  const feed = new PrivacyFeed(n.live)
  n.push(notice({ blocked: true, kinds: ['PRIVATE_KEY'], reason: 'contains PRIVATE_KEY ×1', origins: [{ at: 'Bash result', label: 'cat key', n: 1 }] }))
  n.push(notice({ session: 's2', blocked: true, reason: 'contains API_KEY ×1' }))
  n.push(notice({ session: 's1', target: 'sync', blocked: true, reason: 'contains PASSWORD ×1' }))
  expect(feed.poll('s1')).toEqual([])
  // Asked without a poll in between: the block raised a moment ago still counts.
  expect(feed.lastBlocked('s1')?.reason).toBe('contains PRIVATE_KEY ×1')
  expect(feed.lastBlocked('s2')).toBeUndefined() // filtered: not s1's poll
  const other = new PrivacyFeed(n.live)
  expect(other.lastBlocked('s2')?.reason).toBe('contains API_KEY ×1')
  feed.forget('s1')
  expect(feed.lastBlocked('s1')).toBeUndefined()
})

test('seeded tags from earlier records are not reported as first seen after resume', () => {
  const n = native()
  const feed = new PrivacyFeed(n.live)
  feed.seed('s1', ['SECRET_a', 'SECRET_b'])
  n.push(notice({ tags: ['SECRET_a', 'SECRET_b'] }))
  expect(feed.poll('s1')).toEqual([])
  n.push(notice({ tags: ['SECRET_a', 'SECRET_c'] }))
  expect(feed.poll('s1').map(h => [...h.fresh])).toEqual([['SECRET_c']])
})
