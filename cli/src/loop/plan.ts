/**
 * The loop's checklist: what "done" means for this task, as the agent wrote
 * it on the first pass and keeps updating. The host holds it so the card in
 * the transcript, the wakeup card and `/loop status` render one source of
 * truth instead of whatever prose the model repeated this tick.
 */

export const PLAN_STATES = ['todo', 'doing', 'done', 'blocked', 'deferred'] as const
export type PlanState = typeof PLAN_STATES[number]

export interface PlanItem {
  text: string
  state: PlanState
  /** Required for blocked and deferred: the one line the user reads. */
  note?: string
}

/** What the host hands the renderer after recording a plan. */
export interface PlanRecord {
  tick: number
  items: PlanItem[]
  /** Indices whose state differs from the previous plan (or all, when first). */
  changed: number[]
  /** First plan of this loop: show everything, nothing to fold yet. */
  first: boolean
}

export interface PlanCounts {
  done: number
  doing: number
  todo: number
  blocked: number
  deferred: number
  total: number
}

export function isPlanState(value: unknown): value is PlanState {
  return typeof value === 'string' && (PLAN_STATES as readonly string[]).includes(value)
}

/** Validate tool arguments into items, or explain what is wrong. */
export function parsePlanItems(raw: unknown): { items: PlanItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'items must be a non-empty array.' }
  const items: PlanItem[] = []
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) return { error: `items[${index}] must be an object.` }
    const record = entry as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) return { error: `items[${index}].text is required.` }
    if (!isPlanState(record.state)) return { error: `items[${index}].state must be one of ${PLAN_STATES.join(', ')}.` }
    const note = typeof record.note === 'string' ? record.note.trim() : ''
    if ((record.state === 'blocked' || record.state === 'deferred') && !note) {
      return { error: `items[${index}] is ${record.state}: note (one line the user reads) is required.` }
    }
    items.push(note ? { text, state: record.state, note } : { text, state: record.state })
  }
  return { items }
}

export function countPlan(items: readonly PlanItem[]): PlanCounts {
  const counts: PlanCounts = { done: 0, doing: 0, todo: 0, blocked: 0, deferred: 0, total: items.length }
  for (const item of items) counts[item.state] += 1
  return counts
}

/** `3/9 done · 1 doing · 4 todo · 1 deferred`: zero buckets are left out. */
export function formatPlanCounts(counts: PlanCounts): string {
  const parts = [`${counts.done}/${counts.total} done`]
  if (counts.doing) parts.push(`${counts.doing} doing`)
  if (counts.todo) parts.push(`${counts.todo} todo`)
  if (counts.blocked) parts.push(`${counts.blocked} blocked`)
  if (counts.deferred) parts.push(`${counts.deferred} deferred`)
  return parts.join(' · ')
}

/** Indices of `next` whose state is new. Items are matched by text, so a
 *  reworded item counts as changed and a reordered one does not. */
export function changedIndices(previous: readonly PlanItem[], next: readonly PlanItem[]): number[] {
  const before = new Map(previous.map(item => [item.text, item.state]))
  const changed: number[] = []
  for (const [index, item] of next.entries()) {
    if (before.get(item.text) !== item.state) changed.push(index)
  }
  return changed
}

const PROGRESS_PREFIX = 'Plan: '

/** `Plan: 4/9 done.` for a tool result; the wakeup card reads it back. */
export function planProgressSentence(items: readonly PlanItem[]): string | null {
  if (items.length === 0) return null
  const counts = countPlan(items)
  return `${PROGRESS_PREFIX}${counts.done}/${counts.total} done.`
}

/** `4/9` from a `schedule_wakeup` result, or null when no plan was recorded. */
export function planProgressFromResult(result: string): string | null {
  const start = result.indexOf(PROGRESS_PREFIX)
  if (start < 0) return null
  const match = /^(\d+\/\d+) done/.exec(result.slice(start + PROGRESS_PREFIX.length))
  return match?.[1] ?? null
}

export function parsePlanRecord(result: string): PlanRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const items = parsePlanItems(record.items)
  if ('error' in items) return null
  const changed = Array.isArray(record.changed) ? record.changed.filter((n): n is number => typeof n === 'number') : []
  return {
    tick: typeof record.tick === 'number' ? record.tick : 0,
    items: items.items,
    changed,
    first: record.first === true,
  }
}

const STATE_GLYPH: Record<PlanState, string> = {
  done: '✓',
  doing: '◐',
  todo: '○',
  blocked: '⊘',
  deferred: '–',
}

const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

export interface PlanRowOptions {
  /** Indices to flag as moved this tick. */
  changed?: readonly number[]
  /** Fold unchanged done items into one count row. */
  fold?: boolean
  /** Text appended to the fold row, e.g. `(ctrl+o)`. */
  foldHint?: string
}

/** One text row per item (plus an optional fold row), two-space indented so
 *  it sits under a card headline. Done and deferred rows are dimmed; blocked
 *  and deferred carry their note; moved items get a trailing marker. */
export function formatPlanRows(items: readonly PlanItem[], options: PlanRowOptions = {}): string[] {
  const changed = new Set(options.changed ?? [])
  const rows: string[] = []
  const folded = options.fold
    ? items.filter((item, index) => item.state === 'done' && !changed.has(index)).length
    : 0
  if (folded > 0) {
    const hint = options.foldHint ? ` ${options.foldHint}` : ''
    rows.push(`  ${DIM}${STATE_GLYPH.done} ${folded} done${hint}${RESET}`)
  }
  for (const [index, item] of items.entries()) {
    const moved = changed.has(index)
    if (folded > 0 && item.state === 'done' && !moved) continue
    const note = item.note && (item.state === 'blocked' || item.state === 'deferred') ? ` · ${item.state}: ${item.note}` : ''
    const marker = moved ? `  ${DIM}← this tick${RESET}` : ''
    const body = `${STATE_GLYPH[item.state]} ${item.text}${note}`
    const quiet = item.state === 'done' || item.state === 'deferred'
    rows.push(`  ${quiet ? `${DIM}${body}${RESET}` : body}${marker}`)
  }
  return rows
}
