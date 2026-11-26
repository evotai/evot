import { ALL_COMMANDS } from '../../../commands/index.js'
import { argumentCompletion as completeArguments, exactCommand, type CommandInventory } from '../../../features/composer/command-arguments.js'
import { parseLoopArgs } from '../../../features/loop/parser.js'

export type { CommandInventory }

type InventorySource = CommandInventory | (() => CommandInventory)
const inventoryValue = (source: InventorySource): CommandInventory => typeof source === 'function' ? source() : source

export function argumentCompletion(text: string, cursor: number, inventory: CommandInventory) {
  return completeArguments(text, cursor, inventory, ALL_COMMANDS)
}

/** Read-only validation. This never executes a command or searches the disk. */
export function validCommandInput(text: string, source: InventorySource): boolean {
  const target = exactCommand(text, ALL_COMMANDS)
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
  const target = exactCommand(text, ALL_COMMANDS)
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
