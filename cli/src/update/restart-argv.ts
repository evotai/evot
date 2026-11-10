const VALUE_FLAGS = new Set([
  '-p', '--prompt',
  '-f', '--file',
  '--model',
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

/**
 * Rewrite process argv so an in-place `/restart` resumes a specific session.
 * Drops `-c/--continue`, `--fork` and any existing `-r/--resume`, then pins `--resume`.
 * Other flags stay as the user typed them.
 */
export function argvForRestart(argv: string[], sessionId: string | null): string[] {
  const next: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-c' || arg === '--continue') continue
    if (arg === '--fork' || arg === '-r' || arg === '--resume') {
      if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) i++
      continue
    }
    next.push(arg)
    if (VALUE_FLAGS.has(arg) && argv[i + 1] && !argv[i + 1]!.startsWith('-')) {
      next.push(argv[++i]!)
    }
  }
  if (sessionId) next.push('--resume', sessionId)
  return next
}
