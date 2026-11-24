/**
 * Tab completion for the REPL input.
 * Supports slash commands and file paths.
 */

import { completePath, resolvePathTarget } from './path-completion.js'
import { COMMANDS, commandInventory, isSlashPrefix, matchCommandPrefix, resolveCommand, type CommandDefinition } from './index.js'
import type { SkillEntry } from './skill/scan.js'

export interface CompletionResult {
  /** The completed text to replace the current word */
  replacement: string
  /** All candidates (shown when multiple matches) */
  candidates: string[]
  /** Start index of the word being completed in the line */
  wordStart: number
  /** End of a path token being completed at a middle cursor position. */
  wordEnd?: number
}

/**
 * Compute tab completion for the current input line and cursor position.
 */
export function complete(line: string, cursorCol: number, skills: readonly SkillEntry[] = []): CompletionResult | null {
  const beforeCursor = line.slice(0, cursorCol)
  const commandText = beforeCursor.trimStart()
  // Command names and fixed subcommands win. An unmatched argument can
  // still be a path, including in `/loop inspect ../project/file`.
  const command = completeSlashCommand(commandText, skills)
  if (command) return { ...command, wordStart: command.wordStart + beforeCursor.length - commandText.length }
  const path = fileCompletionTarget(line, cursorCol, skills)
  return path ? completePath(path, cursorCol) : null
}

/** Pure routing check shared by local completion and AI input assistance.
 * A path remains a local target even when it currently has no filesystem
 * matches. Merely pressing Tab must not send a path draft to the model. */
export function fileCompletionTarget(line: string, cursorCol: number, skills: readonly SkillEntry[] = []): ReturnType<typeof resolvePathTarget> {
  const before = line.slice(0, cursorCol)
  const commandText = before.trimStart()
  if (!/\s/.test(commandText) && completeSlashCommand(commandText, skills)) return null
  return resolvePathTarget(line, cursorCol)
}

/** What the bare `/` hint may assume about the session it is typed into. */
export interface GhostHintContext {
  /** The session has a fork parent, so `/back` can actually go somewhere. */
  forked: boolean
}

const ROOT_SESSION: GhostHintContext = { forked: false }

/**
 * Compute inline ghost hint for the current input.
 * Returns gray text to show after the cursor (Rust REPL style).
 *
 * - Bare `/` → compact list of visible commands that apply right now
 * - `/he` → `lp — Show help` (single match: completion + description)
 * - `/skill ` → `[install  list  remove]` (sub-command hints)
 * - Registered skill names and empty arguments keep their command description
 */
export function getGhostHint(line: string, cursorCol: number, context: GhostHintContext = ROOT_SESSION, skills: readonly SkillEntry[] = []): string {
  const beforeCursor = line.slice(0, cursorCol)
  const afterCursor = line.slice(cursorCol)

  // Only show hints when cursor is at end of line
  if (afterCursor.trim().length > 0) return ''
  if (!isSlashPrefix(beforeCursor) && matchCommandPrefix(beforeCursor.split(/\s+/)[0]!.toLowerCase(), skills).length === 0) return ''

  const parts = beforeCursor.split(/\s+/)
  const cmd = parts[0]!.toLowerCase()

  // Sub-command hints (after space)
  if (parts.length >= 2) {
    const partial = parts.slice(1).join(' ').toLowerCase()
    return getSubCommandHint(cmd, partial, skills)
  }

  // Bare `/` → the visible commands that can act in this session
  if (cmd === '/') {
    const visible = [...COMMANDS, ...commandInventory(skills).filter(command => command.handler === 'skill')]
    const names = visible.filter(c => !c.hintWhenForked || context.forked).map(c => c.name.slice(1))
    return `  [${names.join('  ')}]`
  }

  const matches = matchCommandPrefix(cmd, skills)

  if (matches.length === 0) return ''

  // Single match — keep skill descriptions alongside their argument hints.
  if (matches.length === 1) {
    const m = matches[0]!
    return m.label.slice(cmd.length) + commandHint(m.command)
  }

  // Multiple matches — show common suffix + candidate names
  const common = commonPrefix(matches.map(m => m.label))
  const suffix = common.slice(cmd.length)
  const names = matches.map(m => m.label).join('  ')
  return suffix ? `${suffix}  [${names}]` : `  [${names}]`
}

function subCommandEntries(command: CommandDefinition): readonly string[] {
  return command.handler === 'skill' ? command.arguments ?? [] : SUB_COMMANDS[command.name] ?? []
}

function commandHint(command: CommandDefinition): string {
  const entries = subCommandEntries(command)
  const argumentsHint = entries.length > 0 ? `  [${entries.join('  ')}]` : ''
  return command.handler === 'skill' || !argumentsHint
    ? `${argumentsHint}  ${command.description}` : argumentsHint
}

