import chalk from 'chalk'
import { getTheme } from '../render/theme/index.js'
import { formatDuration } from './parser.js'

/** Under a minute to go the row turns yellow: the agent is about to wake. */
export const LOOP_WAKE_SOON_MS = 60_000

export interface LoopWaitLineInput {
  /** Milliseconds until the scheduled wakeup. */
  remainingMs: number
  /** A first Esc has armed the stop; the row asks for the confirming press. */
  stopPending?: boolean
  /** Sentence from `earlyWakeSentence`: a running shell ends the wait early. */
  earlyWake?: string | null
}

/**
 * The status row above the composer while a loop is parked between ticks.
 * It takes the slot the run spinner uses while busy, because it answers the
 * same question, "what is the agent doing right now": waiting, until when.
 * How to stop it lives in the composer placeholder. When a background shell
 * is running the row also says the wait can end early, because a bare
 * "wakes in 30m" reads as a hard wait and users stop the loop to avoid it.
 */
export function formatLoopWaitLine(input: LoopWaitLineInput): string {
  const soon = input.remainingMs <= LOOP_WAKE_SOON_MS
  const tone = soon ? chalk.yellow : chalk.hex(getTheme().brandHex)
  const early = input.earlyWake ? ` · or ${input.earlyWake.replace(/^wakes earlier when /, 'earlier when ')}` : ''
  const line = tone(`◌ loop · wakes in ${formatDuration(input.remainingMs)}${early}`)
  // The confirmation prompt is the one moment the row talks about keys: the
  // placeholder said "esc twice", the first press happened, say what is next.
  return input.stopPending ? `${line}${chalk.yellow(' · esc again to stop the loop')}` : line
}
