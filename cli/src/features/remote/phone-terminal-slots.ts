import type { OnlineTerminal } from './discovery.js'
import { RemoteConflict } from './protocol.js'

const LIMIT = 4
const full = () => new RemoteConflict(`${LIMIT} phone terminals are already open. Choose an open session or wait for one to become idle.`)

/** Serialize admission through launch (not through TUI startup). tmux is the source
 * of truth; an idle badge is only a candidate, never permission to kill a process. */
export function phoneTerminalSlots() {
  let tail = Promise.resolve()
  return {
    admit<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work)
      tail = result.then(() => {}, () => {})
      return result
    },
  }
}

export async function makePhoneTerminalRoom(online: OnlineTerminal[], sessions: () => Set<string>,
  park: (terminal: string) => Promise<boolean>, authorized: () => boolean) {
  let names = sessions()
  if (names.size < LIMIT) return
  const candidates = online.filter(t => t.phoneCreated && t.phase === 'idle' && !t.gateway)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
  for (const candidate of candidates) {
    if (!authorized()) throw new RemoteConflict('Pairing changed.')
    if (names.size < LIMIT) return
    const name = 'chat-' + candidate.terminal
    if (!names.has(name)) continue
    if (await park(candidate.terminal)) {
      // The owner accepted, but cleanup can take time. Never evict a second
      // window on an ambiguous exit or launch against a slot still occupied.
      const until = Date.now() + 2000
      while ((names = sessions()).has(name)) {
        if (Date.now() >= until) throw new RemoteConflict('An idle phone terminal is still closing. Try again shortly.')
        await Bun.sleep(50)
      }
    } else names = sessions()
  }
  if (sessions().size >= LIMIT) throw full()
}
