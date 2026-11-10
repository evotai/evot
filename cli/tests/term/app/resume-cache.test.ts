import { describe, expect, test } from 'bun:test'
import { ResumeSessionCache } from '../../../src/term/app/session/resume-cache.js'
import type { SessionMeta, SessionWithText } from '../../../src/native/index.js'

function row(id: string): SessionMeta {
  return { session_id: id, title: id, model: 'model', thinking_level: null, cwd: '/work', source: 'test', turns: 1, created_at: '', updated_at: '' }
}
function fixture() {
  const metadata: Array<{ limit: number; result: ReturnType<typeof Promise.withResolvers<SessionMeta[]>> }> = []
  const text: Array<ReturnType<typeof Promise.withResolvers<SessionWithText[]>>> = []
  const published: SessionMeta[][] = []
  const cache = new ResumeSessionCache({
    listSessions: limit => {
      const result = Promise.withResolvers<SessionMeta[]>()
      metadata.push({ limit, result })
      return result.promise
    },
    listSessionsWithText: () => {
      const result = Promise.withResolvers<SessionWithText[]>()
      text.push(result)
      return result.promise
    },
    sessionWithText: () => Promise.resolve(null),
  }, rows => published.push(rows))
  return { cache, metadata, text, published }
}

describe('resume cache ownership', () => {
  test('task-heavy first page still shows 20 interactive sessions', async () => {
    const f = fixture()
    const pending = f.cache.preview()
    const tasks = Array.from({ length: 20 }, (_, index) => ({ ...row(`run-${index}`), source: 'automation' }))
    f.metadata[0]!.result.resolve(tasks)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.metadata[1]?.limit).toBe(0)
    const human = Array.from({ length: 25 }, (_, index) => row(`chat-${index}`))
    f.metadata[1]!.result.resolve([...tasks, ...human])
    expect((await pending).map(s => s.session_id)).toEqual(human.slice(0, 20).map(s => s.session_id))
    expect(f.cache.complete).toBe(true)
    // The full catalog keeps automation rows, which remain reachable by ID.
    expect((await f.cache.all()).filter(s => s.source === 'automation')).toHaveLength(20)
    f.cache.dispose()
  })

  test('coalesces loads and does not replace full metadata with a late preview', async () => {
    const f = fixture()
    const preview = f.cache.preview()
    expect(f.cache.preview()).toBe(preview)
    const full = f.cache.all()
    expect(f.cache.all()).toBe(full)
    const rows = Array.from({ length: 30 }, (_, index) => row(String(index)))
    f.metadata[1]!.result.resolve(rows)
    await full
    f.metadata[0]!.result.resolve([row('stale-preview')])
    expect(await preview).toEqual(rows.slice(0, 20))
    expect(f.cache.metadata).toEqual(rows)
    expect(f.cache.complete).toBe(true)
  })

  test('late metadata cannot downgrade completed full-text enrichment', async () => {
    const f = fixture()
    const metadata = f.cache.all()
    const text = f.cache.text()
    const rich = [{ ...row('a'), search_text: 'body', user_prompts: ['prompt'] }]
    f.text[0]!.resolve(rich)
    await text
    f.metadata[0]!.result.resolve([row('old')])
    expect(await metadata).toEqual(rich)
    expect(f.cache.metadata).toEqual(rich)
    expect(f.cache.withText).toEqual(rich)
    expect(f.published).toEqual([rich])
  })

  test('invalidation rejects late results without publishing or clearing a newer load', async () => {
    const f = fixture()
    const old = f.cache.all()
    f.cache.invalidate()
    const current = f.cache.all()
    f.metadata[0]!.result.resolve([row('old')])
    expect(await old).toEqual([])
    expect(f.cache.all()).toBe(current)
    expect(f.published).toEqual([])
    f.metadata[1]!.result.resolve([row('new')])
    expect(await current).toEqual([row('new')])
  })

  test('empty preview is not authoritative while an empty full result is', async () => {
    const f = fixture()
    const first = f.cache.preview()
    f.metadata[0]!.result.resolve([])
    await first
    const second = f.cache.preview()
    expect(f.metadata).toHaveLength(2)
    f.metadata[1]!.result.resolve([])
    await second
    f.cache.replace([], true)
    expect(await f.cache.preview()).toEqual([])
    expect(f.metadata).toHaveLength(2)
  })

  test('removal preserves enriched text and completeness, invalidating old loads', async () => {
    const f = fixture()
    const text = f.cache.text()
    expect(f.cache.text()).toBe(text)
    const rows = ['a', 'b'].map(id => ({ ...row(id), search_text: id, user_prompts: [id] }))
    f.text[0]!.resolve(rows)
    await text
    f.cache.remove('a')
    expect(f.cache.metadata).toEqual([rows[1]])
    expect(f.cache.withText).toEqual([rows[1]])
    expect(f.cache.complete).toBe(true)
  })

  test('disposal rejects late results and prevents new requests or replacements', async () => {
    const f = fixture()
    const pending = f.cache.all()
    f.cache.dispose()
    f.metadata[0]!.result.resolve([row('late')])
    expect(await pending).toEqual([])
    expect(f.published).toEqual([])
    f.cache.replace([row('replaced')], true)
    f.cache.remove('missing', [row('fallback')])
    expect(await f.cache.preview()).toEqual([])
    expect(await f.cache.all()).toEqual([])
    expect(await f.cache.text()).toEqual([])
    expect(await f.cache.loadSessionText('late')).toBeNull()
    expect(f.metadata).toHaveLength(1)
    expect(f.text).toHaveLength(0)
    expect(f.cache.metadata).toBeNull()
  })

  test('failed request releases ownership so a retry can proceed', async () => {
    const f = fixture()
    const first = f.cache.all()
    f.metadata[0]!.result.reject(new Error('offline'))
    await expect(first).rejects.toThrow('offline')
    const retry = f.cache.all()
    f.metadata[1]!.result.resolve([row('ok')])
    expect(await retry).toEqual([row('ok')])
  })

  test('focused text loads one session, coalesces, and serves later reads from memory', async () => {
    const requested: string[] = []
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<SessionWithText | null>>>()
    const cache = new ResumeSessionCache({
      listSessions: () => Promise.resolve([]),
      listSessionsWithText: () => Promise.resolve([]),
      sessionWithText: sessionId => {
        requested.push(sessionId)
        const result = Promise.withResolvers<SessionWithText | null>()
        pending.set(sessionId, result)
        return result.promise
      },
    })
    const text = { ...row('a'), search_text: 'body', user_prompts: ['ask'] }

    const first = cache.loadSessionText('a')
    expect(cache.loadSessionText('a')).toBe(first)
    expect(requested).toEqual(['a'])
    pending.get('a')!.resolve(text)
    expect(await first).toEqual(text)
    // The formatter reads it synchronously from here on, with no second read.
    expect(cache.sessionText('a')).toEqual(text)
    expect(await cache.loadSessionText('a')).toEqual(text)
    expect(requested).toEqual(['a'])

    cache.invalidate()
    expect(cache.sessionText('a')).toBeUndefined()
    const after = cache.loadSessionText('a')
    expect(requested).toEqual(['a', 'a'])
    pending.get('a')!.resolve(text)
    expect(await after).toEqual(text)
  })

  test('a vanished session and a failed read both leave the row on metadata', async () => {
    const cache = new ResumeSessionCache({
      listSessions: () => Promise.resolve([]),
      listSessionsWithText: () => Promise.resolve([]),
      sessionWithText: sessionId => sessionId === 'gone'
        ? Promise.resolve(null)
        : Promise.reject(new Error('unreadable')),
    })
    expect(await cache.loadSessionText('gone')).toBeNull()
    expect(await cache.loadSessionText('broken')).toBeNull()
    expect(cache.sessionText('gone')).toBeUndefined()
  })

  test('focused text is bounded so browsing a long list cannot grow without limit', async () => {
    const cache = new ResumeSessionCache({
      listSessions: () => Promise.resolve([]),
      listSessionsWithText: () => Promise.resolve([]),
      sessionWithText: sessionId => Promise.resolve({ ...row(sessionId), search_text: sessionId, user_prompts: [] }),
    })
    for (let index = 0; index < 40; index++) await cache.loadSessionText(`s${index}`)
    // The oldest focus is evicted; the most recent stay resident.
    expect(cache.sessionText('s0')).toBeUndefined()
    expect(cache.sessionText('s39')).toBeDefined()
  })
})

