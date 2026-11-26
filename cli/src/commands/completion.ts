/** TUI completion: shared slash grammar plus machine-local path completion. */
import { slashCompletion } from '../features/composer/slash-completion.js'
import { completePath, resolvePathTarget } from './path-completion.js'
import { commandInventory } from './index.js'
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

/** A path remains a local target even when it has no filesystem matches.
 * Merely pressing Tab must not send a path draft to the model. */
export function fileCompletionTarget(line: string, cursorCol: number, skills: readonly SkillEntry[] = []): ReturnType<typeof resolvePathTarget> {
  const commandText = line.slice(0, cursorCol).trimStart()
  if (!/\s/.test(commandText) && completeSlashCommand(commandText, skills)) return null
  return resolvePathTarget(line, cursorCol)
}

export interface GhostHintContext {
  /** The session has a fork parent, so `/back` can actually go somewhere. */
  forked: boolean
}

export function getGhostHint(line: string, cursorCol: number, { forked }: GhostHintContext = { forked: false }, skills: readonly SkillEntry[] = []): string {
  if (!line.startsWith('/') || line.slice(cursorCol).trim()) return ''
  return slashCompletion(line.slice(0, cursorCol), commandInventory(skills), forked)?.hint ?? ''
}

/** Pure registry completion, also used to route model-assisted arguments. */
export function completeSlashCommand(input: string, skills: readonly SkillEntry[] = []): CompletionResult | null {
  if (!input.startsWith('/')) return null
  const completion = slashCompletion(input, commandInventory(skills))
  if (!completion || completion.replacement === null) return null
  return { replacement:completion.replacement, candidates:completion.tabCandidates, wordStart:completion.wordStart }
}
