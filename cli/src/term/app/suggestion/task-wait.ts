import type { SuggestionTrigger } from '../composer-guidance.js'

/** The slice of `PromptSuggestion` a state trigger drives. */
export interface SuggestionTarget {
  start(trigger: SuggestionTrigger): boolean
  cancelAutomatic(trigger?: SuggestionTrigger): void
}

/**
 * Turns a polled "blocked on task_output" fact into suggestion edges.
 *
 * One automatic attempt per wait: polls keep retrying only while the composer
 * is ineligible (draft, overlay), and elapsed-time metadata can never cause a
 * resample. Leaving the wait withdraws only the wait's own automatic work.
 */
export class TaskWaitSuggestion {
  private waiting = false
  private handled = false

  constructor(private readonly target: SuggestionTarget) {}

  sync(waiting: boolean): void {
    if (!waiting) {
      if (this.waiting) this.target.cancelAutomatic('task_waiting')
      this.waiting = false
      this.handled = false
      return
    }
    this.waiting = true
    if (!this.handled) this.handled = this.target.start('task_waiting')
  }
}
