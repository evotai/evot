import { isRunSafeCommand, isSlashCommand } from '../../../commands/index.js'

export interface BusySubmission {
  displayText: string
  expandedText: string
  hasImages: boolean
  compacting: boolean
  editingQueue: boolean
  hasRun: boolean
}
export type BusySubmissionAction =
  | 'blocked_compaction_command'
  | 'queue_compaction'
  | 'edit_queue'
  | 'show_log'
  | 'run_readonly_command'
  | 'blocked_run_command'
  | 'steer'
  | 'none'

/** Decide before clearing the editor or invoking a native mutation. Commands
 * are never queued as model input; draft/history/image ownership stays in the host. */
export function busySubmissionAction(input: BusySubmission): BusySubmissionAction {
  const trimmed = input.expandedText.trim()
  const command = isSlashCommand(trimmed || input.displayText.trim())
  if (input.compacting) {
    if (command) return 'blocked_compaction_command'
    return trimmed || input.hasImages ? 'queue_compaction' : 'none'
  }
  if (input.editingQueue) return 'edit_queue'
  if (trimmed === '/log') return 'show_log'
  if (command && input.hasRun) {
    return isRunSafeCommand(trimmed) ? 'run_readonly_command' : 'blocked_run_command'
  }
  return (input.expandedText || input.hasImages) && input.hasRun ? 'steer' : 'none'
}
