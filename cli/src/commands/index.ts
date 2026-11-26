/**
 * Slash commands for the REPL.
 */

import type { SkillEntry } from './skill/scan.js'
import { isValidSkillName } from './skill/scan.js'
import { matchCatalogPrefix, resolveSpelling, type SlashHint } from '../features/composer/slash-completion.js'

export interface SlashCommand extends SlashHint {
  usage?: string
  handler: 'builtin'
  /**
   * Runnable while a response is streaming: reads local state only, touching
   * neither the run nor the session. Arguments are refused separately.
   */
  runSafe?: boolean
}

export const REMOTE_USAGE = '/remote [on | off | devices | hide]'

const helpCommand: SlashCommand = { name: '/help', description: 'Show help information', usage: '/help [command]', handler: 'builtin', runSafe: true }

export const COMMANDS: SlashCommand[] = [
  helpCommand,
  { name: '/resume', aliases: ['/sessions'], description: 'Resume a session (task runs in /task)', usage: '/resume [id | <what you worked on, with an optional time range> | --all]', arguments: ['<id>', '<request>'], handler: 'builtin' },
  { name: '/remote', description: 'Turn on Remote for this profile and show its QR code', usage: REMOTE_USAGE, arguments: ['on', 'off', 'devices'], handler: 'builtin', minPrefixLength: 4 },
  { name: '/new', description: 'Start a new session', handler: 'builtin' },
  { name: '/fork', description: 'Fork this session into a new one that inherits its context', usage: '/fork [title]', arguments: ['<title>'], handler: 'builtin' },
  { name: '/back', description: 'Return to the session this one was forked from', usage: '/back [levels]', arguments: ['<levels>'], handler: 'builtin', hintWhenForked: true },
  { name: '/model', description: 'Show or change model', usage: '/model [name]', arguments: ['<name>'], handler: 'builtin' },
  { name: '/task', description: 'Manage scheduled tasks, or import a shared one', usage: '/task [prompt | share-link]', handler: 'builtin' },
  { name: '/compute', description: 'Manage ssh machines evot can use, and what each is for', usage: '/compute [request | cancel]', handler: 'builtin', minPrefixLength: 6 },
  { name: '/loop', description: 'Keep the current work moving, or repeat a prompt, on an interval or self-paced until done', usage: '/loop [interval] [prompt] | stop | status', handler: 'builtin' },
  { name: '/share', description: 'List shared sessions; public/team/private shares this session; a share URL imports it', usage: '/share [public | team | private | off | list] [session-id | url]', arguments: ['public', 'team', 'private', 'off', 'list'], handler: 'builtin' },
  { name: '/login', description: 'Log in to evot cloud', handler: 'builtin' },
  { name: '/logout', description: 'Log out of evot cloud', handler: 'builtin' },
]

/** Hidden commands — recognised but not shown in the bare `/` ghost hint */
export const HIDDEN_COMMANDS: SlashCommand[] = [
  { name: '/restart', description: 'Restart on the installed build after the current work; now interrupts', usage: '/restart [now | cancel]', arguments: ['now', 'cancel'], handler: 'builtin', minPrefixLength: 5 },
  { name: '/update', description: 'Update evot to latest version', handler: 'builtin' },
  { name: '/version', description: 'Show current version', handler: 'builtin', runSafe: true },
  { name: '/exit', aliases: ['/quit', '/q'], description: 'Exit the REPL', handler: 'builtin' },
  { name: '/done', description: 'Exit log mode', handler: 'builtin' },
  { name: '/skill', description: 'Manage skills', usage: '/skill [list | install [name | source] | update [name] | remove <name>]', arguments: ['install', 'list', 'update', 'remove'], handler: 'builtin' },
  { name: '/clip', description: 'Clip last reply to the memory vault; all = distill session; copy = clipboard', usage: '/clip [all | copy]', arguments: ['all', 'copy'], handler: 'builtin' },
  { name: '/compact', description: 'Compact session context', usage: '/compact [instructions]', handler: 'builtin' },
  { name: '/clear', description: 'Clear session context', handler: 'builtin' },
  { name: '/privacy', description: 'Privacy: what was masked; add your own words to mask, or turn masking off/on', usage: '/privacy [days | term [rm] WORD | off | on]', arguments: ['term', 'off', 'on', '<days>'], handler: 'builtin', minPrefixLength: 4 },
  { name: '/env', description: 'Manage variables', usage: '/env [list | get KEY [--reveal] | set K=V | del K | load FILE]', arguments: ['list', 'get', 'set', 'del', 'load'], handler: 'builtin' },
  { name: '/log', description: 'Show or analyze session logs; shot exports markdown', usage: '/log [shot | query]', arguments: ['shot', 'query'], handler: 'builtin' },
  { name: '/_mem', description: 'Show process memory use and retained UI state', handler: 'builtin', runSafe: true },
]

