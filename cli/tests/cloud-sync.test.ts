import { describe, expect, test } from 'bun:test'
import { CloudSync, ModelAnnouncer } from '../src/term/app/cloud-sync.js'

function fixture() {
  let now = 100_000
  const calls: string[] = []
  const deps = {
    authenticated: async () => { calls.push('auth'); return true },
    syncNotices: async () => { calls.push('notices'); return ['notice'] },
    syncModels: async () => { calls.push('models') },
    noticesUpdated: (_notices: string[]) => { calls.push('publish-notices') },
    modelsUpdated: () => { calls.push('publish-models') },
    now: () => now,
  }
  return { deps, calls, advance: (delta: number) => { now += delta } }
}

describe('cloud sync lifecycle', () => {
  test('single flight, interval throttle and forced refresh', async () => {
    const f = fixture()
    const sync = new CloudSync(f.deps)
    const first = sync.run()
    expect(sync.run(true)).toBe(first)
    expect(await first).toEqual({ noticesSynced: true, modelsSynced: true })
    expect(await sync.run()).toBeNull()
    expect(f.calls).toHaveLength(5)
    await sync.run(true)
    expect(f.calls).toHaveLength(10)
    f.advance(15_000)
    await sync.run()
    expect(f.calls).toHaveLength(15)
  })

  test('notice and model failures do not suppress the independent successful refresh', async () => {
    for (const failing of ['syncNotices', 'syncModels'] as const) {
      const f = fixture()
      const sync = new CloudSync({ ...f.deps, [failing]: async () => { throw new Error('offline') } })
      const result = await sync.run()
      expect(result).toEqual({ noticesSynced: failing !== 'syncNotices', modelsSynced: failing !== 'syncModels' })
    }
  })

  test('signed out does not call remote sync or publish', async () => {
    const f = fixture()
    const sync = new CloudSync({ ...f.deps, authenticated: async () => false })
    expect(await sync.run()).toBeNull()
    expect(f.calls).toEqual([])
  })

  test('dispose during a remote request prevents publication and subsequent requests', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<string[]>()
    const started = Promise.withResolvers<void>()
    const sync = new CloudSync({
      ...f.deps,
      syncNotices: () => { started.resolve(); return pending.promise },
    })
    const task = sync.run()
    await started.promise
    sync.dispose()
    pending.resolve(['late'])
    expect(await task).toBeNull()
    expect(f.calls).toEqual(['auth'])
    expect(await sync.run(true)).toBeNull()
  })

  test('dispose during authentication suppresses all work', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<boolean>()
    const sync = new CloudSync({ ...f.deps, authenticated: () => pending.promise })
    const task = sync.run()
    sync.dispose()
    pending.resolve(true)
    expect(await task).toBeNull()
    expect(f.calls).toEqual([])
  })

  test('authentication errors release single-flight ownership for retry', async () => {
    const f = fixture()
    let fail = true
    const sync = new CloudSync({ ...f.deps, authenticated: async () => {
      if (fail) throw new Error('auth unavailable')
      return true
    } })
    await expect(sync.run()).rejects.toThrow('auth unavailable')
    fail = false
    expect(await sync.run()).toEqual({ noticesSynced: true, modelsSynced: true })
  })
})

describe('ModelAnnouncer', () => {
  test('announces a model once even when it flaps in and out of the catalog', () => {
    const announcer = new ModelAnnouncer()
    announcer.seed(['kimi-k3'])
    expect(announcer.fresh([{ model: 'kimi-k3' }])).toEqual([])

    // Appears: announced.
    expect(announcer.fresh([{ model: 'kimi-k3' }, { model: 'new-chat-model' }]).map(m => m.model)).toEqual(['new-chat-model'])
    // Disappears, then reappears: silent.
    expect(announcer.fresh([{ model: 'kimi-k3' }])).toEqual([])
    expect(announcer.fresh([{ model: 'kimi-k3' }, { model: 'new-chat-model' }])).toEqual([])
    // A genuinely new id is still reported.
    expect(announcer.fresh([{ model: 'gpt-x' }]).map(m => m.model)).toEqual(['gpt-x'])
  })
})
