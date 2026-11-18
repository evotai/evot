/** Privacy stops, read back out of error text. The wording is owned by
 * `src/app/src/privacy/notice.rs` and pinned by tests on both sides; this
 * module is the only place that parses it. No TUI or native runtime dependency. */

import type { PrivacyOrigin, PrivacyRuleCount } from '../native/contracts/privacy.js'

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
  rules?: PrivacyRuleCount[]
  origins?: PrivacyOrigin[]
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
  const parts = origins.slice(0, SHOWN).map(origin => `${originLocation(origin, origin.lines)}${one ? '' : ` ×${origin.n}`}`)
  if (origins.length > SHOWN) parts.push(`+${origins.length - SHOWN} more`)
  return `in: ${parts.join(' · ')}`
}

function originLocation(origin: PrivacyOrigin, lines: number[] = []): string {
  const label = origin.label ? ` ${JSON.stringify(origin.label)}` : ''
  const location = lines.length ? ` (${lines.length === 1 ? 'line' : 'lines'} ${lines.join(', ')})` : ''
  return `${origin.at}${label}${location}`
}

const RULE_DESCRIPTION: ReadonlyMap<string, string> = new Map([
  ['contexts.url-password', 'Password embedded in a URL or connection string'],
  ['contexts.password-assignment', 'Password in a variable, config entry, or command flag'],
  ['contexts.password-field', 'Password in a password field'],
  ['contexts.curl-user', 'Password supplied to curl via -u or --user'],
  ['contexts.cjk-password', 'Password written inline next to a password label'],
  ['contexts.credential-assignment', 'Credential in a key, token, or secret assignment'],
  ['contexts.credential-field', 'Credential in a key, token, or secret field'],
  ['contexts.authorization', 'Credential in an Authorization header'],
  ['formats.private-key', 'Private key block'],
  ['secrets.ssh-private-key', 'SSH private key block'],
  ['formats.openai-compatible-key', 'OpenAI-style API key'],
  ['formats.github-classic', 'GitHub personal access token'],
  ['formats.github-fine-grained', 'GitHub fine-grained personal access token'],
  ['formats.gitlab-token', 'GitLab access token'],
  ['formats.npm-token', 'npm access token'],
  ['formats.vendor-key', 'Vendor API key'],
  ['formats.aws-access-key', 'AWS access key ID'],
  ['formats.jwt', 'JSON Web Token (JWT)'],
  ['formats.slack-token', 'Slack token'],
  ['formats.tencent-access-key', 'Tencent Cloud access key'],
  ['formats.volcengine-access-key', 'Volcengine access key'],
  ['formats.aliyun-access-key', 'Alibaba Cloud access key'],
  ['formats.qianfan-key', 'Qianfan API key'],
  ['formats.lark-token', 'Lark access token'],
  ['formats.robot-webhook', 'Chat bot webhook URL'],
  ['term', 'A term you configured Privacy to protect'],
  ['known', 'A previously recognized protected value'],
])

// Examples describe the shape of a match; they never come from input text.
const RULE_EXAMPLE: ReadonlyMap<string, string> = new Map([
  ['contexts.url-password', 'user:****@host'],
  ['contexts.password-assignment', 'DB_PASSWORD=****'],
  ['contexts.password-field', '"password": "****"'],
  ['contexts.curl-user', 'curl -u user:****'],
  ['contexts.cjk-password', '密码：****'],
  ['contexts.credential-assignment', 'API_KEY=****'],
  ['contexts.credential-field', '"api_key": "****"'],
  ['contexts.authorization', 'Authorization: Bearer ****'],
])

/** Plain-language clues for the whole request, not excerpts or exact field names. */
export function privacyEvidenceRows(detail: PrivacyDetail): string[] {
  const rules = detail.rules ?? []
  const rows = rules.slice(0, SHOWN).map(({ rule, values }) => {
    const description = RULE_DESCRIPTION.get(rule) ?? `Rule: ${rule}`
    const example = RULE_EXAMPLE.get(rule)
    return `${values} ${values === 1 ? 'value' : 'values'} · ${description}${example ? ` (e.g. ${example})` : ''}`
  })
  if (rules.length > SHOWN) rows.push(`+${rules.length - SHOWN} more rules matched`)
  return rows
}

/** Only lines associated with the specific rule and finding that stopped the request. */
export function privacyBlockedRows(detail: PrivacyDetail | undefined): string[] {
  const blocked = (detail?.origins ?? []).flatMap(origin => (origin.blocks ?? []).map(finding => ({ origin, finding })))
  blocked.sort((a, b) => b.finding.n - a.finding.n)
  const rows = blocked.slice(0, SHOWN).map(({ origin, finding }) => {
    const description = RULE_DESCRIPTION.get(finding.rule) ?? `${finding.kind} (rule: ${finding.rule})`
    return `${description}${finding.n > 1 ? ` ×${finding.n}` : ''} — ${originLocation(origin, finding.lines)}`
  })
  if (blocked.length > SHOWN) rows.push(`+${blocked.length - SHOWN} more source groups`)
  return rows
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
    const rows: PrivacyCardRow[] = [{ tone: 'status', text: `✗ · nothing was sent · ${contains}` }]
    const blocked = privacyBlockedRows(detail)
    for (const cause of blocked) rows.push({ tone: 'error', text: cause })
    if (blocked.length === 0) {
      // Older records do not tie individual rules to locations. Don't imply that
      // a line matched a blocking rule when it may have been only masked.
      const descriptions = [...new Set((detail?.rules ?? []).map(({ rule }) => RULE_DESCRIPTION.get(rule)).filter(Boolean))]
      if (descriptions.length) rows.push({ tone: 'error', text: descriptions.join(' · ') })
      const origins = privacyOriginsRow(detail)
      if (origins) rows.push({ tone: 'hint', text: `Request findings (not all blocked) ${origins}` })
      const rules = privacyRulesRow(detail)
      if (rules) rows.push({ tone: 'hint', text: rules })
    }
    rows.push(
      { tone: 'hint', text: 'Remove the value from its source before retrying.' },
      { tone: 'hint', text: 'In chat history? Start a new session with /new. · /privacy for the record' },
    )
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
        { tone: 'error', text: 'A task runs later from the copy on the server, so its instruction may hold no secret.' },
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
