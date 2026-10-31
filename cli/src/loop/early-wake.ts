/**
 * The one sentence that says a parked loop will not sit out its full delay:
 * a background shell exiting re-invokes the agent at once, the scheduled
 * delay is only the fallback. Built here so the tool result, the wakeup card,
 * `/loop status` and the footer row all say it the same way.
 */

const PREFIX = 'wakes earlier when '

export function earlyWakeSentence(taskIds: readonly string[]): string | null {
  if (taskIds.length === 0) return null
  const ids = taskIds.map(id => id.slice(0, 8))
  if (ids.length === 1) return `${PREFIX}background shell ${ids[0]} finishes`
  return `${PREFIX}any of ${ids.length} background shells (${ids.join(', ')}) finishes`
}

/** Recover the sentence from a `schedule_wakeup` result so the transcript
 *  card can show it without access to live process state. */
export function earlyWakeFromResult(result: string): string | null {
  const start = result.indexOf(PREFIX)
  if (start < 0) return null
  const end = result.indexOf('.', start)
  return result.slice(start, end < 0 ? undefined : end)
}
