import type { PrivacyEvent, PrivacySettings, PrivacyStatus } from '../native/index.js'
import { privacyOriginsRow } from '../privacy/notice.js'

export interface PrivacyPort {
  status: (days: number) => Promise<PrivacyStatus>
  save: (settings: PrivacySettings) => Promise<PrivacySettings>
}

// Three verbs. `off` is explicit and whole: it stops masking model
// requests for this machine until `/privacy on`; there is no per-kind off.
export const USAGE = [
  '  /privacy                  what was masked or blocked',
  '  /privacy term WORD        always mask WORD: a name, a codename, a host',
  '  /privacy term rm WORD     stop masking it',
  '  /privacy off              stop masking model requests (uploads stay scrubbed)',
  '  /privacy on               mask again',
].join('\n')

const DEFAULT_DAYS = 30

type Edit = { settings: PrivacySettings; message: string } | string

/** `WORD` adds, `rm WORD` removes. */
function editList(list: string[], rest: string[], noun: string): { list: string[]; message: string } | string {
  const remove = rest[0] === 'rm'
  const value = (remove ? rest.slice(1) : rest).join(' ').trim()
  if (!value) return USAGE
  const same = (item: string) => item.toLowerCase() === value.toLowerCase()
  if (!remove) {
    if (list.some(same)) return `  that ${noun} is already listed`
    return { list: [...list, value], message: `${noun} added: ${value}` }
  }
  if (!list.some(same)) return `  no such ${noun}`
  return { list: list.filter((item) => !same(item)), message: `${noun} removed: ${value}` }
}

/** Terms and the master switch; nothing else is editable from here. */
export function editSettings(settings: PrivacySettings, sub: string, rest: string[]): Edit {
  if ((sub === 'on' || sub === 'off') && rest.length === 0) {
    const enabled = sub === 'on'
    if (settings.enabled === enabled) return `  privacy is already ${sub}`
    return { settings: { ...settings, enabled }, message: enabled ? 'model requests masked again' : 'model requests no longer masked; /privacy on to resume' }
  }
  if (sub === 'term') {
    const edited = editList(settings.terms, rest, 'term')
    if (typeof edited === 'string') return edited
    return { settings: { ...settings, terms: edited.list }, message: edited.message }
  }
  return USAGE
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** `2026-10-27` in local time, the way the records stamp theirs. */
function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One line: what is on. */
export function renderSettings(settings: PrivacySettings): string {
  const parts = [settings.enabled ? 'model requests masked' : 'model requests NOT masked (/privacy on)']
  if (settings.terms.length > 0) parts.push(`${plural(settings.terms.length, 'term')} of yours`)
  parts.push('uploads scrubbed')
  return `  ${parts.join(' · ')}`
}

/** `11:57` today, `10-27 11:57` before; from an RFC 3339 local time. */
function when(time: string, today: string): string {
  const clock = time.slice(11, 16)
  return time.slice(0, 10) === today ? clock : `${time.slice(5, 10)} ${clock}`
}

const GOING: Record<string, string> = { llm: 'model request', share: 'share', sync: 'sync', task: 'task', task_report: 'task report', delivery: 'chat reply' }

/** Where the request was going. */
const actor = (event: PrivacyEvent) => GOING[event.target] ?? event.target

/** The screen: one line of numbers, what just happened, what is on. */
export function renderStatus({ settings, summary }: PrivacyStatus, today = localToday()): string {
  const lines = [`  Privacy ${settings.enabled ? 'on' : 'off'} · last ${plural(summary.days, 'day')}`, '']
  if (summary.requests === 0) {
    lines.push('  Nothing sensitive was found. Model requests are masked and uploads scrubbed.')
  } else {
    const counts = [`${plural(summary.requests - summary.blocked, 'request')} masked`]
    if (summary.blocked > 0) counts.push(`${plural(summary.blocked, 'call')} blocked`)
    lines.push(`  ${counts.join(' · ')}`)
  }
  const recent = summary.recent.slice(0, 5)
  if (recent.length > 0) {
    lines.push('')
    const stamps = recent.map((event) => when(event.time, today))
    const stamp = Math.max(...stamps.map((s) => s.length))
    const width = Math.max(...recent.map((event) => actor(event).length))
    recent.forEach((event, i) => {
      const to = event.model ? ` → ${event.model}` : ''
      lines.push(`  ${stamps[i]!.padEnd(stamp)}  ${actor(event).padEnd(width)}  ${event.blocked ? '✗ ' : ''}${event.reason}${to}`)
      // Where the values sat, when the record knows (one line, folded).
      const origins = privacyOriginsRow(event)
      if (origins) lines.push(`  ${' '.repeat(stamp)}  ${' '.repeat(width)}  ${origins}`)
    })
  }
  lines.push('', renderSettings(settings), settings.enabled ? '  /privacy term WORD · /privacy off' : '  /privacy on')
  return lines.join('\n')
}

/** Route one `/privacy` invocation. Returns the text to commit. */
export async function runPrivacyCommand(port: PrivacyPort, args: string): Promise<string> {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (!sub || /^\d+$/.test(sub)) {
    const days = sub ? Math.max(1, Number(sub)) : DEFAULT_DAYS
    return renderStatus(await port.status(days))
  }
  const status = await port.status(1)
  const edit = editSettings(status.settings, sub, rest)
  if (typeof edit === 'string') return edit
  const saved = await port.save(edit.settings)
  return `  ${edit.message}\n${renderSettings(saved)}`
}
