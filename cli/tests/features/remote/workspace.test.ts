import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerTerminal, profileKey, type SessionBadge } from '../../../src/features/remote/discovery.js'
import { phoneWorkspace } from '../../../src/features/remote/workspace.js'
import type { SessionMeta } from '../../../src/native/index.js'

test('one live destination per session; attach without scanning history, preferring active windows then the gateway', async () => {
  const home = '/fixture/' + crypto.randomUUID()
  const scope = 'fixture'
  const host = { snapshot() { throw Error('unused') }, act() {} }
  let running = false
  const badge = (session: string, phoneCreated: boolean): SessionBadge => ({
    title: 'same title', workspace: 'fixture', session, phoneCreated,
    phase: phoneCreated && running ? 'working' : 'idle',
  })
  const local = registerTerminal(home, host, () => badge('s', false))
  const phone = registerTerminal(home, host, () => badge('s', true))
  const empty = [false, true].map(child => registerTerminal(home, host, () => badge('', child)))
  const peers = [local, phone, ...empty]
  const workspace = phoneWorkspace(local, { listSessions: async () => { throw Error('unexpected history scan') }, deleteSession: async () => { throw Error('unexpected delete') }, listSessionsWithText: async () => [] }, home, '/fixture', scope)
  try {
    for (const peer of peers) peer.share(scope)
    for (const owner of [local, phone]) {
      running = owner === phone
      const list = await workspace.list(true)
      expect(list.online.filter(row => row.session === 's').map(row => row.terminal)).toEqual([owner.id])
      expect(list.online.filter(row => !row.session)).toHaveLength(2)
      expect((await workspace.resolveSession('s')).rows).toEqual([{ session:'s', terminal:owner.id }])
      expect(await workspace.open(crypto.randomUUID(), 's', () => true)).toBe(owner.id)
    }
  } finally {
    for (const peer of peers) peer.close()
  }
})

test('history does not disclose or duplicate an unshared occupied session; crashed TUIs release occupancy', async () => {
  const home = '/fixture/' + crypto.randomUUID(),
    host = {
      snapshot() {
        throw Error('unused')
      },
      act() {},
    }
  const badge = (session: string): SessionBadge => ({
    session,
    workspace: 'fixture',
    title: 'live ' + session,
    phase: 'idle',
  })
  const a = registerTerminal(home, host, () => badge('a')),
    b = registerTerminal(home, host, () => badge('b'))
  const history = ['a', 'b', 'saved', 'scheduled'].map(
    (session_id) =>
      ({
        session_id,
        cwd: '/fixture',
        title: session_id,
        turns: 1,
        source: session_id === 'scheduled' ? 'automation' : 'repl',
      } as SessionMeta)
  )
  const deleted: string[] = []
  const workspace = phoneWorkspace(a, { listSessions: async () => history, deleteSession: async id => { deleted.push(id); return id === 'saved' }, listSessionsWithText: async () => [] }, home, '/fixture', 'scope')
  try {
    a.share('scope')
    const state = await workspace.list()
    expect(state.online.map((t) => t.session)).toEqual(['a'])
    expect(state.history.map((t) => t.session)).toEqual(['saved'])
    expect((await workspace.resolveSession('b')).rows).toEqual([])
    expect((await workspace.resolveSession('saved')).rows).toEqual([{session:'saved'}])
    // Deletion from the phone: never while any terminal window (shared or hidden) holds the session.
    await expect(workspace.remove('b')).rejects.toThrow('open in a terminal window')
    await expect(workspace.remove('a')).rejects.toThrow('open in a terminal window')
    expect(deleted).toEqual([])
    expect(await workspace.remove('saved')).toBe(true)
    expect(await workspace.remove('gone')).toBe(false)
    expect(deleted).toEqual(['saved', 'gone'])
    await expect(workspace.open(crypto.randomUUID(), 'b', () => true)).rejects.toThrow('another terminal')
    b.share('scope')
    expect(await workspace.open(crypto.randomUUID(), 'b', () => true)).toBe(b.id)
    await expect(workspace.open(crypto.randomUUID(), 'scheduled', () => true)).rejects.toThrow('no longer exists')
    const socket = join(`/tmp/evot-remote-${process.getuid?.()}-${profileKey(home)}`, crypto.randomUUID() + '.sock')
    // The kernel leaves this AF_UNIX pathname behind when its owner exits.
    Bun.spawnSync([
      process.execPath,
      '-e',
      "Bun.serve({unix:process.argv.at(-1), fetch:()=>new Response()}); process.kill(process.pid,'SIGKILL')",
      socket,
    ])
    expect(existsSync(socket)).toBe(true)
    expect((await workspace.list()).history.map((t) => t.session)).toEqual(['saved'])
    expect(existsSync(socket)).toBe(false)
  } finally {
    a.close()
    b.close()
  }
})