describe('resume cache text version', () => {
  test('holds still while nothing changes, so formatted rows can be reused', async () => {
    const f = fixture()
    const start = f.cache.textVersion
    const full = f.cache.all()
    f.metadata[0]!.result.resolve([row('a'), row('b')])
    await full
    // Metadata alone does not change known text.
    expect(f.cache.textVersion).toBe(start)
    expect(f.cache.textVersion).toBe(start)
  })

  test('advances when the full text catalog lands', async () => {
    const f = fixture()
    const before = f.cache.textVersion
    const load = f.cache.text()
    f.text[0]!.resolve([{ ...row('a'), search_text: 'hello', user_prompts: ['hello'] }])
    await load
    expect(f.cache.textVersion).not.toBe(before)
    expect(f.cache.sessionText('a')?.search_text).toBe('hello')
  })

  test('advances when one focused row loads its text', async () => {
    const cache = new ResumeSessionCache({
      listSessions: () => Promise.resolve([]),
      listSessionsWithText: () => Promise.resolve([]),
      sessionWithText: sessionId => Promise.resolve({ ...row(sessionId), search_text: 'focused', user_prompts: [] }),
    })
    const before = cache.textVersion
    await cache.loadSessionText('a')
    expect(cache.textVersion).not.toBe(before)
  })

  test('advances on invalidation and removal, so stale rows cannot be reused', async () => {
    const f = fixture()
    const load = f.cache.text()
    f.text[0]!.resolve([
      { ...row('a'), search_text: 'a text', user_prompts: [] },
      { ...row('b'), search_text: 'b text', user_prompts: [] },
    ])
    await load

    const loaded = f.cache.textVersion
    f.cache.remove('a')
    expect(f.cache.textVersion).not.toBe(loaded)
    // Removed rows are gone from the by-id lookup too, not just the list.
    expect(f.cache.sessionText('a')).toBeUndefined()
    expect(f.cache.sessionText('b')?.search_text).toBe('b text')

    const removed = f.cache.textVersion
    f.cache.invalidate()
    expect(f.cache.textVersion).not.toBe(removed)
  })

  test('a rename drops stale text containing the old name', async () => {
    const f = fixture()
    const load = f.cache.text()
    f.text[0]!.resolve([{ ...row('a'), search_text: 'old name', user_prompts: [] }])
    await load

    const before = f.cache.textVersion
    f.cache.rename({ ...row('a'), title: 'new name' })
    expect(f.cache.textVersion).not.toBe(before)
    expect(f.cache.sessionText('a')).toBeUndefined()
  })
})
