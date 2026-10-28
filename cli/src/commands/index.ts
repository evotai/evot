/**
 * Slash commands for the REPL.
 */

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
  { name: '/loop', description: 'Keep the current work moving, or repeat a prompt, on an interval or self-paced until done', usage: '/loop [interval] [prompt] | stop | status', handler: 'builtin' },
  { name: '/share', description: 'List shared sessions; public/team/private shares this session; a share URL imports it', usage: '/share [public | team | private | off] [session-id | url]', handler: 'builtin' },
  { name: '/login', description: 'Log in to evot cloud', handler: 'builtin' },
  { name: '/logout', description: 'Log out of evot cloud', handler: 'builtin' },
]

/** Hidden commands — recognised but not shown in the bare `/` ghost hint */
export const HIDDEN_COMMANDS: SlashCommand[] = [
  // Planning mode is a toggle the model is steered into, not a destination the
  // user reaches for from the prompt; /help still documents it.
  { name: '/plan', description: 'Toggle planning mode', handler: 'builtin' },
  { name: '/restart', description: 'Restart evot in place', handler: 'builtin', minPrefixLength: 5 },
  { name: '/update', description: 'Update evot to latest version', handler: 'builtin' },
  { name: '/version', description: 'Show current version', handler: 'builtin', runSafe: true },
  { name: '/exit', aliases: ['/quit', '/q'], description: 'Exit the REPL', handler: 'builtin' },
  { name: '/done', description: 'Exit log/plan mode', handler: 'builtin' },
  { name: '/harden', description: 'Stress-test the previous plan or current changes', usage: '/harden [plan | changes | arch | subject]', handler: 'builtin' },
  { name: '/skill', description: 'Manage skills', usage: '/skill [list | install [name | source] | update [name] | remove <name>]', handler: 'builtin' },
  { name: '/clip', description: 'Clip last reply to the memory vault; all = distill session; copy = clipboard', usage: '/clip [all | copy]', handler: 'builtin' },
  { name: '/compact', description: 'Compact session context', usage: '/compact [instructions]', handler: 'builtin' },
  { name: '/clear', description: 'Clear session context', handler: 'builtin' },
  { name: '/privacy', description: 'Privacy: what was masked or blocked; add your own words to mask', usage: '/privacy [days | term [rm] WORD]', handler: 'builtin', minPrefixLength: 4 },
  { name: '/env', description: 'Manage variables', usage: '/env [list | get KEY [--reveal] | set K=V | del K | load FILE]', handler: 'builtin' },
  { name: '/log', description: 'Show or analyze session logs; shot exports markdown', usage: '/log [shot | query]', handler: 'builtin' },
  { name: '/_dump', description: 'Dump system prompt + tools + skills as JSON', usage: '/_dump [path]', handler: 'builtin' },
  { name: '/_mem', description: 'Show process memory use and retained UI state', handler: 'builtin', runSafe: true },
]

/** All commands (visible + hidden) for resolution */
export const ALL_COMMANDS: SlashCommand[] = [...COMMANDS, ...HIDDEN_COMMANDS]

export type ResolvedCommand =
  | { kind: 'resolved'; name: string; args: string }
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
 * Supports prefix matching (e.g. "/h" → "/help").
 */
export function resolveCommand(input: string): ResolvedCommand {
  const parts = input.trim().split(/\s+/)
  const cmd = parts[0]!.toLowerCase()
  const args = parts.slice(1).join(' ')

  // Exact match first (visible + hidden)
  for (const c of ALL_COMMANDS) {
    if (c.name === cmd) return { kind: 'resolved', name: c.name, args }
    if (c.aliases?.includes(cmd)) return { kind: 'resolved', name: c.name, args }
  }

  // Prefix match. Low-frequency commands may require a longer explicit prefix
  // so they do not steal common prefixes from high-frequency commands.
  const matches = ALL_COMMANDS.filter(
    (c) => cmd.length >= (c.minPrefixLength ?? 1)
      && (c.name.startsWith(cmd) || (c.aliases?.some((a) => a.startsWith(cmd)) ?? false))
  )

  if (matches.length === 1) {
    return { kind: 'resolved', name: matches[0]!.name, args }
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', candidates: matches.map((c) => c.name) }
  }

  return { kind: 'unknown' }
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
function isSlashPrefix(text: string): boolean {
  if (!text.startsWith('/')) return false
  const rest = text.slice(1)
  const cmdPart = rest.split(/\s/)[0] ?? ''
  // Allow letters plus `_` so hidden commands like `/_dump` work.
  return /^[a-zA-Z_]*$/.test(cmdPart)
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
