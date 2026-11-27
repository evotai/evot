import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { validTerminal } from '../remote/discovery.js'
import { privateSocketDirectory } from '../remote/socket-directory.js'
import { remoteHome } from '../remote/transport.js'
import { parseRestartStatus, RESTART_WAIT_TEXT, type RestartReply, type RestartStatus } from './protocol.js'

/** One evot window of this profile, as its private socket describes it.
 * `status` is null for an older evot without restart control. */
export interface WindowRow { terminal: string; session: string | null; status: RestartStatus | null }

export interface RestartArgs { target?: string; list: boolean; cancel: boolean }

const call = (dir: string, terminal: string, path: string, body?: unknown) => fetch('http://localhost' + path, {
  unix: join(dir, terminal + '.sock'),
  method: body ? 'POST' : 'GET',
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(2000),
} as RequestInit)

async function describe(dir: string, terminal: string): Promise<WindowRow | null> {
  try {
    const res = await call(dir, terminal, '/restart')
    if (res.ok) {
      const status = parseRestartStatus(await res.json())
      return status ? { terminal, session: status.session, status } : null
    }
    await res.body?.cancel()
    if (res.status !== 404) return null
    // An older window still answers its badge with the session it holds.
    const badge = await call(dir, terminal, '/badge')
    const session = badge.ok ? ((await badge.json()) as { session?: unknown }).session : undefined
    return { terminal, session: typeof session === 'string' && session ? session : null, status: null }
  } catch {
    return null // a closed window that left its socket behind
  }
}

export async function listWindows(dir: string): Promise<WindowRow[]> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.sock')).map(name => name.slice(0, -5)).filter(validTerminal)
  const rows = await Promise.all(names.map(terminal => describe(dir, terminal)))
  return rows.filter((row): row is WindowRow => row !== null)
}

/** pid → parent pid for every process this user can see. */
export function processParents(): Map<number, number> {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 })
  const table = new Map<number, number>()
  for (const line of (out.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) table.set(pid!, ppid!)
  }
  return table
}

export function ancestors(pid: number, parents: Map<number, number>): Set<number> {
  const seen = new Set<number>()
  for (let current = parents.get(pid); current !== undefined && current > 1 && !seen.has(current); current = parents.get(current)) seen.add(current)
  return seen
}

/** The window named by a session or terminal id prefix, or, without a target,
 * the evot process this command runs under (an agent's bash tool). */
export function pickWindow(rows: WindowRow[], target: string | undefined, ancestry: Set<number>): WindowRow | string {
  if (target === undefined) {
    const own = rows.find(row => row.status && ancestry.has(row.status.pid))
    return own ?? 'Not running inside an evot session. Name one: evot restart <session-id>.'
  }
  const wanted = target.toLowerCase()
  if (wanted.length < 4) return 'Use at least 4 characters of the session id.'
  const matches = rows.filter(row => row.session?.startsWith(wanted) || row.terminal.startsWith(wanted))
  if (matches.length === 1) return matches[0]!
  return matches.length ? `"${target}" matches ${matches.length} windows; use more of the id.` : `No open evot window has session "${target}".`
}

const shortId = (row: WindowRow) => (row.session ?? row.terminal).slice(0, 8)
const build = (status: RestartStatus) => status.outdated === null ? 'not installed' : status.outdated ? 'outdated' : 'current'
const restartText = (status: RestartStatus) => status.restart === 'pending' && status.waitingFor
  ? `pending, after ${RESTART_WAIT_TEXT[status.waitingFor]}` : status.restart

export function formatWindows(rows: WindowRow[]): string {
  if (!rows.length) return 'No open evot windows in this profile.'
  const lines = rows.map(row => row.status
    ? `  ${shortId(row).padEnd(9)} pid ${String(row.status.pid).padEnd(7)} ${build(row.status).padEnd(13)} restart: ${restartText(row.status)}${row.status.hosting ? ' · service host' : ''}`
    : `  ${shortId(row).padEnd(9)} older evot without restart control; restart it once by hand`)
  return ['Open evot windows:', ...lines].join('\n')
}

/** `evot restart [session] | --cancel [session] | --list`. Each window decides
 * its own moment; this only asks one of them. */
export async function runRestartCommand(args: RestartArgs): Promise<number> {
  const dir = privateSocketDirectory(remoteHome())
  const rows = await listWindows(dir)
  if (args.list) { console.log(formatWindows(rows)); return 0 }
  const picked = pickWindow(rows, args.target, args.target === undefined ? ancestors(process.pid, processParents()) : new Set())
  if (typeof picked === 'string') { console.error(picked); console.error(formatWindows(rows)); return 1 }
  if (!picked.status) { console.error(`Session ${shortId(picked)} runs an older evot without restart control. Restart it once by hand.`); return 1 }
  const res = await call(dir, picked.terminal, '/restart', { action: args.cancel ? 'cancel' : 'restart' })
  if (!res.ok) { console.error(`Session ${shortId(picked)} refused the request (${res.status}).`); return 1 }
  const reply = (await res.json()) as RestartReply
  const line = `Session ${shortId(picked)} (pid ${picked.status.pid}): ${reply.message}`
  if (reply.accepted) console.log(line)
  else console.error(line)
  return reply.accepted ? 0 : 1
}
