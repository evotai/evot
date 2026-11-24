import { basename } from 'node:path'
import type { SessionMeta } from '../../native/index.js'
import { sessionLineTitle } from '../../session/resume.js'
import type { OnlineTerminal } from './discovery.js'
import { compareActivity } from './session-order.js'

// A conversation has one preferred destination, even when two windows own it.
// The window view, unlike the session picker, must still show both windows.
export function liveSessions(terminals: OnlineTerminal[]) {
  const rank = { input: 0, working: 1, busy: 2, idle: 3 }
  const seen = new Set<string>()
  return [...terminals].sort((a, b) => rank[a.phase] - rank[b.phase]
    || Number(!!a.phoneCreated) - Number(!!b.phoneCreated) || a.terminal.localeCompare(b.terminal))
    .filter(row => {
      if (!row.session) return true
      if (seen.has(row.session)) return false
      seen.add(row.session)
      return true
    }).sort((a, b) => compareActivity(a, b) || a.terminal.localeCompare(b.terminal))
}

export interface CatalogPage { limit: number; query: string }

/** Rank the entire authorized profile before pagination. A live window is
 * followable even before its first session has been saved to disk. A session
 * open in a window that is not sharing (older CLI, or /remote off) is listed
 * from its own saved metadata as status only: it can be neither followed nor resumed.
 * Saved sessions without a completed turn are noise on a phone and stay hidden. */
export function phoneCatalog(visible: SessionMeta[], live: OnlineTerminal[], page: CatalogPage, occupied = new Set<string>(), text?: Map<string, string>) {
  const byId = new Map(visible.map(m => [m.session_id, m]))
  const online = live.map(w => {
    const meta = byId.get(w.session)
    return meta ? { ...w, title: sessionLineTitle(meta) } : w
  })
  const matched = new Set<string>()
  function row(meta?: SessionMeta, window?: OnlineTerminal) {
    const updatedAt = Math.max(Date.parse(meta?.updated_at ?? '') || 0, window?.updatedAt || 0)
    const unshared = !window && !!meta && occupied.has(meta.session_id)
    // A window the phone opened runs hidden in tmux. Idle, it is nothing the user can see
    // on the computer: list it as a saved session. Tapping it still follows that window.
    const parked = !!window?.phoneCreated && window.phase === 'idle'
    return { session: meta?.session_id ?? window?.session ?? '',
      title: meta ? sessionLineTitle(meta) : window?.title || 'New conversation',
      workspace: meta ? basename(meta.cwd) || '/' : window?.workspace,
      updatedAt, updated: updatedAt ? new Date(updatedAt).toISOString() : '',
      terminal: window?.terminal, phase: parked ? undefined : window?.phase, runState: window?.runState,
      ...(unshared ? { unshared } : {}), ...(parked ? { parked } : {}) }
  }
  const all = liveSessions(online).map(w => {
    matched.add(w.session)
    return row(byId.get(w.session), w)
  })
  for (const m of visible) if (!matched.has(m.session_id) && (m.turns > 0 || occupied.has(m.session_id))) all.push(row(m))
  // Every word must appear somewhere in the title, id, project or transcript text.
  const words = page.query.split(/\s+/).filter(Boolean)
  const filtered = all.filter(r => !words.length || words.every(word =>
    [r.title, r.session, r.workspace, byId.get(r.session)?.title, text?.get(r.session)].some(value => value?.toLowerCase().includes(word))))
  filtered.sort((a, b) => compareActivity(a, b) || a.session.localeCompare(b.session) || (a.terminal ?? '').localeCompare(b.terminal ?? ''))
  return { rows: filtered.slice(0, page.limit), count: filtered.length, more: filtered.length > page.limit, online: [...online].sort(compareActivity) }
}
