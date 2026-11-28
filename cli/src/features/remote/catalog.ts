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
 * open in a window that is not sharing (older CLI, or /remote hide) is listed
 * from its own saved metadata as status only: it can be neither followed nor resumed.
 * Saved sessions without a completed turn are noise on a phone and stay hidden. */
export function phoneCatalog(visible: SessionMeta[], live: OnlineTerminal[], page: CatalogPage, occupied = new Set<string>(), text?: Map<string, string>) {
  const byId = new Map(visible.map(m => [m.session_id, m]))
  const online = live.map(w => {
    const meta = byId.get(w.session)
    return meta ? { ...w, title: sessionLineTitle(meta, w.title) } : w
  })
  // Match the session, not just its preferred follow target: a second window
  // can be running the same conversation while its idle sibling hosts Remote.
  const gateway = live.find(w => w.gateway === true)
  const matched = new Set<string>()
  function row(meta?: SessionMeta, window?: OnlineTerminal) {
    const savedAt = Date.parse(meta?.updated_at ?? '') || 0
    // Older idle windows timestamped transcript replay at startup. Prefer the saved
    // instant for those peers rather than bumping history on every restart.
    const liveAt = window?.hasConversation === undefined && window?.phase === 'idle' && savedAt ? 0 : window?.updatedAt || 0
    const updatedAt = Math.max(savedAt, liveAt)
    const unshared = !window && !!meta && occupied.has(meta.session_id)
    // A window the phone opened runs hidden in tmux. Idle, it is nothing the user can see
    // on the computer: list it as a saved session. Tapping it still follows that window.
    const hostsRemote = !!gateway && !!window && (gateway.terminal === window.terminal || (!!gateway.session && gateway.session === window.session))
    const parked = !hostsRemote && !!window?.phoneCreated && window.phase === 'idle'
    return { session: meta?.session_id ?? window?.session ?? '',
      title: window?.title || (meta ? sessionLineTitle(meta) : 'New conversation'),
      workspace: meta ? basename(meta.cwd) || '/' : window?.workspace,
      updatedAt, updated: updatedAt ? new Date(updatedAt).toISOString() : '',
      terminal: window?.terminal, phase: parked ? undefined : window?.phase, runState: window?.runState,
      ...(hostsRemote ? { gateway:true as const } : {}),
      completed: window?.completed, ...(window?.tmux && !parked ? { tmux: true } : {}),
      ...(unshared ? { unshared } : {}), ...(parked ? { parked } : {}) }
  }
  const listed = live.filter(w => {
    if (w === gateway) return true // The shared host is useful even before its first prompt.
    if ((byId.get(w.session)?.turns ?? 0) > 0) return true
    if (w.hasConversation !== undefined) return w.hasConversation
    // Legacy badges only have a display title. Exclude their known empty
    // placeholders, but retain the opening prompt before the first save.
    return !!w.title.trim() && w.title !== 'New conversation' && w.title !== `Session ${w.session.slice(-8)}`
  })
  const all = liveSessions(listed).map(w => {
    matched.add(w.session)
    const meta = byId.get(w.session)
    return row(meta, meta ? {...w, title:sessionLineTitle(meta, w.title)} : w)
  })
  for (const m of visible) if (!matched.has(m.session_id) && m.turns > 0) all.push(row(m))
  // Every word must appear somewhere in the title, id, project or transcript text.
  const words = page.query.split(/\s+/).filter(Boolean)
  const filtered = all.filter(r => !words.length || words.every(word =>
    [r.title, r.session, r.workspace, r.gateway ? 'remote gateway' : undefined, byId.get(r.session)?.title, text?.get(r.session)].some(value => value?.toLowerCase().includes(word))))
  filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.session.localeCompare(b.session) || (a.terminal ?? '').localeCompare(b.terminal ?? ''))
  return { rows: filtered.slice(0, page.limit), count: filtered.length, more: filtered.length > page.limit, online: [...online].sort(compareActivity) }
}
