/** Animation tick shared by the spinner and the terminal title. */
export const SPINNER_INTERVAL_MS = 100

/** Spinner ticks between terminal-title frames (~960ms). */
export const TITLE_INTERVAL_FRAMES = Math.round(960 / SPINNER_INTERVAL_MS)

/** Tab-title frames for a parked loop: a clock hand sweeping a quarter turn per tick. */
export const LOOP_TITLE_CLOCK = ['◴', '◷', '◶', '◵'] as const
