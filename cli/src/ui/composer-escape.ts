/** After overlays and completions have had first refusal, both composers use this Esc order. */
export function composerEscape(input: {
  pending: boolean; running: boolean; draft: boolean
  interrupt: 'agent' | 'compaction' | 'background' | 'loop' | null
  stopping?: boolean
}) {
  if (input.pending && (input.running || !input.draft)) return 'restore-queued'
  if (input.interrupt === 'background') return 'stop-background'
  if (input.interrupt === 'loop') return 'stop-loop'
  if (input.interrupt) return 'interrupt'
  if (!input.stopping && input.draft) return 'clear-editor'
  return null
}
