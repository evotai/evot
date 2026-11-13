/**
 * Slash commands for the REPL.
 */

import type { SkillEntry } from './skill/scan.js'
import { isValidSkillName } from './skill/scan.js'

export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  handler: 'builtin'
  /** Minimum typed prefix length, including `/`, before prefix matching applies. */
  minPrefixLength?: number
  /**
   * Runnable while a response is streaming: reads local state only, touching
   * neither the run nor the session. Arguments are refused separately.
   */
  runSafe?: boolean
  /**
   * Only advertise in the bare `/` hint while the session has a fork parent.
   * The command stays runnable and prefix-completable at all times; this
   * keeps the one-line hint to things that can do something right now.
   */
  hintWhenForked?: boolean
}

export const COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show help information', usage: '/help [command]', handler: 'builtin', runSafe: true },
  { name: '/resume', aliases: ['/sessions'], description: 'Resume a session (task runs in /task)', usage: '/resume [id | <what you worked on, with an optional time range> | --all]', handler: 'builtin' },
  { name: '/new', description: 'Start a new session', handler: 'builtin' },
  { name: '/fork', description: 'Fork this session into a new one that inherits its context', usage: '/fork [title]', handler: 'builtin' },
  { name: '/back', description: 'Return to the session this one was forked from', usage: '/back [levels]', handler: 'builtin', hintWhenForked: true },
  { name: '/model', description: 'Show or change model', usage: '/model [name]', handler: 'builtin' },
  { name: '/task', description: 'Manage scheduled tasks, or import a shared one', usage: '/task [prompt | share-link]', handler: 'builtin' },
  { name: '/compute', description: 'Manage ssh machines evot can use, and what each is for', usage: '/compute [request | cancel]', handler: 'builtin', minPrefixLength: 6 },
  { name: '/loop', description: 'Keep the current work moving, or repeat a prompt, on an interval or self-paced until done', usage: '/loop [interval] [prompt] | stop | status', handler: 'builtin' },
  { name: '/share', description: 'List shared sessions; public/team/private shares this session; a share URL imports it', usage: '/share [public | team | private | off] [session-id | url]', handler: 'builtin' },
  { name: '/login', description: 'Log in to evot cloud', handler: 'builtin' },
  { name: '/logout', description: 'Log out of evot cloud', handler: 'builtin' },
]

/** Hidden commands — recognised but not shown in the bare `/` ghost hint */
export const HIDDEN_COMMANDS: SlashCommand[] = [
  { name: '/restart', description: 'Restart evot in place', handler: 'builtin', minPrefixLength: 5 },
  { name: '/update', description: 'Update evot to latest version', handler: 'builtin' },
  { name: '/version', description: 'Show current version', handler: 'builtin', runSafe: true },
  { name: '/exit', aliases: ['/quit', '/q'], description: 'Exit the REPL', handler: 'builtin' },
  { name: '/done', description: 'Exit log mode', handler: 'builtin' },
  { name: '/harden', description: 'Stress-test the previous plan or current changes', usage: '/harden [plan | changes | arch | subject]', handler: 'builtin' },
  { name: '/skill', description: 'Manage skills', usage: '/skill [list | install [name | source] | update [name] | remove <name>]', handler: 'builtin' },
  { name: '/clip', description: 'Clip last reply to the memory vault; all = distill session; copy = clipboard', usage: '/clip [all | copy]', handler: 'builtin' },
  { name: '/compact', description: 'Compact session context', usage: '/compact [instructions]', handler: 'builtin' },
  { name: '/clear', description: 'Clear session context', handler: 'builtin' },
  { name: '/privacy', description: 'Privacy: what was masked; add your own words to mask, or turn masking off/on', usage: '/privacy [days | term [rm] WORD | off | on]', handler: 'builtin', minPrefixLength: 4 },
  { name: '/env', description: 'Manage variables', usage: '/env [list | get KEY [--reveal] | set K=V | del K | load FILE]', handler: 'builtin' },
  { name: '/log', description: 'Show or analyze session logs; shot exports markdown', usage: '/log [shot | query]', handler: 'builtin' },
  { name: '/_dump', description: 'Dump system prompt + tools + skills as JSON', usage: '/_dump [path]', handler: 'builtin' },
  { name: '/_mem', description: 'Show process memory use and retained UI state', handler: 'builtin', runSafe: true },
]

