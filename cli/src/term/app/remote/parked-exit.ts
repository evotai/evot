/** A TUI the phone opened runs hidden in tmux. Once nobody has followed it for this
 * long and it has nothing in flight, it exits; its session stays saved for Resume. */
export const PARKED_EXIT_MS = 5 * 60_000
export const PARKED_CHECK_MS = 30_000
/** A phone following a window refreshes `lastWatched` about every 200ms (stream)
 * or 800ms (poll); a hidden page stops at once. When all slots are taken, a
 * window nobody has read for this long can make room for a new one. */
export const PARKED_VIEW_GRACE_MS = 3_000
export type ParkReason = 'timeout' | 'capacity'
const UNWATCHED_MS: Record<ParkReason, number> = { timeout: PARKED_EXIT_MS, capacity: PARKED_VIEW_GRACE_MS }

export interface ParkedWindow {
  /** Last /state or /action from a phone, or the last moment the window was not idle. */
  lastWatched: number
  idle: boolean
  /** Unsent text in the composer, e.g. typed after a `tmux attach`. */
  draft: boolean
  /** Someone attached to the tmux session on the computer. */
  attached: boolean
}

/** One rule for both exits; only how long nobody may have watched differs. */
export function canParkWindow(window: ParkedWindow, now: number, reason: ParkReason): boolean {
  return window.idle && !window.draft && !window.attached && now - window.lastWatched >= UNWATCHED_MS[reason]
}

/** Whether a terminal is attached to the tmux session holding this TUI. Unknown
 * (no tmux, tmux error) counts as attached, so a failed probe never closes a window. */
export function tmuxAttached(env: NodeJS.ProcessEnv = process.env): boolean {
  const tmux = env.TMUX && env.TMUX_PANE ? Bun.which('tmux') : null
  if (!tmux) return true
  const out = Bun.spawnSync([tmux, 'display-message', '-p', '-t', env.TMUX_PANE!, '#{session_attached}'],
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 2000 })
  return out.exitCode !== 0 || out.stdout.toString().trim() !== '0'
}
