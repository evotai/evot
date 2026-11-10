/**
 * Build the editor text that should appear after an interrupt cancels a run
 * that still had mid-stream queued user messages.
 *
 * Queued messages go first (in order); any draft already in the editor is kept
 * below them so the user can edit and re-submit with Enter.
 */
export function mergeQueuedIntoEditorText(queued: string[], editorText: string): string {
  const restored = queued.filter(m => m.length > 0).join('\n')
  if (!restored) return editorText
  if (!editorText.trim()) return restored
  return `${restored}\n${editorText}`
}
