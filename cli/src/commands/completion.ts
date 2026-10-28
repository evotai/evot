/**
 * Tab completion for the REPL input.
 * Supports slash commands and file paths.
 */

import { completePath, resolvePathTarget } from './path-completion.js'
import { ALL_COMMANDS, COMMANDS, type SlashCommand } from './index.js'

/**
 * Returns true when text looks like a hand-typed slash command prefix:
 * `/` followed by zero or more ASCII letters (any case, so `/NEW` with caps
 * lock still completes). Pasted paths like `/some/path.rs` are rejected.
 */
function isSlashPrefix(text: string): boolean {
  if (!text.startsWith('/')) return false
  const rest = text.slice(1)
  const cmdPart = rest.split(/\s/)[0] ?? ''
  return /^[a-zA-Z_]*$/.test(cmdPart)
}

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
export function complete(line: string, cursorCol: number): CompletionResult | null {
  const beforeCursor = line.slice(0, cursorCol)
  const commandText = beforeCursor.trimStart()
  // Command names and fixed subcommands win. An unmatched argument can
  // still be a path, including in `/loop inspect ../project/file`.
  if (isSlashPrefix(commandText)) {
    const command = completeSlashCommand(commandText)
    if (command) return { ...command, wordStart: command.wordStart + beforeCursor.length - commandText.length }
  }
  const path = fileCompletionTarget(line, cursorCol)
  return path ? completePath(path, cursorCol) : null
}

/** Pure routing check shared by local completion and AI input assistance.
 * A path remains a local target even when it currently has no filesystem
 * matches. Merely pressing Tab must not send a path draft to the model. */
export function fileCompletionTarget(line: string, cursorCol: number): ReturnType<typeof resolvePathTarget> {
  const before = line.slice(0, cursorCol)
  const commandText = before.trimStart()
  if (/^\/[a-zA-Z_]*$/.test(commandText) && completeSlashCommand(commandText)) return null
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
 */
export function getGhostHint(line: string, cursorCol: number, context: GhostHintContext = ROOT_SESSION): string {
  const beforeCursor = line.slice(0, cursorCol)
  const afterCursor = line.slice(cursorCol)

  // Only show hints when cursor is at end of line
  if (afterCursor.trim().length > 0) return ''
  if (!isSlashPrefix(beforeCursor)) return ''

  const parts = beforeCursor.split(/\s+/)
  const cmd = parts[0]!.toLowerCase()

  // Sub-command hints (after space)
  if (parts.length >= 2) {
    const partial = parts.slice(1).join(' ').toLowerCase()
    return getSubCommandHint(cmd, partial)
  }

  // Bare `/` → the visible commands that can act in this session
  if (cmd === '/') {
    const names = COMMANDS.filter(c => !c.hintWhenForked || context.forked).map(c => c.name.slice(1))
    return `  [${names.join('  ')}]`
  }

  const matches = commandCandidates().filter(candidate => prefixMatches(candidate, cmd))

  if (matches.length === 0) return ''

  // Single match — show completion suffix + sub-commands or description
  if (matches.length === 1) {
    const m = matches[0]!
    const suffix = m.label.slice(cmd.length)
    const subcmds = SUB_COMMANDS[m.command.name]
    if (subcmds && subcmds.length > 0 && (suffix === '' || m.label === cmd + suffix)) {
      return `${suffix}  [${subcmds.join('  ')}]`
    }
    return `${suffix}  ${m.command.description}`
  }

  // Multiple matches — show common suffix + candidate names
  const common = commonPrefix(matches.map(m => m.label))
  const suffix = common.slice(cmd.length)
  const names = matches.map(m => m.label).join('  ')
  return suffix ? `${suffix}  [${names}]` : `  [${names}]`
}

/**
 * Every typeable command spelling paired with its command. Aliases are first
 * class here: a user who types an alias gets the same hints as the canonical
 * name, and sub-command hints resolve through to the canonical entry.
 */
function commandCandidates(commands: SlashCommand[] = ALL_COMMANDS): { label: string; command: SlashCommand }[] {
  const candidates: { label: string; command: SlashCommand }[] = []
  for (const command of commands) {
    candidates.push({ label: command.name, command })
    for (const alias of command.aliases ?? []) candidates.push({ label: alias, command })
  }
  return candidates
}

function prefixMatches(candidate: { label: string; command: SlashCommand }, prefix: string): boolean {
  return prefix.length >= (candidate.command.minPrefixLength ?? 1)
    && candidate.label.startsWith(prefix)
}

function getSubCommandHint(cmd: string, partial: string): string {
  // Resolve through aliases so `/sessions <tab>` hints like `/resume`.
  const candidates = commandCandidates()
  const resolved = (candidates.find(c => c.label === cmd)
    ?? candidates.find(c => c.label.startsWith(cmd)))?.command
  if (!resolved) return ''

  const subcmds = SUB_COMMANDS[resolved.name] ?? []
  if (subcmds.length === 0) return ''

  if (!partial) {
    return `  [${subcmds.join('  ')}]`
  }

  const matches = subcmds.filter(s => s.startsWith(partial))
  if (matches.length === 0) return ''
  if (matches.length === 1) {
    return matches[0]!.slice(partial.length)
  }
  const common = commonPrefix(matches)
  const suffix = common.slice(partial.length)
  return suffix ? `${suffix}  [${matches.join('  ')}]` : `  [${matches.join('  ')}]`
}

const SUB_COMMANDS: Record<string, string[]> = {
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
  '/harden': ['plan', 'changes', 'arch', '<subject>'],
}

// ---------------------------------------------------------------------------
// Slash command completion
// ---------------------------------------------------------------------------

/**
 * A sub-command entry that is a literal token, not a prompt.
 *
 * `SUB_COMMANDS` mixes both: `/harden` offers real words (`plan`, `changes`)
 * alongside `<subject>`, which describes what to type rather than something to
 * type. Completing a placeholder would insert the angle brackets verbatim.
 */
function isLiteralSubCommand(entry: string): boolean {
  return !entry.startsWith('<')
}

/**
 * Complete the sub-command under the cursor, e.g. `/harden chan` → `changes`.
 *
 * Driven by the same `SUB_COMMANDS` table `getSubCommandHint` reads, so the
 * ghost hint and Tab can never disagree: anything the hint advertises as a
 * literal completion is something Tab can actually apply.
 */
function completeSubCommand(cmd: string, partial: string, wordStart: number): CompletionResult | null {
  const candidates = commandCandidates()
  const resolved = (candidates.find(c => c.label === cmd)
    ?? candidates.find(c => c.label.startsWith(cmd)))?.command
  if (!resolved) return null

  const subcmds = (SUB_COMMANDS[resolved.name] ?? []).filter(isLiteralSubCommand)
  if (subcmds.length === 0) return null

  const matches = subcmds.filter(sub => sub.startsWith(partial))
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
export function completeSlashCommand(input: string): CompletionResult | null {
  const parts = input.split(/\s+/)
  const cmd = parts[0]!.toLowerCase()

  // Past the command name, complete its sub-command instead. Only the first
  // argument: deeper words are free-form prompt text with nothing to match.
  if (parts.length === 2) {
    const partial = parts[1]!
    return completeSubCommand(cmd, partial, input.length - partial.length)
  }
  if (parts.length > 2) return null

  const matches = commandCandidates()
    .filter(candidate => prefixMatches(candidate, cmd))
    .map(candidate => candidate.label)

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
