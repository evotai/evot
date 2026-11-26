import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { privateSocketDirectory, registerTerminal, type SessionBadge } from '../../../src/features/remote/discovery.js'
import type { RemoteHost } from '../../../src/features/remote/protocol.js'
import { ancestors, formatWindows, listWindows, pickWindow, type WindowRow } from '../../../src/features/restart/client.js'
import type { RestartRequest, RestartStatus, WindowControl } from '../../../src/features/restart/protocol.js'

const host: RemoteHost = { snapshot() { throw Error('unexpected snapshot') }, act() { throw Error('unexpected action') } }
const badge = (session: string): (() => SessionBadge) => () => ({ workspace: 'fixture', session, title: 'private title', phase: 'working' })

function control(status: Omit<RestartStatus, 'terminal'>) {
  const requests: RestartRequest[] = []
  let terminal = ''
  const window: WindowControl = {
    status: () => ({ ...status, terminal }),
    request(request) { requests.push(request); return { accepted: true, message: 'Restart scheduled after the current turn.', status: { ...status, terminal, restart: 'pending', waitingFor: 'turn' } } },
  }
  return { window, requests, bind(id: string) { terminal = id } }
}

test('each window answers restart status and requests on its private socket, without a profile scope', async () => {
  const home = '/fixture/' + crypto.randomUUID()
  const current = control({ pid: 4242, session: 'session-current', outdated: true, restart: 'none' })
  const window = registerTerminal(home, host, badge('session-current'), undefined, undefined, current.window)
  const older = registerTerminal(home, host, badge('session-older'))
  current.bind(window.id)
  const dir = privateSocketDirectory(home)
  try {
    const rows = await listWindows(dir)
    const byId = new Map(rows.map(row => [row.terminal, row]))
    expect(byId.get(window.id)).toEqual({ terminal: window.id, session: 'session-current', status: { pid: 4242, session: 'session-current', terminal: window.id, outdated: true, restart: 'none' } })
    // An older window is listed by the session its badge holds, nothing more.
    expect(byId.get(older.id)).toEqual({ terminal: older.id, session: 'session-older', status: null })
    const post = (body: unknown) => fetch('http://localhost/restart', { unix: join(dir, window.id + '.sock'), method: 'POST', body: JSON.stringify(body) } as RequestInit)
    expect((await post({ action: 'restart' })).status).toBe(200)
    expect((await post({ action: 'now' })).status).toBe(400) // interrupting work is never a remote request
    expect(current.requests).toEqual([{ action: 'restart' }])
  } finally { window.close(); older.close() }
  // The next image binds the same path right after an exec: close removes it synchronously.
  expect(existsSync(join(dir, window.id + '.sock'))).toBe(false)
})

test('the window bus remembers how it was shared, for a restart to repeat', () => {
  const home = '/fixture/' + crypto.randomUUID()
  const bus = registerTerminal(home, host, badge('s'))
  try {
    expect(bus.sharing).toBe('inherit')
    bus.share(null); expect(bus.sharing).toBe('off')
    bus.share('c'.repeat(24)); expect(bus.sharing).toBe('c'.repeat(24))
  } finally { bus.close() }
})

const row = (session: string | null, pid: number | null, terminal = crypto.randomUUID()): WindowRow =>
  ({ terminal, session, status: pid === null ? null : { pid, session, terminal, outdated: true, restart: 'none' } })

test('without a target the command restarts the session it runs under; a target is a unique id prefix', () => {
  const parents = new Map([[900, 800], [800, 700], [700, 1], [600, 1]])
  expect([...ancestors(900, parents)]).toEqual([800, 700])
  const mine = row('aaaa1111-session', 800), other = row('aaaa2222-session', 600), old = row('bbbb3333-session', null)
  const rows = [mine, other, old]
  expect(pickWindow(rows, undefined, ancestors(900, parents))).toBe(mine)
  expect(pickWindow(rows, undefined, new Set([5]))).toContain('Not running inside an evot session')
  expect(pickWindow(rows, 'aaaa2', new Set())).toBe(other)
  expect(pickWindow(rows, 'aaaa', new Set())).toContain('matches 2 windows')
  expect(pickWindow(rows, 'aa', new Set())).toContain('at least 4 characters')
  expect(pickWindow(rows, 'cccc', new Set())).toContain('No open evot window')
  expect(pickWindow(rows, 'bbbb', new Set())).toBe(old)
  expect(formatWindows(rows)).toContain('older evot without restart control')
  expect(formatWindows([{ ...mine, status: { ...mine.status!, restart: 'pending', waitingFor: 'background' } }]))
    .toContain('restart: pending, after background tasks and their results')
})