test.skipIf(!Bun.which('tmux'))('four phone terminals block new launches but not following an open session', async () => {
  const tmux = Bun.which('tmux')
  if (!tmux) throw Error('tmux unavailable')
  const home = '/fixture/' + crypto.randomUUID(), scope = 'a'.repeat(24)
  const group = 'evot-phone-' + profileKey(home) + '-' + scope
  const tm = (...args: string[]) => Bun.spawnSync([tmux, '-L', group, '-f', '/dev/null', ...args], { timeout: 2500 })
  const host = { snapshot() { throw Error('unused') }, act() {} }
  const gateway = registerTerminal(home, host, () => ({ session: 'live', workspace: 'w', title: 'Live', phase: 'idle' }))
  const workspace = phoneWorkspace(gateway, {
    listSessions: async () => [{ session_id: 'saved', cwd: '/tmp', title: 'Saved', source: 'repl' } as SessionMeta],
    listSessionsWithText: async () => [],
    deleteSession: async () => false,
  }, home, '/tmp', scope)
  try {
    gateway.share(scope)
    for (let i = 0; i < 4; i++) {
      expect(tm('new-session', '-d', '-s', `chat-${crypto.randomUUID()}`, '--', 'sleep', '60').exitCode).toBe(0)
    }
    const open = (session: string | null) => workspace.open(crypto.randomUUID(), session, () => true)
    await expect(open(null)).rejects.toThrow('4 phone terminals are already open')
    await expect(open('saved')).rejects.toThrow('4 phone terminals are already open')
    expect(await open('live')).toBe(gateway.id)
    expect(tm('list-sessions', '-F', '#{session_name}').stdout.toString().trim().split('\n')).toHaveLength(4)
  } finally {
    tm('kill-server')
    gateway.close()
  }
}, 15_000)

test.skipIf(!Bun.which('tmux'))('deleting a session closes only an idle window this gateway launched for a phone', async () => {
  const home = '/fixture/' + crypto.randomUUID(), scope = 'a'.repeat(24), tmux = Bun.which('tmux')!
  const group = 'evot-phone-' + profileKey(home) + '-' + scope
  const host = { snapshot() { throw Error('unused') }, act() {} }
  let phase: SessionBadge['phase'] = 'idle'
  const badge = (session: string, phoneCreated: boolean) => (): SessionBadge => ({ session, phoneCreated, phase: phoneCreated ? phase : 'idle', workspace: 'w', title: session })
  const gateway = registerTerminal(home, host, badge('', false))
  const local = registerTerminal(home, host, badge('local', false))
  const stray = registerTerminal(home, host, badge('stray', true)) // phone-created, but not in this gateway's tmux group
  const parked = registerTerminal(home, host, badge('parked', true))
  const tm = (...args: string[]) => Bun.spawnSync([tmux, '-L', group, '-f', '/dev/null', ...args], { stdout: 'ignore', stderr: 'ignore' })
  tm('new-session', '-d', '-s', 'chat-' + parked.id, '--', 'sleep', '60')
  // The TUI inside the tmux session closes its socket when tmux ends it.
  const watch = setInterval(() => { if (tm('has-session', '-t', '=chat-' + parked.id).exitCode !== 0) parked.close() }, 50)
  const deleted: string[] = []
  const workspace = phoneWorkspace(gateway, { listSessions: async () => [], deleteSession: async id => { deleted.push(id); return true }, listSessionsWithText: async () => [] }, home, '/fixture', scope)
  try {
    for (const peer of [gateway, local, stray, parked]) peer.share(scope)
    await expect(workspace.remove('local')).rejects.toThrow('open in a terminal window')
    await expect(workspace.remove('stray')).rejects.toThrow('open in a terminal window')
    phase = 'working'
    await expect(workspace.remove('parked')).rejects.toThrow('open in a terminal window')
    expect(tm('has-session', '-t', '=chat-' + parked.id).exitCode).toBe(0)
    phase = 'idle'
    expect(await workspace.remove('parked')).toBe(true)
    expect(tm('has-session', '-t', '=chat-' + parked.id).exitCode).not.toBe(0)
    expect(deleted).toEqual(['parked'])
  } finally {
    clearInterval(watch)
    tm('kill-server')
    for (const peer of [gateway, local, stray, parked]) peer.close()
  }
})
