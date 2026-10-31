/** Privacy stops, read back out of error text. The wording is owned by
 * `src/app/src/privacy/notice.rs` and pinned by tests on both sides; this
 * module is the only place that parses it. No TUI or native dependency. */

export type PrivacyTarget = 'request' | 'share' | 'sync' | 'task' | 'task report' | 'delivery'

export type PrivacyStop =
  | { kind: 'blocked'; target: PrivacyTarget; kinds: string[] }
  | { kind: 'unavailable'; reason: string }

const BLOCKED = /privacy blocked this (request|share|sync|task report|task|delivery): it contains ([A-Z0-9_]+(?:, [A-Z0-9_]+)*)\. Nothing was sent/
const UNAVAILABLE = /privacy masking is unavailable, so nothing was sent: (.+?)\. Fix the settings or rule packs with \/privacy/s

export function parsePrivacyStop(text: string | null | undefined): PrivacyStop | null {
  if (!text || !text.includes('privacy')) return null
  const blocked = text.match(BLOCKED)
  if (blocked) return { kind: 'blocked', target: blocked[1] as PrivacyTarget, kinds: blocked[2]!.split(', ') }
  const unavailable = text.match(UNAVAILABLE)
  if (unavailable) return { kind: 'unavailable', reason: unavailable[1]!.trim() }
  return null
}

/** One row of the card: `error` rows are the cause, `hint` rows what to do. */
export interface PrivacyCardRow { tone: 'status' | 'error' | 'hint'; text: string }

export interface PrivacyCard { title: string; rows: PrivacyCardRow[] }

/** What a record knows about one request beyond its kinds: the model it was
 * for, where the values sat, which rules found them. All optional: records
 * from older builds, and uploads, have none of it. */
export interface PrivacyDetail {
  provider?: string | null
  model?: string | null
  /** `KIND ×n` clauses, most first, as `reason` already words them. */
  reason?: string
  rules?: { rule: string; values: number }[]
  origins?: { at: string; label?: string | null; n: number }[]
}

const SHOWN = 3

/** `→ claude-opus-5.5 · evot-pro-anthropic`, or nothing. */
export function privacyDestination(detail: PrivacyDetail | undefined): string {
  if (!detail?.model && !detail?.provider) return ''
  const parts = [detail.model, detail.provider].filter((part): part is string => Boolean(part))
  return ` → ${parts.join(' · ')}`
}

/** `in: Bash result "ssh db0 'cat …'" ×224 · user ×9 · +2 more`. */
export function privacyOriginsRow(detail: PrivacyDetail | undefined): string | null {
  const origins = detail?.origins ?? []
  if (origins.length === 0) return null
  const one = origins.length === 1
  const parts = origins.slice(0, SHOWN).map(origin => {
    const label = origin.label ? ` ${JSON.stringify(origin.label)}` : ''
    return `${origin.at}${label}${one ? '' : ` ×${origin.n}`}`
  })
  if (origins.length > SHOWN) parts.push(`+${origins.length - SHOWN} more`)
  return `in: ${parts.join(' · ')}`
}

/** `by rule: secrets.ssh-private-key · core.file-assignment 87 · known 9`. */
export function privacyRulesRow(detail: PrivacyDetail | undefined): string | null {
  const rules = detail?.rules ?? []
  if (rules.length === 0) return null
  const one = rules.length === 1
  const parts = rules.slice(0, SHOWN).map(rule => (one || rule.values === 1 ? rule.rule : `${rule.rule} ${rule.values}`))
  if (rules.length > SHOWN) parts.push(`+${rules.length - SHOWN} more`)
  return `by rule: ${parts.join(' · ')}`
}

/** What the card says: what was stopped, why, and the command that undoes it. */
export function privacyCard(stop: PrivacyStop, detail?: PrivacyDetail): PrivacyCard {
  if (stop.kind === 'unavailable') {
    return {
      title: 'unavailable',
      rows: [
        { tone: 'status', text: '✗ · nothing was sent' },
        { tone: 'error', text: stop.reason },
        { tone: 'hint', text: 'Repair ~/.evotai/privacy/settings.json or rules/*.json, then retry /privacy. /privacy off only disables request masking after configuration loads; uploads stay protected.' },
      ],
    }
  }
  const kinds = stop.kinds.join(', ')
  const them = stop.kinds.length === 1 ? 'it' : 'them'
  if (stop.target === 'request') {
    // `contains PRIVATE_KEY ×1`: the record's clause when there is one, else
    // the kinds the error named.
    const contains = detail?.reason && detail.reason.startsWith('contains') ? detail.reason : `contains ${stop.kinds.join(' · ')}`
    const rows: PrivacyCardRow[] = [{ tone: 'status', text: `✗ · ${contains} · nothing was sent` }]
    const origins = privacyOriginsRow(detail)
    if (origins) rows.push({ tone: 'error', text: origins })
    const rules = privacyRulesRow(detail)
    if (rules) rows.push({ tone: 'error', text: rules })
    rows.push({ tone: 'hint', text: `Still in this session's history, so the next request stops here too · /privacy shows the record · /new starts clean` })
    return { title: `blocked request${privacyDestination(detail)}`, rows }
  }
  const mask = stop.kinds.map(kind => `/privacy ${kind} mask`).join(' · ')
  if (stop.target === 'share') {
    return {
      title: 'blocked share',
      rows: [
        { tone: 'status', text: `✗ · nothing was uploaded · ${kinds}` },
        { tone: 'hint', text: `Uploads scrub masked kinds for good. Mask ${them} instead: ${mask}, then /share again` },
      ],
    }
  }
  if (stop.target === 'task') {
    return {
      title: 'blocked task',
      rows: [
        { tone: 'status', text: `✗ · the task was not saved · ${kinds}` },
        { tone: 'error', text: 'A task runs later from the copy on the server, so its instruction may hold no secret or personal data.' },
        { tone: 'hint', text: 'Put secrets in the task\'s env file and name the variable in the instruction instead' },
      ],
    }
  }
  if (stop.target !== 'sync') {
    return {
      title: `blocked ${stop.target}`,
      rows: [
        { tone: 'status', text: `✗ · nothing was sent · ${kinds}` },
        { tone: 'hint', text: `Mask ${them} instead: ${mask}` },
      ],
    }
  }
  return {
    title: 'blocked sync',
    rows: [
      { tone: 'status', text: `✗ · not synced · the cloud copy stays as it was · ${kinds}` },
      { tone: 'hint', text: `Mask ${them} instead: ${mask} · sync tries again after the next run` },
    ],
  }
}
