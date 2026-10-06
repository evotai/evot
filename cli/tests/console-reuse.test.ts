import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundScheduler } from '../src/background/scheduler.js'
import { discoverDashboard, ownedDashboardPort, registerDashboard, type ServerState } from '../src/term/app/server.js'
import { TerminalTitle } from '../src/term/title.js'
import { inspectConsole } from '../src/channels/console-client.js'
import { observeFeishu, bindFeishuChat } from '../src/channels/feishu/client.js'
import { setupFeishu } from '../src/channels/feishu/onboarding.js'

const snapshot = { env_file_path: '/tmp/console.env', feishu: { app_id: 'test_app', app_secret_set: true, default_chat_id: '' } }

test('an existing console exposes settings and setup from its owning process', async () => {
  let bound: unknown
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/api/channels/feishu') return Response.json(snapshot)
    if (request.method === 'POST') {
      bound = await request.json()
      return Response.json({ ok: true })
    }
    return Response.json({ configured: true, revision: 'v1', default_chat_id: '', chats: ['oc_owner'], connection: { state: 'connected', message: '' } })
  } })
  try {
    const address = `http://127.0.0.1:${server.port}`
    expect((await inspectConsole(address)).env_file_path).toBe('/tmp/console.env')
    expect((await observeFeishu(address)).chats).toEqual(['oc_owner'])
    await bindFeishuChat(address, 'v1', 'oc_owner')
    expect(bound).toEqual({ revision: 'v1', chat_id: 'oc_owner' })
  } finally { await server.stop(true) }
})

test('dashboard reuses only the same configuration, including symlink aliases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-dashboard-'))
  const envFile = join(dir, 'evot.env')
  const alias = join(dir, 'alias.env')
  writeFileSync(envFile, '')
  symlinkSync(envFile, alias)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ ...snapshot, env_file_path: envFile })
  } })
  try {
    const state = await discoverDashboard(server.port, alias)
    expect(state?.address).toBe(`http://127.0.0.1:${server.port}`)
    expect(state?.envFile).toBe(envFile)
    expect(state?.owned).toBe(false)
    expect(ownedDashboardPort(state)).toBeNull()
    expect(await discoverDashboard(server.port, join(dir, 'other.env'))).toBeNull()
    expect(await discoverDashboard(server.port)).toBeNull()
  } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }) }
})

test('terminal port appears only for the owner, including same-address ownership changes', () => {
  const owned: ServerState = {
    port: 8082, address: 'http://127.0.0.1:8082', channels: [],
    envFile: '/tmp/console.env', startedAt: 1, owned: true,
  }
  let state: ServerState | null = null
  const title = new TerminalTitle('/tmp/evot', () => ownedDashboardPort(state))
  const writes: string[] = []
  const output = spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk))
    return true
  })
  try {
    title.set()
    expect(writes.at(-1)).toBe('\x1b]0;evot - evot\x07')
    state = { ...owned, owned: false }
    title.set('*')
    expect(writes.at(-1)).toBe('\x1b]0;* evot - evot\x07')
    state = owned
    title.set('*')
    expect(writes.at(-1)).toBe('\x1b]0;* evot - evot · :8082\x07')
    state = { ...owned, owned: false }
    title.set()
    expect(writes.at(-1)).toBe('\x1b]0;evot - evot\x07')
    state = owned
    title.freeze('?')
    expect(writes.at(-1)).toBe('\x1b]0;? evot - evot · :8082\x07')
    state = { ...owned, owned: false }
    title.refresh()
    expect(writes.at(-1)).toBe('\x1b]0;? evot - evot\x07')
    title.set('*')
    expect(writes.at(-1)).toBe('\x1b]0;? evot - evot\x07')
    state = owned
    title.refresh()
    expect(writes.at(-1)).toBe('\x1b]0;? evot - evot · :8082\x07')
    title.unfreeze()
    state = null
    title.set()
    expect(writes.at(-1)).toBe('\x1b]0;evot - evot\x07')
  } finally { output.mockRestore() }
})

test('shared dashboard is published, cleared on outage, and not stopped on window close', async () => {
  let available = true
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return available ? Response.json(snapshot) : new Response('', { status: 503 })
  } })
  const scheduler = new BackgroundScheduler()
  const published: (string | null)[] = []
  let ownedStops = 0
  const dispose = registerDashboard(scheduler, {
    attempt: () => discoverDashboard(server.port, snapshot.env_file_path),
    // Native stop is ownership-scoped, not an HTTP shutdown of a discovered server.
    stop: async () => { ownedStops++ },
    publish: state => { published.push(state?.address ?? null) },
  })
  try {
    await scheduler.trigger('dashboard')
    expect(published.at(-1)).toBe(`http://127.0.0.1:${server.port}`)
    available = false
    await scheduler.trigger('dashboard')
    expect(published.at(-1)).toBeNull()
    available = true
    await scheduler.trigger('dashboard')
    expect(published.at(-1)).not.toBeNull()
    dispose()
    expect(published.at(-1)).toBeNull()
    expect(ownedStops).toBe(1)
    expect((await inspectConsole(`http://127.0.0.1:${server.port}`)).env_file_path).toBe(snapshot.env_file_path)
  } finally { scheduler.dispose(); await server.stop(true) }
})

test('dashboard discovery hides unrelated services and redirects', async () => {
  let redirect = false
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return redirect ? Response.redirect('http://127.0.0.1:1', 302) : Response.json({ ok: true })
  } })
  try {
    expect(await discoverDashboard(server.port, snapshot.env_file_path)).toBeNull()
    redirect = true
    expect(await discoverDashboard(server.port, snapshot.env_file_path)).toBeNull()
  } finally { await server.stop(true) }
})

test('missing setup endpoint fails once without legacy fallback or a fake connecting state', async () => {
  const paths: string[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname)
    return new Response('', { status: 404 })
  } })
  try {
    const address = `http://127.0.0.1:${server.port}`
    await expect(observeFeishu(address)).rejects.toThrow('needs the current evot build')
    expect(paths).toEqual(['/api/channels/feishu/setup'])
    let waits = 0
    await expect(setupFeishu({
      consoleUrl: `${address}/feishu`, signal: new AbortController().signal,
      observe: () => observeFeishu(address),
      bind: async () => { throw new Error('must not bind') },
      ask: async () => { throw new Error('must not ask') },
      wait: async () => { waits++; return false },
    })).rejects.toThrow('needs the current evot build')
    expect(waits).toBe(0)
    expect(paths).toEqual(['/api/channels/feishu/setup', '/api/channels/feishu/setup'])
  } finally { await server.stop(true) }
})

test('an unrelated service or redirect is not treated as an evot console', async () => {
  let redirect = false
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return redirect ? Response.redirect('http://127.0.0.1:1', 302) : Response.json({ ok: true })
  } })
  try {
    const address = `http://127.0.0.1:${server.port}`
    await expect(inspectConsole(address)).rejects.toThrow('different service')
    redirect = true
    await expect(inspectConsole(address)).rejects.toThrow()
  } finally { await server.stop(true) }
})
