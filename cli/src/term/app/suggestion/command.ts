import { ALL_COMMANDS } from '../../../commands/index.js'
import { completeSlashCommand } from '../../../commands/completion.js'
import type { SuggestionCommand } from './types.js'

/** Command names and literal subcommands use local completion. Once the
 * spelling is complete, registered argument help grounds model suggestions. */
export function suggestionCommand(text: string, cursor: number): SuggestionCommand | null {
  const match = /^(\s*)(\/[^\s]+)/u.exec(text)
  if (!match) return null
  const spelling = match[2]!
  const end = match[0].length
  if (cursor < end) return null
  const command = ALL_COMMANDS.find(command => command.name === spelling.toLowerCase()
    || command.aliases?.includes(spelling.toLowerCase()))
  if (!command?.usage) return null
  const indent = match[1]!.length
  const local = completeSlashCommand(text.slice(indent, cursor))
  if (local && local.wordStart + indent >= end && cursor === text.length) return null
  return { name: spelling, description: command.description, usage: command.usage }
}
