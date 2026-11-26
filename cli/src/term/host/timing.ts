import { SPINNER_INTERVAL_MS } from '../../ui/activity-frames.js'

/** Spinner ticks between terminal-title frames (~960ms). */
export const TITLE_INTERVAL_FRAMES = Math.round(960 / SPINNER_INTERVAL_MS)

/** Tab-title frames for a parked loop: a clock hand sweeping a quarter turn per tick. */
export const LOOP_TITLE_CLOCK = ['◴', '◷', '◶', '◵'] as const