/** All commands (visible + hidden) for resolution */
export const ALL_COMMANDS: SlashCommand[] = [...COMMANDS, ...HIDDEN_COMMANDS]

export type SkillCommand = Omit<SlashCommand, 'handler'> & { handler: 'skill'; dir: string }
export type CommandDefinition = SlashCommand | SkillCommand

/** Installed skills as commands. Builtin spellings are reserved, including
 * aliases; installing a skill never shadows them. */
export function skillCommands(skills: readonly SkillEntry[] = []): SkillCommand[] {
  const reserved = new Set(ALL_COMMANDS.flatMap(command => [command.name, ...command.aliases ?? []]))
  return skills.filter(skill => isValidSkillName(skill.name) && !reserved.has(`/${skill.name.toLowerCase()}`)).map(skill => ({
    name: `/${skill.name}`, description: `Use the ${skill.name} skill`, handler: 'skill' as const, dir: skill.dir,
  }))
}

/** Builtins followed by installed skills, for listing and descriptions. */
export function commandInventory(skills: readonly SkillEntry[] = []): CommandDefinition[] {
  return [...ALL_COMMANDS, ...skillCommands(skills)]
}

export interface CommandSpelling { label: string; command: CommandDefinition }

/** Every typeable spelling paired with its command; aliases are first class. */
export function commandSpellings(commands: readonly CommandDefinition[]): CommandSpelling[] {
  return commands.flatMap(command => [command.name, ...command.aliases ?? []].map(label => ({ label, command })))
}

function spellingsWithPrefix(commands: readonly CommandDefinition[], prefix: string): CommandSpelling[] {
  // Low-frequency commands may require a longer explicit prefix so they do
  // not steal common prefixes from high-frequency commands.
  return commandSpellings(commands).filter(({ label, command }) =>
    prefix.length >= (command.minPrefixLength ?? 1) && label.toLowerCase().startsWith(prefix))
}

/**
 * The one matching rule shared by resolution, completion and hints: builtins
 * own their spellings and prefixes, and skills are consulted only when no
 * builtin matches. Installing a skill therefore never changes what a builtin
 * prefix such as `/m` means, and builtin-only callers may omit `skills`.
 */
export function matchCommandPrefix(prefix: string, skills: readonly SkillEntry[] = []): CommandSpelling[] {
  const builtin = spellingsWithPrefix(ALL_COMMANDS, prefix)
  return builtin.length > 0 || skills.length === 0 ? builtin : spellingsWithPrefix(skillCommands(skills), prefix)
}

export type ResolvedCommand =
  | { kind: 'resolved'; name: string; args: string }
  | { kind: 'skill'; name: string; args: string; dir: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown' }

export function buildHardenPrompt(args: string): string {
  const subject = args.trim()
  if (!subject || subject === 'plan') {
    return [
      'harden the plan, strategy, or conclusion from the immediately preceding conversation context.',
      'If local git changes exist, inspect them only as supporting context and combine any relevant findings with the hardening pass; do not default to hardening the diff as the primary subject.',
    ].join(' ')
  }
  if (subject === 'changes') {
    return 'harden current git changes'
  }
  if (subject === 'arch') {
    return [
      'harden the architecture of the current git changes or the immediately preceding plan.',
      'Evaluate: simplicity, decoupling, clarity of responsibility, and cohesion.',
      'In the final output, include an annotated file tree showing the proposed directory structure with short comments explaining each module\'s role.',
    ].join(' ')
  }
  return `harden this strategy: ${subject}`
}

/**
 * Resolve a slash command input to a known command.
 * Supports prefix matching (e.g. "/h" → "/help"), under `matchCommandPrefix`.
 */
export function resolveCommand(input: string, skills: readonly SkillEntry[] = []): ResolvedCommand {
  const parts = input.trim().split(/\s+/)
  const cmd = parts[0]!.toLowerCase()
  const args = parts.slice(1).join(' ')
  const matches = matchCommandPrefix(cmd, skills)
  // An exact spelling wins over longer names that merely start with it.
  const exact = matches.find(match => match.label.toLowerCase() === cmd)
  const commands = exact ? [exact.command] : [...new Set(matches.map(match => match.command))]
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
