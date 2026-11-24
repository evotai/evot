/**
 * The terminal pane colours the TUI draws on, sampled from the live TUI (a slate
 * pane, not pure black). /log shot HTML and the dark phone page both paint on this
 * canvas so a shared screen matches the user's terminal.
 */
export const terminalCanvas = {
  bg: '#3f404e',
  fg: '#e8e8ec',
  muted: '#91929b',
  border: '#2e2f3a',
} as const
