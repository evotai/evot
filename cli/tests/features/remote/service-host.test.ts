import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostElection } from '../../../src/features/remote/host-election.js'
import { ServiceHost } from '../../../src/features/remote/service-host.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'evot-host-')), scope = 'a'.repeat(24)
  const windows = new Set<string>(), physical = new Set<string>()
  cleanup.push(async () => rmSync(dir,{recursive:true,force:true}))
  function window(id: string, explicit = false) {
    windows.add(id)
    const election = new HostElection(dir,scope,id)
    const w = {busy:false, fail:false, refuse:false, closed:false, beforeRemote:async () => {}, notices:[] as string[]}
    const controller = new ServiceHost(election,{
      eligible:() => !w.busy, gone:async name => !windows.has(name), preflight:async () => {},
      async start(current) {
        expect(current()).toBe(true)
        expect([...physical].every(service => service.startsWith(id+':'))).toBe(true)
        physical.add(id+':console')
        await w.beforeRemote()
        if (w.fail) throw Error('gateway failed')
        if (current()) physical.add(id+':remote')
        return 'Console and Remote'
      },
      async stop() {
        if (w.refuse) throw Error('active Console request')
        physical.delete(id+':console'); physical.delete(id+':remote')
      }, notice: text => w.notices.push(text),
    },explicit)
    async function close(restarting = false) {
      if (w.closed) return
      w.closed = true; windows.delete(id); w.refuse = false
      await controller.dispose(restarting)
    }
    cleanup.push(close)
    return {w,election,controller,tick:() => controller.tick(),close}
  }
  return {window,physical}
}

test('busy windows do not fill vacancies or preempt, but a committed busy host yields both services', async () => {
  const f = fixture(), a = f.window('a'), b = f.window('b'), c = f.window('c',true)
  a.w.busy = true; await a.tick(); expect(f.physical.size).toBe(0)
  await b.tick(); b.w.busy = true; a.w.busy = false; await a.tick()
  expect([...f.physical]).toEqual(['b:console','b:remote'])
  await c.tick(); await b.tick(); await c.tick()
  expect([...f.physical]).toEqual(['c:console','c:remote'])
})

test.each([false,true])('a superseded startup cannot commit or roll back over the latest claimant (late failure: %p)', async fail => {
  const f = fixture(), a = f.window('a'), b = f.window('b',true), c = f.window('c',true)
  await a.tick(); await b.tick(); await a.tick()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  b.w.beforeRemote = async () => { entered.resolve(); await release.promise }; b.w.fail = fail
  const pending = b.tick(); await entered.promise
  try {
    await c.tick(); expect(c.election.ballot().target).toBe('c'); expect([...f.physical]).toEqual(['b:console'])
  } finally { release.resolve() }
  await pending; await b.tick(); await c.tick(); await a.tick()
  expect(c.election.ballot()).toMatchObject({target:'c',previous:'c'})
  expect([...f.physical]).toEqual(['c:console','c:remote']); expect(b.controller.owner).toBe(false)
})

test('restart reservation blocks default election but not --host; returning image cannot replay it', async () => {
  const f = fixture(), a = f.window('a',true), idle = f.window('idle')
  await a.tick(); await a.close(true); await idle.tick()
  expect(idle.election.ballot().target).toBe('a'); expect(f.physical.size).toBe(0)
  const c = f.window('c',true); await c.tick()
  const resumed = f.window('a'); await resumed.tick()
  expect(c.election.ballot().target).toBe('c'); expect([...f.physical]).toEqual(['c:console','c:remote'])
})

test('a failed gateway start releases the partial Console and restores the last ready owner even when busy', async () => {
  const f = fixture(), a = f.window('a'), b = f.window('b',true)
  await a.tick(); a.w.busy = true; b.w.fail = true
  await b.tick(); await a.tick(); await b.tick()
  expect(f.physical.size).toBe(0); expect(b.election.ballot()).toMatchObject({target:'a',error:'gateway failed'})
  await a.tick(); expect([...f.physical]).toEqual(['a:console','a:remote'])
})

test('a failed takeover during restart preserves the original reservation and can restore it', async () => {
  const f = fixture(), a = f.window('a'), b = f.window('b',true), idle = f.window('idle')
  await a.tick(); await a.close(true)
  b.w.fail = true; await b.tick(); await idle.tick()
  expect(idle.election.ballot().reserved).toBeGreaterThan(Date.now())
  expect(idle.election.ballot().target).toBe('a')
  const next = f.window('a'); await next.tick()
  expect([...f.physical]).toEqual(['a:console','a:remote'])
})

test('an abandoned restart reservation expires and an ordinary idle window can fill the vacancy', async () => {
  const f = fixture(), a = f.window('a'), idle = f.window('idle')
  await a.tick()
  const old = Date.now() - 31_000, clock = spyOn(Date,'now').mockReturnValue(old)
  try { await a.close(true) } finally { clock.mockRestore() }
  expect(idle.election.ballot().target).toBe('a')
  await idle.tick(); await idle.tick()
  expect([...f.physical]).toEqual(['idle:console','idle:remote'])
})

test('an undrainable Console refuses the handoff without stopping the gateway', async () => {
  const f = fixture(), a = f.window('a'), b = f.window('b',true)
  await a.tick(); a.w.refuse = true
  await b.tick(); await a.tick(); await b.tick()
  expect([...f.physical]).toEqual(['a:console','a:remote'])
  expect(b.w.notices.at(-1)).toContain('active Console request')
})
