/** Local window control: one evot process asks another to restart in place.
 * Carried on the window's private Unix socket (same user only), never on the
 * phone gateway. A request can only schedule the safe restart or cancel it;
 * an immediate restart that interrupts work stays a local `/restart now`. */

/** What a scheduled restart is still waiting for. */
export type RestartWait =
  | 'question'
  | 'turn'
  | 'loop'
  | 'background'
  | 'queue'
  | 'local'

export interface RestartStatus {
  pid: number
  session: string | null
  terminal: string
  /** Running an older build than the installed binary; null when this window
   * was not started from an installed evot and cannot restart in place. */
  outdated: boolean | null
  restart: 'none' | 'pending' | 'restarting'
  waitingFor?: RestartWait
}

export type RestartRequest = { action: 'restart' } | { action: 'cancel' }

export interface RestartReply {
  accepted: boolean
  message: string
  status: RestartStatus
}

export interface WindowControl {
  status(): RestartStatus
  request(request: RestartRequest): RestartReply
}

export function parseRestartRequest(value: unknown): RestartRequest | null {
  if (!value || typeof value !== 'object') return null
  const action = (value as Record<string, unknown>).action
  return action === 'restart' || action === 'cancel' ? { action } : null
}

const WAITS: readonly RestartWait[] = ['question', 'turn', 'loop', 'background', 'queue', 'local']

export function parseRestartStatus(value: unknown): RestartStatus | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.pid) || typeof row.terminal !== 'string') return null
  if (row.session !== null && typeof row.session !== 'string') return null
  if (row.outdated !== null && typeof row.outdated !== 'boolean') return null
  if (row.restart !== 'none' && row.restart !== 'pending' && row.restart !== 'restarting') return null
  const waitingFor = WAITS.find(wait => wait === row.waitingFor)
  return {
    pid: row.pid as number, session: row.session as string | null, terminal: row.terminal,
    outdated: row.outdated as boolean | null, restart: row.restart, ...(waitingFor ? { waitingFor } : {}),
  }
}

export const RESTART_WAIT_TEXT: Record<RestartWait, string> = {
  question: 'an unanswered question',
  turn: 'the current turn',
  loop: 'the parked /loop',
  background: 'background tasks and their results',
  queue: 'a queued message being prepared or edited',
  local: 'a dialog or command open in the terminal',
}
