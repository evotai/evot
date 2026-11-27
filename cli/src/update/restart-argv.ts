const VALUE_FLAGS = new Set([
  '-p', '--prompt',
  '-f', '--file',
  '--model',
  '--thinking-level',
  '--env-file',
  '--port',
  '-r', '--resume',
  '--output-format',
  '--max-turns',
  '--max-tokens',
  '--max-duration',
  '--append-system-prompt',
  '--skills',
  '--skill',
])

/** Flags dropped together with their value when the restart pins a session. */
const SESSION_REPLACED_FLAGS = new Set(['--fork', '-r', '--resume'])
/** Startup selection flags; a pinned session's saved selection replaces them. */
const SELECTION_FLAGS = new Set(['--model', '--thinking-level'])

/**
 * Rewrite process argv so an in-place `/restart` resumes a specific session.
 * Drops `-c/--continue`, `--fork` and any existing `-r/--resume`, then pins `--resume`.
 * With a pinned session, `--model` and `--thinking-level` are dropped too:
 * they would otherwise override the selection the session moved to with
 * `/model` or Shift+Tab. Other flags stay as the user typed them.
 */
export function argvForRestart(argv: string[], sessionId: string | null): string[] {
  const next: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--host' || arg === '-c' || arg === '--continue') continue
    const hasValue = Boolean(argv[i + 1] && !argv[i + 1]!.startsWith('-'))
    if (SESSION_REPLACED_FLAGS.has(arg) || (sessionId && SELECTION_FLAGS.has(arg))) {
      if (hasValue) i++
      continue
    }
    next.push(arg)
    if (VALUE_FLAGS.has(arg) && hasValue) next.push(argv[++i]!)
  }
  if (sessionId) next.push('--resume', sessionId)
  return next
}
