/**
 * Multiline input continuation detection.
 */

export function needsContinuation(text: string, cursor = text.length): boolean {
  if (text[cursor - 1] === '\\' || text.endsWith('\\')) return true

  let fenceOpen = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      fenceOpen = !fenceOpen
    }
  }
  return fenceOpen
}
