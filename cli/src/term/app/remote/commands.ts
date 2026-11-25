import { commandInventory, commandSpellings, resolveCommand } from '../../../commands/index.js'
import { promptInput } from '../../../commands/skill/invocation.js'
import type { SkillEntry } from '../../../commands/skill/scan.js'
import { RemoteConflict, type RemoteCommand } from '../../../features/remote/protocol.js'
import { isSessionIdPrefix, normalizeResumeQuery } from '../../../session/resume-query.js'

const shortcuts = new Map<string, RemoteCommand['shortcut']>([
  ['/resume', 'sessions'], ['/new', 'new'], ['/model', 'model'], ['/help', 'help'],
])
const catalogs = new WeakMap<readonly SkillEntry[], RemoteCommand[]>()

/** Project the followed TUI's registry, not the gateway's. Never advertise a local overlay or admin action. */
export function phoneCommands(skills: readonly SkillEntry[]): RemoteCommand[] {
  const cached = catalogs.get(skills)
  if (cached) return cached
  const commands: RemoteCommand[] = []
  for (const { label: name, command } of commandSpellings(commandInventory(skills))) {
    const { description, usage } = command
    const shortcut = shortcuts.get(command.name)
    if (command.handler === 'builtin' && !shortcut) continue
    // A builtin may own a spelling even if a skill registered that exact prefix.
    // Only project spellings the user can actually run, including their TUI shorthand.
    let prefix: string | undefined
    for (let n = name.length; n >= 2; n--) {
      const typed = name.slice(0, n).toLowerCase(), resolved = resolveCommand(typed, skills)
      if ((resolved.kind !== 'resolved' && resolved.kind !== 'skill') || resolved.name !== command.name) break
      prefix = typed
    }
    if (prefix) commands.push({ name, description, usage, prefix, shortcut,
      arguments: command.handler === 'skill' ? command.arguments : undefined })
  }
  catalogs.set(skills, commands)
  return commands
}

/** Re-resolve each submission on the host. The browser's catalog is a hint, not authority. */
export function phonePrompt(text: string, skills: readonly SkillEntry[], steer: boolean, photos: boolean): string {
  const prompt = promptInput(text, skills)
  if (prompt !== null) return prompt
  const cmd = resolveCommand(text, skills)
  if (cmd.kind === 'ambiguous') throw new RemoteConflict(`Ambiguous command: ${cmd.candidates.join(', ')}`)
  if (cmd.kind === 'unknown') throw new RemoteConflict('Unknown command in this window. Type / to see available commands.')
  if (cmd.kind === 'resolved' && cmd.name === '/resume') {
    const query = normalizeResumeQuery(cmd.args)
    if (!query || query === '--all' || isSessionIdPrefix(query)) throw new RemoteConflict('Choose this session from the Sessions list.')
    if (steer) throw new RemoteConflict('Wait for the current run to finish before searching sessions.')
    if (photos) throw new RemoteConflict('Session search takes text only. Remove the photos.')
    return `/sessions ${cmd.args}`
  }
  throw new RemoteConflict(`Run ${cmd.name} in the TUI. Type / for commands available here.`)
}
