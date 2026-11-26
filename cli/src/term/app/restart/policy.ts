import type { RestartWait } from '../../../features/restart/protocol.js'
import type { RunInteractionState } from '../run/run-interaction.js'

/** Facts the host reads at one moment; nothing here is a second copy of state. */
export interface RestartFacts {
  interaction: RunInteractionState['kind']
  /** An ask_user question or task model pick is waiting for the user. */
  question: boolean
  /** Background completions the engine will deliver in the next turn. */
  undeliveredResults: number
  /** A queued message is dispatching, being prepared, edited, or its ownership is unresolved. */
  queueBusy: boolean
  /** Log fork, overlay, login, local command or a starting gateway. */
  local: boolean
}

/**
 * A safe restart carries the conversation, the composer and queued messages
 * to the next image. It never interrupts work whose state lives only in this
 * process: a turn, a question, background tasks with undelivered results or a
 * parked loop. Queued messages do not block: the restart takes them along.
 */
export function restartWait(facts: RestartFacts): RestartWait | null {
  if (facts.question) return 'question'
  switch (facts.interaction) {
    case 'idle': break
    case 'waiting-loop': return 'loop'
    case 'waiting-background': return 'background'
    default: return 'turn'
  }
  if (facts.undeliveredResults > 0) return 'background'
  if (facts.queueBusy) return 'queue'
  if (facts.local) return 'local'
  return null
}
