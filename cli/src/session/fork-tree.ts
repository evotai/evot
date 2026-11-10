/**
 * Arrange a flat, newest-first session list as a fork tree drawn like
 * `git log --graph`:
 *
 *     01a0bc90  root
 *     ├─ 01a0bcd1  first fork
 *     │  └─ 01a0bcc8  fork of the fork
 *     └─ 01a0bc5e  second fork
 *
 * Children follow their parent depth-first; siblings keep the input order.
 * A session whose parent is absent from the list (deleted, or outside the
 * loaded window) is shown as a root, so the picker never hides a row just
 * because its ancestry is incomplete.
 */

export interface ForkTreeRow<T> {
  session: T
  /** 0 for roots, 1 for their children, and so on. */
  depth: number
  /** Graph edge to draw before the row: `├─ `, `│  └─ `, … Empty for roots. */
  edge: string
}

interface ForkNode {
  session_id: string
  parent_session_id?: string | null
}

const BRANCH = '├─ '
const LAST = '└─ '
const RAIL = '│  '
const GAP = '   '

export function orderAsForkTree<T extends ForkNode>(sessions: readonly T[]): ForkTreeRow<T>[] {
  const ids = new Set(sessions.map(session => session.session_id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const session of sessions) {
    const parent = session.parent_session_id
    if (parent && parent !== session.session_id && ids.has(parent)) {
      const siblings = children.get(parent)
      if (siblings) siblings.push(session)
      else children.set(parent, [session])
    } else {
      roots.push(session)
    }
  }

  const rows: ForkTreeRow<T>[] = []
  const visited = new Set<string>()
  // `rails` holds, per ancestor level, whether a later sibling still follows
  // (so a rail must continue past this row).
  const visit = (session: T, depth: number, rails: boolean[], last: boolean) => {
    if (visited.has(session.session_id)) return
    visited.add(session.session_id)
    const edge = depth === 0
      ? ''
      : rails.map(open => (open ? RAIL : GAP)).join('') + (last ? LAST : BRANCH)
    rows.push({ session, depth, edge })
    const kids = children.get(session.session_id) ?? []
    const nextRails = depth === 0 ? [] : [...rails, !last]
    kids.forEach((child, index) => visit(child, depth + 1, nextRails, index === kids.length - 1))
  }
  for (const root of roots) visit(root, 0, [], true)
  // Cycles among non-roots never reach a root; list them flat rather than drop them.
  for (const session of sessions) visit(session, 0, [], true)
  return rows
}