function registeredCommand(cmd: string, skills: readonly SkillEntry[]): CommandDefinition | undefined {
  const resolved = resolveCommand(cmd, skills)
  if (resolved.kind !== 'resolved' && resolved.kind !== 'skill') return undefined
  return commandInventory(skills).find(command => command.name === resolved.name)
}

function registeredArguments(cmd: string, skills: readonly SkillEntry[]): readonly string[] {
  const command = registeredCommand(cmd, skills)
  return command ? subCommandEntries(command) : []
}

function getSubCommandHint(cmd: string, partial: string, skills: readonly SkillEntry[]): string {
  const command = registeredCommand(cmd, skills)
  if (!command) return ''
  if (!partial && command.handler === 'skill') return commandHint(command)
  const subcmds = subCommandEntries(command)
  if (subcmds.length === 0) return ''

  if (!partial) {
    return `  [${subcmds.join('  ')}]`
  }

  const matches = subcmds.filter(s => s.toLowerCase().startsWith(partial.toLowerCase()))
  if (matches.length === 0) return ''
  if (matches.length === 1) {
    return matches[0]!.slice(partial.length)
  }
  const common = commonPrefix(matches)
  const suffix = common.slice(partial.length)
  return suffix ? `${suffix}  [${matches.join('  ')}]` : `  [${matches.join('  ')}]`
}

const SUB_COMMANDS: Record<string, string[]> = {
  '/remote': ['devices', 'revoke', 'approve', 'deny', 'off', 'shutdown'],
  '/clip': ['all', 'copy'],
  '/share': ['public', 'team', 'private', 'off'],
  '/help': COMMANDS.map(c => c.name.slice(1)),
  '/skill': ['install', 'list', 'update', 'remove'],
  '/env': ['list', 'get', 'set', 'del', 'load'],
  '/privacy': ['term', 'off', 'on', '<days>'],
  '/log': ['shot', 'query'],
  '/resume': ['<id>', '<request>'],
  '/sessions': ['<id>', '<request>'],
  '/fork': ['<title>'],
  '/back': ['<levels>'],
  '/model': ['<name>'],
}

// ---------------------------------------------------------------------------
// Slash command completion
// ---------------------------------------------------------------------------

/**
 * A sub-command entry that is a literal token, not a prompt.
 *
 * `SUB_COMMANDS` mixes both: `/privacy` offers real words (`off`, `on`)
 * alongside `<days>`, which describes what to type rather than something to
 * type. Completing a placeholder would insert the angle brackets verbatim.
 */
function isLiteralSubCommand(entry: string): boolean {
  return !entry.startsWith('<')
}

/**
 * Complete the sub-command under the cursor, e.g. `/skill inst` → `install`.
 *
 * Driven by the same argument registry `getSubCommandHint` reads, so the
 * ghost hint and Tab can never disagree: anything the hint advertises as a
 * literal completion is something Tab can actually apply.
 */
function completeSubCommand(cmd: string, partial: string, wordStart: number, skills: readonly SkillEntry[]): CompletionResult | null {
  const subcmds = registeredArguments(cmd, skills).filter(isLiteralSubCommand)
  if (subcmds.length === 0) return null

  const matches = subcmds.filter(sub => sub.toLowerCase().startsWith(partial.toLowerCase()))
  if (matches.length === 0) return null
  if (matches.length === 1) {
    return { replacement: matches[0]! + ' ', candidates: matches, wordStart }
  }

  // Multiple matches: advance to the common prefix only. With nothing typed yet
  // the prefix is usually empty, so there is nothing to apply — report no
  // completion rather than an empty replacement that would still consume Tab.
  const common = commonPrefix(matches)
  if (common.length <= partial.length) return null
  return { replacement: common, candidates: matches, wordStart }
}

/** Pure registry completion, also used to route model-assisted arguments. */
export function completeSlashCommand(input: string, skills: readonly SkillEntry[] = []): CompletionResult | null {
  const parts = input.split(/\s+/)
  const cmd = parts[0]!.toLowerCase()

  // Past the command name, complete its sub-command instead. Only the first
  // argument: deeper words are free-form prompt text with nothing to match.
  if (parts.length === 2) {
    const partial = parts[1]!
    return completeSubCommand(cmd, partial, input.length - partial.length, skills)
  }
  if (parts.length > 2) return null

  const matches = matchCommandPrefix(cmd, skills).map(candidate => candidate.label)

  if (matches.length === 0) return null
  if (matches.length === 1) {
    return {
      replacement: matches[0]! + ' ',
      candidates: matches,
      wordStart: 0,
    }
  }

  // Multiple matches — complete common prefix
  const common = commonPrefix(matches)
  return {
    replacement: common,
    candidates: matches,
    wordStart: 0,
  }
}

// ---------------------------------------------------------------------------
// Shared prefix helper
// ---------------------------------------------------------------------------

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return ''
  let prefix = strings[0]!
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i]!
    let j = 0
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++
    prefix = prefix.slice(0, j)
  }
  return prefix
}
