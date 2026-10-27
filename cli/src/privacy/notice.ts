/** Privacy stops, read back out of error text. The wording is owned by
 * `src/app/src/privacy/notice.rs` and pinned by tests on both sides; this
 * module is the only place that parses it. No TUI or native dependency. */

export type PrivacyTarget = 'request' | 'share' | 'sync' | 'task' | 'task report' | 'delivery'

/** A refused tool call: why in the user's terms, and each `/privacy ...`
 * command that would lift it (none when only a rewrite would). */
export type PrivacyStop =
  | { kind: 'blocked'; target: PrivacyTarget; kinds: string[] }
  | { kind: 'tool'; reason: string; why: string | null; commands: string[] }
  | { kind: 'unavailable'; reason: string }

const BLOCKED = /privacy blocked this (request|share|sync|task report|task|delivery): it contains ([A-Z0-9_]+(?:, [A-Z0-9_]+)*)\. Nothing was sent/
const TOOL = /privacy blocked this tool call: it (.+?)\. It did not run\.(.*)/s
const WHY = /^Why: (.+?)\.?$/m
/** `  /privacy untaint path — ...` or `  /privacy trust host — ...`, one per line. */
const COMMAND = /^\s*(\/privacy (?:untaint|trust) \S+)(?: — .*)?$/gm
const UNAVAILABLE = /privacy masking is unavailable, so nothing was sent: (.+?)\. Fix the settings or rule packs with \/privacy/s

export function parsePrivacyStop(text: string | null | undefined): PrivacyStop | null {
  if (!text || !text.includes('privacy')) return null
  const blocked = text.match(BLOCKED)
  if (blocked) return { kind: 'blocked', target: blocked[1] as PrivacyTarget, kinds: blocked[2]!.split(', ') }
  const tool = text.match(TOOL)
  if (tool) {
    const rest = tool[2] ?? ''
    const why = rest.match(WHY)
    const commands = [...rest.matchAll(COMMAND)].map(m => m[1]!)
    return { kind: 'tool', reason: tool[1]!, why: why ? why[1]! : null, commands }
  }
  const unavailable = text.match(UNAVAILABLE)
  if (unavailable) return { kind: 'unavailable', reason: unavailable[1]!.trim() }
  return null
}

/** One row of the card: `error` rows are the cause, `hint` rows what to do. */
export interface PrivacyCardRow { tone: 'status' | 'error' | 'hint'; text: string }

export interface PrivacyCard { title: string; rows: PrivacyCardRow[] }

/** What the card says: what was stopped, why, and the command that undoes it. */
export function privacyCard(stop: PrivacyStop): PrivacyCard {
  if (stop.kind === 'unavailable') {
    return {
      title: 'unavailable',
      rows: [
        { tone: 'status', text: '✗ · nothing was sent' },
        { tone: 'error', text: stop.reason },
        { tone: 'hint', text: 'Repair ~/.evotai/privacy/settings.json or rules/*.json, then retry /privacy. /privacy off only disables request masking after configuration loads; uploads and tool checks stay protected.' },
      ],
    }
  }
  if (stop.kind === 'tool') {
    const hidden = stop.reason.startsWith('runs decoded code')
    const rows: PrivacyCardRow[] = [{ tone: 'status', text: `✗ · did not run · it ${stop.reason}` }]
    if (stop.why) rows.push({ tone: 'error', text: stop.why })
    if (hidden) {
      rows.push({ tone: 'hint', text: 'Rewrite it as plain, readable code' })
    } else if (stop.commands.length > 0) {
      rows.push({ tone: 'hint', text: 'To let it through, run one of these (agreeing in chat does not):' })
      for (const command of stop.commands) {
        rows.push({
          tone: 'hint',
          text: command.startsWith('/privacy untaint')
            ? `  ${command}   — that file holds no real secret`
            : `  ${command}   — let tool calls send secrets to that host`,
        })
      }
    } else {
      rows.push({ tone: 'hint', text: 'Nothing here to trust or unmark; ask for the call to be rewritten without the secret' })
    }
    return { title: 'blocked tool call', rows }
  }
  const kinds = stop.kinds.join(', ')
  const mask = stop.kinds.map(kind => `/privacy ${kind} mask`).join(' · ')
  const them = stop.kinds.length === 1 ? 'it' : 'them'
  if (stop.target === 'request') {
    return {
      title: 'blocked request',
      rows: [
        { tone: 'status', text: `✗ · nothing was sent to the model · ${kinds}` },
        { tone: 'error', text: `Set to block, and still in this session's history: the next request stops here too.` },
        { tone: 'hint', text: `Mask ${them} instead: ${mask} · or go on without ${them}: /new` },
        { tone: 'hint', text: '/privacy shows what was blocked and when' },
      ],
    }
  }
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