// Help argument names derive from the visible registry, just like the help panel.
helpCommand.arguments = COMMANDS.map(c => c.name.slice(1))

/** All commands (visible + hidden) for resolution */
export const ALL_COMMANDS: SlashCommand[] = [...COMMANDS, ...HIDDEN_COMMANDS.map(command => ({ ...command, hidden:true }))]

export type SkillCommand = Omit<SlashCommand, 'handler'> & { handler: 'skill'; dir: string }
export type CommandDefinition = SlashCommand | SkillCommand

/** Only explicitly registered skills become commands. Builtin spellings and
 * aliases remain reserved; command metadata never executes local handlers. */
export function skillCommands(skills: readonly SkillEntry[] = []): SkillCommand[] {
  const reserved = new Set(ALL_COMMANDS.flatMap(command => [command.name, ...command.aliases ?? []]))
  return skills.filter(skill => skill.command && isValidSkillName(skill.name) && !reserved.has(`/${skill.name.toLowerCase()}`)).map(skill => ({
    name: `/${skill.name}`, description: skill.command?.description ?? `Use the ${skill.name} skill`,
    usage: skill.command?.usage ?? `/${skill.name} [request]`, arguments: skill.command?.arguments,
    handler: 'skill' as const, dir: skill.dir,
  }))
}

/** Builtins followed by installed skills, for listing and descriptions. */
export function commandInventory(skills: readonly SkillEntry[] = []): CommandDefinition[] {
  return [...ALL_COMMANDS, ...skillCommands(skills)]
}

export function matchCommandPrefix(prefix: string, skills: readonly SkillEntry[] = []) {
  return matchCatalogPrefix(commandInventory(skills), prefix)
}

export type ResolvedCommand =
  | { kind: 'resolved'; name: string; args: string }
  | { kind: 'skill'; name: string; args: string; dir: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown' }

/**
 * Resolve a slash command input to a known command.
 * Supports prefix matching (e.g. "/h" → "/help"), under `matchCommandPrefix`.
 */
export function resolveCommand(input: string, skills: readonly SkillEntry[] = []): ResolvedCommand {
  const parts = input.trim().split(/\s+/)
  const cmd = parts[0]!.toLowerCase()
  const args = parts.slice(1).join(' ')
  const commands = resolveSpelling(matchCommandPrefix(cmd, skills), cmd)
  if (commands.length > 1) return { kind: 'ambiguous', candidates: commands.map(command => command.name) }
  const command = commands[0]
  if (!command) return { kind: 'unknown' }
  return command.handler === 'skill'
    ? { kind: 'skill', name: command.name, args, dir: command.dir }
    : { kind: 'resolved', name: command.name, args }
}

/** True for a bare `runSafe` command. Arguments change what a command does, so only the audited form passes. */
export function isRunSafeCommand(input: string): boolean {
  const resolved = resolveCommand(input)
  if (resolved.kind !== 'resolved' || resolved.args) return false
  return ALL_COMMANDS.some(c => c.name === resolved.name && c.runSafe === true)
}

/**
 * Returns true when text looks like a hand-typed slash command prefix:
 * `/` followed by zero or more ASCII letters. Case-insensitive so `/NEW`
 * typed with caps lock still resolves. Pasted paths like `/some/path.rs`
 * are rejected because their first segment carries `/` or `.`.
 */
export function isSlashPrefix(text: string): boolean {
  if (!text.startsWith('/')) return false
  const rest = text.slice(1)
  const cmdPart = rest.split(/\s/)[0] ?? ''
  // Preserve the published path boundary (e.g. `/v2` is prose/path), while
  // accepting hyphenated names. Installed skills resolve from the inventory.
  return /^[a-zA-Z_-]*$/.test(cmdPart)
}

/**
 * Check if input has a valid slash-command shape.
 * Unknown names still route through the command handler so they produce an
 * explicit error instead of being submitted to the model.
 */
export function isSlashCommand(input: string): boolean {
  const trimmed = input.trim()
  if (!isSlashPrefix(trimmed)) return false
  return trimmed.split(/\s+/)[0] !== '/'
}
