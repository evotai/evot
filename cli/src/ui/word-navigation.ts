/**
 * Word navigation for the multi-line editor.
 *
 * Ported from pi-tui's word-navigation, adapted to evot's atomic paste/image
 * refs via segmentEditorText:
 *   ~/github/pi/packages/tui/src/word-navigation.ts
 *
 * Atomic paste/image references are never split. Between them, Intl.Segmenter
 * word granularity groups runs like "code" into a single word unit.
 */

type AtomicRanges = readonly { start: number; end: number }[]

const wordSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/

interface NavSegment {
  text: string
  start: number
  end: number
  atomic: boolean
  isWordLike: boolean
}

function isWhitespaceText(text: string): boolean {
  return /^\s+$/u.test(text)
}

/**
 * Build navigation segments: atomic paste/image refs first, then word segments
 * for the plain-text gaps so "hello_world" / CJK / emoji stay coherent.
 */
function buildNavSegments(text: string, refs: AtomicRanges): NavSegment[] {
  if (!text) return []
  const segments: NavSegment[] = []
  let offset = 0
  let refIndex = 0

  while (offset < text.length) {
    const ref = refs[refIndex]
    if (ref && offset === ref.start) {
      segments.push({
        text: text.slice(ref.start, ref.end),
        start: ref.start,
        end: ref.end,
        atomic: true,
        isWordLike: false,
      })
      offset = ref.end
      refIndex++
      continue
    }

    const end = ref?.start ?? text.length
    const slice = text.slice(offset, end)
    const words = wordSegmenter?.segment(slice) ?? Array.from(slice.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu),
      m => ({ segment: m[0], index: m.index, isWordLike: /^[\p{L}\p{N}_]/u.test(m[0]) }))
    for (const item of words) {
      const start = offset + item.index
      const segmentEnd = start + item.segment.length
      segments.push({
        text: item.segment,
        start,
        end: segmentEnd,
        atomic: false,
        isWordLike: Boolean(item.isWordLike),
      })
    }
    offset = end
  }

  return segments
}

/**
 * Cursor position after moving one word backward from `cursor` in `text`.
 * Skips trailing whitespace, then stops at the next word/punctuation boundary.
 * Atomic paste/image references are treated as a single unit.
 */
export function findWordBackward(text: string, cursor: number, refs: AtomicRanges = []): number {
  if (cursor <= 0) return 0

  // Include the segment that contains the cursor (start < cursor), truncated to
  // the cursor so mid-word jumps still stop at the previous boundary.
  const segments = buildNavSegments(text, refs)
    .filter(segment => segment.start < cursor)
    .map(segment => segment.end <= cursor
      ? segment
      : {
          ...segment,
          text: text.slice(segment.start, cursor),
          end: cursor,
        })
  let newCursor = cursor

  // Skip trailing whitespace
  while (segments.length > 0) {
    const last = segments[segments.length - 1]!
    if (last.atomic || !isWhitespaceText(last.text)) break
    newCursor = last.start
    segments.pop()
  }

  if (segments.length === 0) return newCursor

  const last = segments[segments.length - 1]!
  if (last.atomic) return last.start

  if (last.isWordLike) {
    // Within a word-like segment, stop after the last punctuation cluster so
    // `foo.bar|` → `foo.|bar` rather than jumping the whole token when the
    // segmenter kept the punctuation inside the word.
    const matches = [...last.text.matchAll(new RegExp(PUNCTUATION_REGEX, 'g'))]
    if (matches.length <= 0) return last.start
    const lastMatch = matches[matches.length - 1]!
    const afterPunct = last.start + lastMatch.index! + lastMatch[0]!.length
    // If the cursor is already right after that punctuation, jump the word body.
    if (afterPunct < cursor) return afterPunct
    return last.start
  }

  // Skip non-word non-whitespace run (punctuation)
  while (segments.length > 0) {
    const segment = segments[segments.length - 1]!
    if (segment.atomic || segment.isWordLike || isWhitespaceText(segment.text)) break
    newCursor = segment.start
    segments.pop()
  }
  return newCursor
}

/**
 * Cursor position after moving one word forward from `cursor` in `text`.
 * Skips leading whitespace, then stops at the next word/punctuation boundary.
 * Atomic paste/image references are treated as a single unit.
 */
export function findWordForward(text: string, cursor: number, refs: AtomicRanges = []): number {
  if (cursor >= text.length) return text.length

  const segments = buildNavSegments(text, refs)
    .filter(segment => segment.end > cursor)
    .map(segment => segment.start >= cursor
      ? segment
      : {
          ...segment,
          text: text.slice(cursor, segment.end),
          start: cursor,
        })
  let index = 0
  let newCursor = cursor

  // Skip leading whitespace
  while (index < segments.length) {
    const segment = segments[index]!
    if (segment.atomic || !isWhitespaceText(segment.text)) break
    newCursor = segment.end
    index++
  }

  if (index >= segments.length) return newCursor

  const current = segments[index]!
  if (current.atomic) return current.end

  if (current.isWordLike) {
    const match = PUNCTUATION_REGEX.exec(current.text)
    if (match?.index !== undefined) {
      if (match.index > 0) return current.start + match.index
      // Cursor is on leading punctuation (mid-segment entry). Skip the punct
      // cluster so the next move can enter the following word body.
      let i = 0
      while (i < current.text.length && PUNCTUATION_REGEX.test(current.text[i]!)) i++
      return current.start + Math.max(i, 1)
    }
    return current.end
  }

  // Skip non-word non-whitespace run (punctuation)
  while (index < segments.length) {
    const segment = segments[index]!
    if (segment.atomic || segment.isWordLike || isWhitespaceText(segment.text)) break
    newCursor = segment.end
    index++
  }
  return newCursor
}
