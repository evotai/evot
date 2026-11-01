/**
 * Paste reference protocol — format, parse, expand, cursor snap, and whole-ref deletion.
 *
 * When a large paste is collapsed into a placeholder like [Pasted text #1 +10 lines],
 * these utilities manage the lifecycle of that reference.
 */

// Threshold: collapse paste when exceeding either limit
export const PASTE_CHAR_THRESHOLD = 800
export const PASTE_LINE_THRESHOLD = 2

/** Format a paste reference string. */
export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines <= 0) return `[Pasted text #${id}]`
  return `[Pasted text #${id} +${numLines} lines]`
}

/** Format an image reference string. */
export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

export type RefType = 'text' | 'image'

export interface PasteRef {
  id: number
  start: number
  end: number
  match: string
  type: RefType
}

const PASTE_REF_RE = /\[(Pasted text|Image) #(\d+)(?:\s\+\d+ lines)?\]/g

/** Parse all paste references (text and image) in a string, returning their positions. */
export function parsePasteRefs(text: string): PasteRef[] {
  const refs: PasteRef[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(PASTE_REF_RE.source, 'g')
  while ((m = re.exec(text)) !== null) {
    refs.push({
      id: parseInt(m[2]!, 10),
      start: m.index,
      end: m.index + m[0]!.length,
      match: m[0]!,
      type: m[1] === 'Image' ? 'image' : 'text',
    })
  }
  return refs
}

/** Expand text paste references with their stored content. Image refs are left intact. */
export function expandPasteRefs(
  text: string,
  store: Map<number, string>,
): string {
  // Replace in reverse order to preserve positions
  const refs = parsePasteRefs(text)
  let result = text
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    if (ref.type !== 'text') continue
    const content = store.get(ref.id)
    if (content !== undefined) {
      result = result.slice(0, ref.start) + content + result.slice(ref.end)
    }
  }
  return result
}

/**
 * Strip only resolved image refs from text.
 * Unresolved image refs (e.g., from history where image data is no longer
 * available) are kept as text markers so the model at least knows an image
 * was referenced.
 */
export function stripResolvedImageRefs(text: string, resolvedIds: Set<number>): string {
  const refs = parsePasteRefs(text)
  let result = text
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    if (ref.type !== 'image') continue
    if (!resolvedIds.has(ref.id)) continue // keep unresolved as text
    result = result.slice(0, ref.start) + result.slice(ref.end)
  }
  return result.replace(/  +/g, ' ').trim()
}

/**
 * Handle backspace at a ref boundary — if cursor is right after a ref end
 * or at a ref start, delete the entire ref.
 * Returns null if no ref was deleted (caller should do normal backspace).
 */
export function deleteRefBackspace(
  line: string,
  cursorCol: number,
  refs: PasteRef[],
): { newLine: string; newCursorCol: number } | null {
  for (const ref of refs) {
    // Cursor is right after the ref end → delete entire ref
    if (cursorCol === ref.end) {
      return {
        newLine: line.slice(0, ref.start) + line.slice(ref.end),
        newCursorCol: ref.start,
      }
    }
  }
  return null
}

/** Should this paste be collapsed into a ref? */
export function shouldCollapse(text: string): boolean {
  const numLines = (text.match(/\n/g) || []).length
  return text.length > PASTE_CHAR_THRESHOLD || numLines > PASTE_LINE_THRESHOLD
}

/** Clean pasted text: strip ANSI, normalize line endings, convert tabs. */
export function cleanPastedText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // strip ANSI escape codes
    .replace(/\r\n/g, '\n')                 // CRLF → LF
    .replace(/\r/g, '\n')                   // CR → LF
    .replace(/\t/g, '    ')                 // tab → 4 spaces
}

export function resolveHistoryText(
  rawText: string,
  pastedChunks: Map<number, string>,
): string {
  return expandPasteRefs(rawText, pastedChunks).trim()
}

/**
 * Resolve the text to submit by expanding paste refs and optionally stripping
 * resolved image refs. This is the canonical submit-text resolution used by
 * the REPL when Enter is pressed.
 */
export function resolveSubmitText(
  rawText: string,
  pastedChunks: Map<number, string>,
  resolvedImageIds: Set<number> | null,
): string {
  const expanded = expandPasteRefs(rawText, pastedChunks)
  if (resolvedImageIds && resolvedImageIds.size > 0) {
    return stripResolvedImageRefs(expanded, resolvedImageIds)
  }
  return expanded.trim()
}
