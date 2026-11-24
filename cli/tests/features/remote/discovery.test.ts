import { expect, test } from 'bun:test'
import { relayPermits } from '../../../src/features/remote/relay-permit.js'
import { startFixtureRelay } from '../../helpers/remote-relay.js'
import { registerTerminal, type SessionBadge } from '../../../src/features/remote/discovery.js'
import type { RemoteHost } from '../../../src/features/remote/protocol.js'

test('a gateway relay ticket confirms only one pending operation for its addressed window', () => {
  const permits = relayPermits(), a = crypto.randomUUID(), b = crypto.randomUUID()
  const first = permits.issue(a, '/badge')
  expect(permits.consume(first, b + '/badge')).toBe(false)
  expect(permits.consume(first, a + '/action')).toBe(false)
  expect(permits.consume(first, a + '/badge')).toBe(true)
  expect(permits.consume(first, a + '/badge')).toBe(false)
  const second = permits.issue(a, '/state'); permits.clear()
  expect(permits.consume(second, a + '/state')).toBe(false)
})

test('inherited membership is pinned at registration and rechecked on every read and action', async () => {
  const home = '/fixture/' + crypto.randomUUID()
  const a = 'a'.repeat(24), b = 'b'.repeat(24)
  let current: string | null = a, actions = 0
  const badge: SessionBadge = {workspace:'fixture',session:'only-A',title:'Title A',phase:'idle'}
  const host: RemoteHost = {snapshot(){ throw Error('unexpected snapshot') },act(){ actions++ }}
  const gateway = registerTerminal(home,host,()=>badge)
  const peer = registerTerminal(home,host,()=>badge,undefined,{session:()=>badge.session,currentScope:()=>current})
  const act = () => gateway.request(peer.id,'/action',{kind:'tool-view',generation:1,expanded:true})
  gateway.route(a)
  expect((await act()).status).toBe(403) // scope alone, without the active gateway lease, is not permission
  const release = await startFixtureRelay(home, a, gateway)
  try {
    expect((await act()).status).toBe(204)
    current = null; expect((await act()).status).toBe(403)
    current = b; expect((await gateway.request(peer.id,'/state')).status).toBe(403)
    expect(await (await gateway.request(peer.id,'/badge')).json()).not.toHaveProperty('title')
    gateway.route(b); expect((await act()).status).toBe(403) // B does not inherit A's session
    current = a; gateway.route(a); peer.share(null); expect((await act()).status).toBe(403)
    peer.share(a); current = b; expect((await act()).status).toBe(403) // also recheck explicit invites
    expect(actions).toBe(1)
  } finally { release(); gateway.close(); peer.close() }
})

test('private bus discovers sibling TUIs without LAN listeners, routes only within the same profile', async () => {
  const home = '/fixture/' + crypto.randomUUID(),
    calls: string[] = []
  const host: RemoteHost = {
    snapshot() {
      throw Error('unused')
    },
    act(a) {
      calls.push(a.kind)
    },
  }
  const row: SessionBadge = { workspace: 'frontend', title: 'work', phase: 'working', session: 'a' }
  const a = registerTerminal(home, host, () => row),
    b = registerTerminal(home, host, () => ({ ...row, phase: 'input' })),
    c = registerTerminal(home + '-private', host, () => row)
  try {
    a.share('https')
    expect((await a.inventory()).online.map((r) => r.terminal)).toEqual([a.id])
    expect((await a.request(b.id, '/state')).status).toBe(403)
    b.share('http')
    expect((await a.request(b.id, '/action', { kind: 'stop', generation: 1 })).status).toBe(403)
    b.share('https')
    expect((await a.inventory()).online.map((r) => r.terminal).sort()).toEqual([a.id, b.id].sort())
    expect((await a.request(b.id, '/action', { kind: 'stop', generation: 1 })).status).toBe(204)
    expect(calls).toEqual(['stop'])
    await expect(a.request(c.id, '/state')).rejects.toThrow()
    await expect(a.request('../foreign', '/state')).rejects.toThrow()
    b.close()
    expect((await a.inventory()).online).toHaveLength(1)
  } finally {
    a.close()
    b.close()
    c.close()
  }
})
