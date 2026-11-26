import { commandInventory, resolveCommand } from '../../../commands/index.js'
import { currentSessionShareMode, type SessionShareMode } from '../../../commands/share.js'
import { commandSpellings, type SlashHint } from '../../../features/composer/slash-completion.js'
import { promptInput } from '../../../commands/skill/invocation.js'
import type { SkillEntry } from '../../../commands/skill/scan.js'
import { RemoteConflict, type RemoteCommand } from '../../../features/remote/protocol.js'
import { remoteLocalCommand } from '../../../features/remote/local-commands.js'
import { isSessionIdPrefix, normalizeResumeQuery } from '../../../session/resume-query.js'

const shortcuts = new Map<string, RemoteCommand['shortcut']>([
  ['/resume', 'sessions'], ['/new', 'new'], ['/model', 'model'], ['/help', 'help'],
])
const catalogs = new WeakMap<readonly SkillEntry[], RemoteCommand[]>()
const hintCatalogs = new WeakMap<readonly SkillEntry[], SlashHint[]>()

/** Whitelist display fields; never serialize a skill directory or a handler's state. */
export function phoneCommandHints(skills: readonly SkillEntry[]): SlashHint[] {
  const cached = hintCatalogs.get(skills)
  if (cached) return cached
  const hints = commandInventory(skills).map(({ name, aliases, description, arguments: args, handler, minPrefixLength, hidden, hintWhenForked }) =>
    ({ name, aliases, description, arguments: args, handler, minPrefixLength, hidden, hintWhenForked }))
  hintCatalogs.set(skills, hints)
  return hints
}

/** Keep the original runnable catalog shape for older phones. */
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

type PhoneSubmission = { kind: 'prompt'; text: string } | { kind: 'share'; mode: SessionShareMode | 'usage' } | { kind: 'version' }
export const PHONE_SHARE_USAGE = 'Usage on Remote: /share team | private | off | public (current session only)'

/** Re-resolve each submission on the host. The browser's catalog is a hint, not authority. */
export function phoneSubmission(text: string, skills: readonly SkillEntry[], steer: boolean, photos: boolean): PhoneSubmission {
  const prompt = promptInput(text, skills)
  if (prompt !== null) return { kind:'prompt', text:prompt }
  const cmd = resolveCommand(text, skills)
  if (cmd.kind === 'ambiguous') throw new RemoteConflict(`Ambiguous command: ${cmd.candidates.join(', ')}`)
  if (cmd.kind === 'unknown') throw new RemoteConflict('Unknown command in this window. Type / to see available commands.')
  if (cmd.kind === 'resolved') {
    const kind = remoteLocalCommand(cmd.name)
    if (kind) {
      if (steer) throw new RemoteConflict(`Wait for the current run to finish before ${kind === 'share' ? 'sharing' : 'running /version'}.`)
      if (photos) throw new RemoteConflict(`${cmd.name} takes text only. Remove the photos.`)
      if (kind === 'version') {
        if (cmd.args) throw new RemoteConflict('Usage: /version')
        return { kind }
      }
      const args = cmd.args.toLowerCase()
      if (!args || args === 'list') return { kind, mode: 'usage' }
      const mode = currentSessionShareMode(args)
      if (mode) return { kind, mode }
      throw new RemoteConflict(PHONE_SHARE_USAGE)
    }
  }
  if (cmd.kind === 'resolved' && cmd.name === '/resume') {
    const query = normalizeResumeQuery(cmd.args)
    if (!query || query === '--all' || isSessionIdPrefix(query)) throw new RemoteConflict('Choose this session from the Sessions list.')
    if (steer) throw new RemoteConflict('Wait for the current run to finish before searching sessions.')
    if (photos) throw new RemoteConflict('Session search takes text only. Remove the photos.')
    return { kind:'prompt', text:`/sessions ${cmd.args}` }
  }
  throw new RemoteConflict(`Run ${cmd.name} in the TUI. This command is not available on Remote.`)
}
