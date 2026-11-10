/**
 * `/fork` and `/back [levels | root]`: moving along a session's fork ancestry.
 *
 * Forks form a tree; the only path the UI reasons about is the chain from the
 * root to the current session. `/back` and `/back root` are `--resume` shortcuts
 * along that chain, so they carry no state of their own. Notices are screen
 * output only and never enter the model's context.
 */

import type { SessionMeta } from '../../../native/contracts/results.js'
import type { OutputLine } from '../../../render/output.js'
import { sessionLabel } from '../../viewmodel/fork-trail.js'

export { FORK_GLYPH } from '../../viewmodel/fork-trail.js'
import { FORK_GLYPH } from '../../viewmodel/fork-trail.js'
export const BACK_GLYPH = '↩'

const shortId = (id: string) => id.slice(0, 8)
const named = (meta: SessionMeta) => `${sessionLabel(meta)}  (${shortId(meta.session_id)})`

export type BackTarget =
  | { kind: 'root' }
  | { kind: 'invalid'; levels: string }
  | { kind: 'move'; target: SessionMeta; skipped: SessionMeta[] }

/**
 * Where `/back [levels]` lands. `lineage` is root → current. `levels` may be
 * a positive count or `'root'`; anything else is refused rather than guessed.
 */
export function resolveBackTarget(lineage: readonly SessionMeta[], levels: string): BackTarget {
  const depth = lineage.length - 1
  if (depth <= 0) return { kind: 'root' }
  const raw = levels.trim()
  let steps: number
  if (raw === '' ) steps = 1
  else if (raw === 'root') steps = depth
  else if (/^\d+$/.test(raw) && Number(raw) > 0) steps = Math.min(Number(raw), depth)
  else return { kind: 'invalid', levels: raw }
  const index = depth - steps
  const target = lineage[index]
  if (!target) return { kind: 'root' }
  return { kind: 'move', target, skipped: lineage.slice(index + 1, depth) }
}

/** Lines shown after `/fork` lands in the new session. */
export function forkNotice(fork: SessionMeta, parent: SessionMeta, dim: (text: string) => string, accent: (text: string) => string): OutputLine[] {
  return [
    { id: 'sys-fork', kind: 'system', text: `  ${accent(FORK_GLYPH)} Forked → ${named(fork)}` },
    { id: 'sys-fork-from', kind: 'system', text: dim(`    from     ${named(parent)}`) },
    { id: 'sys-fork-back', kind: 'system', text: dim(`    back     /back  ·  evot --resume ${parent.session_id}`) },
  ]
}

/** Lines shown after `/back` lands in an ancestor. */
export function backNotice(
  left: SessionMeta,
  target: SessionMeta,
  skipped: readonly SessionMeta[],
  dim: (text: string) => string,
  accent: (text: string) => string,
): OutputLine[] {
  const lines: OutputLine[] = [
    { id: 'sys-back', kind: 'system', text: `  ${accent(BACK_GLYPH)} Back from ${named(left)}` },
  ]
  for (const meta of skipped) {
    lines.push({ id: `sys-back-skip-${meta.session_id}`, kind: 'system', text: dim(`    skipped  ${named(meta)}  ·  evot --resume ${meta.session_id}`) })
  }
  lines.push({ id: 'sys-back-return', kind: 'system', text: dim(`    return   evot --resume ${left.session_id}`) })
  lines.push({ id: 'sys-back-now', kind: 'system', text: dim(`    now      ${named(target)}`) })
  return lines
}

/** Extra exit hint lines for a session inside a fork chain. */
export function exitLineageHint(lineage: readonly SessionMeta[]): string[] {
  if (lineage.length <= 1) return []
  const parent = lineage[lineage.length - 2]
  const root = lineage[0]
  if (!parent || !root) return []
  const lines = [`Parent: evot --resume ${parent.session_id}  ${sessionLabel(parent)}`]
  if (root.session_id !== parent.session_id) lines.push(`Root:   evot --resume ${root.session_id}  ${sessionLabel(root)}`)
  return lines
}
