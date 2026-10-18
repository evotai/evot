import { ALL_COMMANDS } from '../../../commands/index.js'
import { parseLoopArgs } from '../../../loop/parser.js'
import type { CompletionCandidate } from '../../input/editor.js'

export interface CommandInventory {
  models: readonly CompletionCandidate[]
  sessions: readonly CompletionCandidate[]
}

type InventorySource = CommandInventory | (() => CommandInventory)
const inventoryValue = (source: InventorySource): CommandInventory => typeof source === 'function' ? source() : source

function command(text: string): { name: string; end: number } | null {
  const match = /^\s*(\/\S+)/u.exec(text)
  if (!match) return null
  const found = ALL_COMMANDS.find(item => item.name === match[1]!.toLowerCase() || item.aliases?.includes(match[1]!.toLowerCase()))
  return found ? { name: found.name, end: match[0].length } : null
}

/** Finite entities are selected from live application data, not invented by a
 * model. Natural-language /resume searches still use input assistance. */
export function argumentCompletion(text: string, cursor: number, inventory: CommandInventory): {
  items: CompletionCandidate[]; start: number; end: number; note?: string
} | null {
  const target = command(text)
  if (!target || cursor < target.end || !['/model', '/resume'].includes(target.name)) return null
  const after = text.slice(target.end, cursor)
  const query = after.trimStart()
  if (target.name === '/resume' && query.includes(' ')) return null
  if (target.name === '/resume' && query && !/^[a-f\d-]+$/i.test(query)) return null
  const values = target.name === '/model' ? inventory.models : inventory.sessions
  const leading = after.length - query.length
  const start = target.end + leading
  let end = cursor
  while (end < text.length && !/\s/u.test(text[end]!)) end++
  const separator = after.length === 0 ? ' ' : ''
  const items = values.filter(item => item.value.toLowerCase().startsWith(query.toLowerCase())
    || item.label.toLowerCase().includes(query.toLowerCase())).map(item => ({ ...item, value: separator + item.value }))
  return { items, start, end, note: items.length ? undefined : target.name === '/model' ? 'No matching configured model' : 'No matching recent session; Enter opens the session picker' }
}

/** Read-only validation. This never executes a command or searches the disk. */
export function validCommandInput(text: string, source: InventorySource): boolean {
  const target = command(text)
  if (!target) return true
  const args = text.slice(target.end).trim()
  if (target.name === '/loop') return parseLoopArgs(args).kind !== 'invalid'
  if (target.name === '/model') return inventoryValue(source).models.some(item => item.value === args)
  if (target.name === '/resume' && /^[a-f\d-]{8,}$/i.test(args)) return inventoryValue(source).sessions.filter(item => item.value.startsWith(args)).length === 1
  return true
}

/** Only normalize meanings the application can prove equivalent. Free-form
 * prose is left to the model; word-overlap heuristics can invert intent. */
export function commandIdentity(text: string, source: InventorySource): string | undefined {
  const target = command(text)
  if (!target) return undefined
  const args = text.slice(target.end).trim()
  if (target.name === '/loop') {
    const parsed = parseLoopArgs(args)
    if (parsed.kind === 'start') return JSON.stringify([target.name, parsed.mode, parsed.task.prompt])
    return JSON.stringify([target.name, parsed.kind])
  }
  if (target.name === '/model') return JSON.stringify([target.name, args])
  if (target.name === '/resume' && /^[a-f\d-]{8,}$/i.test(args)) {
    const matches = inventoryValue(source).sessions.filter(item => item.value.startsWith(args))
    if (matches.length === 1) return JSON.stringify([target.name, matches[0]?.value])
  }
  return undefined
}
