import type { SlashHint } from './slash-completion.js'

export interface ArgumentCandidate { value: string; label: string; description?: string }
export interface CommandInventory {
  models: readonly ArgumentCandidate[]
  sessions: readonly ArgumentCandidate[]
}

// The completion menu is a quick lookup; the session picker searches the full catalog.
export const RECENT_SESSION_LIMIT = 100

export function exactCommand(text: string, catalog: readonly SlashHint[]): { name: string; end: number } | null {
  const match = /^\s*(\/\S+)/u.exec(text)
  if (!match) return null
  const token = match[1]!.toLowerCase()
  const command = catalog.find(item => item.name.toLowerCase() === token || item.aliases?.some(alias => alias.toLowerCase() === token))
  return command ? { name: command.name, end: match[0].length } : null
}

/** Finite entities come from live application data. Natural-language session
 * searches are not completion targets, and can still be submitted normally. */
export function argumentCompletion(text: string, cursor: number, inventory: CommandInventory, catalog: readonly SlashHint[]): {
  items: ArgumentCandidate[]; start: number; end: number; note?: string
} | null {
  const target = exactCommand(text, catalog)
  if (!target || cursor < target.end || !['/model', '/resume'].includes(target.name)) return null
  const after = text.slice(target.end, cursor)
  const query = after.trimStart()
  if (target.name === '/resume' && query && !/^[a-f\d-]+$/i.test(query)) return null
  const values = target.name === '/model' ? inventory.models : inventory.sessions.slice(0, RECENT_SESSION_LIMIT)
  const start = cursor - query.length
  let end = cursor
  while (end < text.length && !/\s/u.test(text[end]!)) end++
  const separator = after.length === 0 ? ' ' : ''
  const lower = query.toLowerCase()
  const items = values.filter(item => item.value.toLowerCase().startsWith(lower)
    || item.label.toLowerCase().includes(lower)).map(item => ({ ...item, value: separator + item.value }))
  return { items, start, end, note: items.length ? undefined : target.name === '/model' ? 'No matching configured model' : 'No matching recent session; Enter opens the session picker' }
}
