import { resolveCommand } from '../../commands/index.js'
import type { RunInteractionState } from './run-interaction.js'
export type SuggestionTrigger = 'answer' | 'resume' | 'mode_changed' | 'loop_waiting'
export type ComposerMode = 'normal' | 'log'
export const MODE_HINTS = {
  normal: { hint: 'Enter a coding task or / for commands', shortHint: 'Enter a coding task' },
  log: { hint: 'Ask about these logs · /done to return', shortHint: 'Ask about logs · /done' },
} as const

export interface ComposerGuidance {
  mode: ComposerMode
  state: RunInteractionState['kind']
  placeholder: string
  shortPlaceholder: string
  /** Remains visible when model ghost text replaces the placeholder. */
  operationHint?: string
  allowSuggestion: boolean
  allowedCommands: string[]
}

/** Product guidance and automatic suggestions follow run state. Explicit Tab
 * assists composer input independently of task progress; menus/attachments
 * remain host-owned eligibility, not a second run state. */
export function resolveComposerGuidance(input: {
  interaction: RunInteractionState
  mode: ComposerMode
  queuedCount?: number
}): ComposerGuidance {
  const { interaction, mode } = input
  const state = interaction.kind
  const base = MODE_HINTS[mode]
  const guidance: ComposerGuidance = {
    mode, state, placeholder: base.hint, shortPlaceholder: base.shortHint,
    allowSuggestion: mode !== 'log' && ['idle', 'waiting-loop', 'waiting-background'].includes(state),
    allowedCommands: mode === 'normal' ? [] : ['/done'],
  }
  if (state === 'waiting-loop') {
    guidance.placeholder = 'Loop waiting · type to act now · /loop 15m to change pace · esc twice to stop'
    guidance.shortPlaceholder = 'Loop waiting · type · /loop 15m · esc twice'
    guidance.operationHint = 'esc twice to stop · type to act now · /loop 15m to change pace'
    guidance.allowedCommands.push('/loop 15m', '/loop stop')
  } else if (state === 'compacting') {
    guidance.placeholder = 'Compacting context · input queues for after compaction'
    guidance.shortPlaceholder = 'Compacting · input queues'
  } else if (state === 'local-operation') {
    guidance.placeholder = 'Local operation in progress · please wait'
    guidance.shortPlaceholder = 'Local operation · please wait'
  } else if (state === 'retrying') {
    guidance.placeholder = 'Waiting to retry · input queues for recovery · esc twice to stop'
    guidance.shortPlaceholder = 'Retrying · input queues · esc twice'
  } else if (state === 'active' || state === 'waiting-task') {
    guidance.placeholder = 'Guide the agent while it works'
    guidance.shortPlaceholder = 'Guide while it works'
  }
  const queued = input.queuedCount ?? 0
  if (queued > 0) {
    guidance.allowSuggestion = false
    if (state === 'compacting') {
      guidance.placeholder = `${queued} queued · will run after compaction`
      guidance.shortPlaceholder = `${queued} queued · after compaction`
    } else if (state === 'active' || state === 'waiting-task' || state === 'retrying') {
      guidance.placeholder = `${queued} ${queued === 1 ? 'message' : 'messages'} queued · Ctrl+G to manage`
      guidance.shortPlaceholder = `${queued} queued · Ctrl+G`
    }
  }
  return guidance
}

/** Only exact registered actions offered by this state may be suggested.
 * No free-form model-generated flags, arguments, paths or command chaining. */
export function allowedSuggestionCommand(text: string, commands: readonly string[]): boolean {
  return commands.includes(text) && resolveCommand(text).kind === 'resolved'
}
