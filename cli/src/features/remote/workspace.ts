import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionMeta, SessionWithText } from '../../native/index.js'
import { newestSessionsFirst } from '../../session/cloud-sessions.js'
import { isInteractiveSession, sanitizeSessionTitle, shortenSessionCwd } from '../../session/resume.js'
import { profileKey, validTerminal, type TerminalBus } from './discovery.js'
import { liveSessions, phoneCatalog, type CatalogPage } from './catalog.js'
import { RemoteConflict } from './protocol.js'

export interface WorkspaceSource {
  listSessions(limit: number): Promise<SessionMeta[]>
  /** The same transcript text the TUI picker searches when the user types in /resume. */
  listSessionsWithText(limit: number): Promise<SessionWithText[]>
  /** Removes the saved session on this computer (and its cloud copy, if any). */
  deleteSession(sessionId: string): Promise<boolean>
}
export function phoneWorkspace(
  bus: TerminalBus,
  source: WorkspaceSource,
  home: string,
  cwd: string,
  scope: string,
  envFile?: string
) {
  const group = 'evot-phone-' + profileKey(home) + '-' + scope
  const tmuxIn = (tmux: string, ...args: string[]) =>
    Bun.spawnSync([tmux, '-L', group, '-f', '/dev/null', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 2500 })
  let listing: Promise<{ rows: SessionMeta[]; truncated: boolean }> | undefined, freshUntil = 0, listed = 0
  // Read only as many newest sessions as the phone can show (0 = all, for lookups).
  // Task runs and empty drafts are filtered after the read, so over-read by a margin
  // and report whether the disk had more than was read.
  function listPage(limit = 0) {
    if (!listing || Date.now() >= freshUntil || (listed !== 0 && (limit === 0 || limit > listed))) {
      freshUntil = Infinity // concurrent drawer opens share one disk scan
      listed = limit
      const read = limit ? limit * 2 : 0
      listing = source.listSessions(read)
        .then(rows => ({ rows: rows.filter(isInteractiveSession), truncated: read > 0 && rows.length >= read }))
        .finally(() => { freshUntil = Date.now() + 3000 })
    }
    return listing
  }
  const listHistory = (limit = 0) => listPage(limit).then(page => page.rows)
  let texts: Promise<Map<string, string>> | undefined, textsUntil = 0
  // Transcript text for the search box; one scan shared by every keystroke for 30 s.
  function searchTexts() {
    if (!texts || Date.now() >= textsUntil) {
      textsUntil = Infinity
      texts = source.listSessionsWithText(0)
        .then(rows => new Map(rows.map(r => [r.session_id, `${r.search_text} ${r.user_prompts.join(' ')}`.toLowerCase()])))
        .finally(() => { textsUntil = Date.now() + 30000 })
    }
    return texts
  }
  async function list(onlineOnly = false, page?: { limit: number; query: string }) {
    const history = onlineOnly ? [] : newestSessionsFirst(await listHistory())
    const { online, occupied, unavailable, privateWindows } = await bus.inventory()
    const matches = unavailable ? [] : history.filter(m => !occupied.has(m.session_id) && (!page?.query ||
      [basename(m.cwd), sanitizeSessionTitle(m.custom_title || m.title), m.session_id].some(v => v.toLowerCase().includes(page.query))))
    return {
      current: bus.shared ? bus.id : null,
      online: liveSessions(online),
      privateWindows,
      unavailable,
      historyCount: matches.length,
      history: (page ? matches.slice(0, page.limit) : matches).map((m) => ({
          session: m.session_id,
          workspace: basename(m.cwd),
          title: sanitizeSessionTitle(m.custom_title || m.title).slice(0, 160),
          updated: m.updated_at,
        })),
    }
  }
  async function catalog(page: CatalogPage) {
    let failed = false
    const { rows: history, truncated } = await listPage(page.query ? 0 : page.limit).catch(() => { failed = true; return { rows: [], truncated: false } })
    const text = page.query ? await searchTexts().catch(() => new Map<string, string>()) : undefined
    const { occupied, online, privateWindows, unavailable } = await bus.inventory()
    const visible = unavailable ? [] : history
    const catalog = phoneCatalog(visible, online, page, occupied, text)
    return { ...catalog, more: catalog.more || (truncated && !page.query), privateWindows, unavailable, failed }
  }
  // Folders this profile has worked in, by opaque id. The phone picks an id; only
  // the computer maps it back to a path, so a phone can never name an arbitrary directory.
  async function folders() {
    const [history, inventory] = await Promise.all([listHistory(0), bus.inventory()])
    const known = new Map<string, { id: string; name: string; path: string; sessions: number; open: number }>()
    const add = (path: string, saved: boolean) => {
      const id = profileKey(path), row = known.get(id) ?? { id, name: basename(path) || '/', path: shortenSessionCwd(path), sessions: 0, open: 0 }
      if (saved) row.sessions++; else row.open++
      known.set(id, row)
    }
    add(cwd, false)
    for (const m of history) add(m.cwd, true)
    const paths = new Map([cwd, ...history.map(m => m.cwd)].map(path => [profileKey(path), path]))
    return { list: [...known.values()].sort((a, b) => b.open - a.open || b.sessions - a.sessions || a.name.localeCompare(b.name)), paths, inventory }
  }
  // Deleting is the same operation as `d` in the TUI picker. A session open in
  // any window of this profile, shared or not, stays: that TUI would keep writing it.
  // The one exception is an idle window this gateway's tmux group launched for a
  // phone: nobody sees it on the computer, so it closes first and the delete proceeds.
  async function remove(session: string) {
    let inventory = await bus.inventory()
    if (inventory.unavailable) throw new RemoteConflict('A terminal on the computer is not responding. Try again shortly.')
    if (inventory.occupied.has(session)) {
      const owners = inventory.online.filter(t => t.session === session)
      const tmux = Bun.which('tmux'), target = (t: { terminal: string }) => '=chat-' + t.terminal
      const parked = !!tmux && owners.length > 0 && owners.every(t => t.phoneCreated && t.phase === 'idle'
        && tmuxIn(tmux, 'has-session', '-t', target(t)).exitCode === 0)
      // A hidden (unshared) window holds the session without a badge row, so it has no owner here and stays.
      if (!parked) throw new RemoteConflict('This session is open in a terminal window. Close it there first.')
      for (const t of owners) tmuxIn(tmux!, 'kill-session', '-t', target(t))
      for (const end = Date.now() + 4000; Date.now() < end; await Bun.sleep(100)) {
        inventory = await bus.inventory()
        if (!inventory.occupied.has(session)) break
      }
      if (inventory.occupied.has(session)) throw new RemoteConflict('That window is still closing. Try again shortly.')
    }
    const deleted = await source.deleteSession(session)
    listing = undefined; texts = undefined
    return deleted
  }
  // Idempotent tmux name + deterministic terminal id, including across gateways.
  // Only launch the local binary with server-selected cwd/argv, never a phone command.
  async function open(requestId: string, session: string | null, stillAuthorized: () => boolean, folder?: string) {
    if (!validTerminal(requestId)) throw new RemoteConflict('Invalid session request.')
    let startIn = cwd
    if (folder !== undefined) {
      if (session) throw new RemoteConflict('A saved session keeps its own folder.')
      const path = (await folders()).paths.get(folder)
      if (!path) throw new RemoteConflict('Choose a folder from the list.')
      startIn = path
    }
    // Fast path even for a stale History click. Do not read the history store
    // before attaching. Recheck occupancy after disk I/O before launching.
    const owner = async () => {
      const inventory = await bus.inventory()
      const live = session && liveSessions(inventory.online).find(t => t.session === session)
      if (!live && session && (inventory.occupied.has(session) || inventory.unavailable))
        throw new RemoteConflict('Cannot resume while another terminal has this session or is unavailable. If it is open on the computer, run /remote in that window.')
      return { live, online: inventory.online }
    }
    if (session) {
      const first = await owner()
      if (first.live) return first.live.terminal
    }
    const saved = session ? (await listHistory()).find(m => m.session_id === session) : undefined
    const { live: existing, online } = await owner()
    if (existing) return existing.terminal
    if (session !== null && !saved) throw new RemoteConflict('Session no longer exists in this profile.')
    const tmux = Bun.which('tmux')
    if (!tmux) throw new RemoteConflict('Install tmux on the computer to open an independent TUI.')
    const digest = createHash('sha256')
      .update(JSON.stringify([group, session || requestId, ...(folder ? [folder] : [])]))
      .digest('hex')
      .slice(0, 32)
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(
      16,
      20
    )}-${digest.slice(20)}`
    // The same saved session can be left via a local /new. Do not reattach a
    // deterministic terminal to a different session on a stale history click.
    const old = online.find((t) => t.terminal === id)
    if (old && (!session || old.session === session)) return id
    if (old) throw new RemoteConflict('That window changed sessions. Pick it again from Sessions.')
    if (!stillAuthorized()) throw new RemoteConflict('Pairing changed.')
    const binary = /^(bun|bun-debug)$/.test(basename(process.execPath))
      ? [process.execPath, Bun.main]
      : [process.execPath]
    const args = [...binary, ...(envFile ? ['--env-file', envFile] : []), ...(session ? ['--resume', session] : [])]
    const tm = (...args: string[]) => tmuxIn(tmux, ...args)
    const target = 'chat-' + id
    const exists = () => tm('has-session', '-t', '=' + target).exitCode === 0
    if (!exists()) {
      if (tm('list-sessions', '-F', '#{session_name}').stdout.toString().split('\n').filter(Boolean).length >= 16)
        throw new RemoteConflict('16 phone terminals are already open. Close an unused terminal on the computer.')
      const launch = tm(
        'new-session',
        '-d',
        '-s',
        target,
        '-c',
        saved?.cwd || startIn,
        '--',
        '/usr/bin/env',
        'EVOT_PHONE_TERMINAL=' + id,
        'EVOT_PHONE_SCOPE=' + scope,
        ...args
      )
      if (launch.exitCode !== 0 && !exists())
        throw new RemoteConflict('Could not start a TUI. Check tmux and the saved working directory on the computer.')
    }
    const end = Date.now() + 9000
    while (Date.now() < end && stillAuthorized()) {
      try {
        const r = await bus.request(id, '/badge')
        if (r.ok) {
          const b = (await r.json()) as { session: string; phase?: string }
          if (!b.phase || (session && b.session !== session)) throw new Error('not ready')
          return id
        }
      } catch {
        /* Startup, before the TUI has bound its private socket. */
      }
      await Bun.sleep(100)
    }
    throw new RemoteConflict('The window is still starting or failed. Check Sessions before retrying.')
  }
  return { bus, list, catalog, open, remove, folders: async () => (await folders()).list }
}
export type PhoneWorkspace = ReturnType<typeof phoneWorkspace>
