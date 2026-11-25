import stringWidth from 'string-width'
import { parsePasteRefs } from './paste_refs.js'
import { graphemeSegmenter } from '../../ui/grapheme.js'

export interface TextSegment {
  text: string
  start: number
  end: number
  width: number
  atomic: boolean
}

/**
 * Segment editor text on user-perceived character boundaries. Paste and image
 * references are represented as one logical unit so editing cannot enter them.
 */
export function segmentEditorText(text: string): TextSegment[] {
  if (!text) return []

  const refs = parsePasteRefs(text)
  const segments: TextSegment[] = []
  let refIndex = 0
  let offset = 0

  while (offset < text.length) {
    const ref = refs[refIndex]
    if (ref && offset === ref.start) {
      segments.push({
        text: ref.match,
        start: ref.start,
        end: ref.end,
        width: stringWidth(ref.match),
        atomic: true,
      })
      offset = ref.end
      refIndex++
      continue
    }

    const end = ref?.start ?? text.length
    for (const item of graphemeSegmenter.segment(text.slice(offset, end))) {
      const start = offset + item.index
      const segmentEnd = start + item.segment.length
      segments.push({
        text: item.segment,
        start,
        end: segmentEnd,
        width: stringWidth(item.segment),
        atomic: false,
      })
    }
    offset = end
  }

  return segments
}

export function previousSegmentBoundary(text: string, cursorCol: number): number {
  let previous = 0
  for (const segment of segmentEditorText(text)) {
    if (cursorCol <= segment.start) return previous
    if (cursorCol <= segment.end) return segment.start
    previous = segment.end
  }
  return previous
}

export function nextSegmentBoundary(text: string, cursorCol: number): number {
  for (const segment of segmentEditorText(text)) {
    if (cursorCol < segment.end) return segment.end
  }
  return text.length
}

export function snapToSegmentBoundary(text: string, cursorCol: number): number {
  const clamped = Math.max(0, Math.min(cursorCol, text.length))
  for (const segment of segmentEditorText(text)) {
    if (clamped <= segment.start) return segment.start
    if (clamped < segment.end) {
      return clamped - segment.start < segment.end - clamped ? segment.start : segment.end
    }
  }
  return text.length
}

export function displayWidthBefore(text: string, cursorCol: number): number {
  const boundary = snapToSegmentBoundary(text, cursorCol)
  let width = 0
  for (const segment of segmentEditorText(text)) {
    if (segment.end > boundary) break
    width += segment.width
  }
  return width
}

export function boundaryAtDisplayWidth(text: string, targetWidth: number): number {
  const target = Math.max(0, targetWidth)
  let width = 0
  let boundary = 0
  for (const segment of segmentEditorText(text)) {
    if (width + segment.width > target) break
    width += segment.width
    boundary = segment.end
  }
  return boundary
}

export interface TextChunk {
  start: number
  end: number
}

const cjkBreakRegex = /[\u3040-\u30ff\u3100-\u312f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/u

/**
 * Word-aware visual wrapping on grapheme boundaries. References may wrap on a
 * narrow terminal, but remain atomic for cursor movement and deletion.
 */
export function wrapEditorText(text: string, maxWidth: number): TextChunk[] {
  if (maxWidth <= 0 || text.length === 0) return [{ start: 0, end: text.length }]

  const segments = [...graphemeSegmenter.segment(text)].map(item => ({
    text: item.segment,
    start: item.index,
    end: item.index + item.segment.length,
    width: stringWidth(item.segment),
  }))
  const chunks: TextChunk[] = []
  let chunkStartIndex = 0

  while (chunkStartIndex < segments.length) {
    let used = 0
    let endIndex = chunkStartIndex
    let wrapIndex = -1

    while (endIndex < segments.length) {
      const segment = segments[endIndex]!
      if (used + segment.width > maxWidth && endIndex > chunkStartIndex) break
      used += segment.width
      endIndex++

      const next = segments[endIndex]
      if (!next) continue
      const isWhitespace = /^\s+$/u.test(segment.text)
      const nextIsWhitespace = /^\s+$/u.test(next.text)
      if ((isWhitespace && !nextIsWhitespace)
        || (!isWhitespace && !nextIsWhitespace && (cjkBreakRegex.test(segment.text) || cjkBreakRegex.test(next.text)))) {
        wrapIndex = endIndex
      }
    }

    if (endIndex >= segments.length) {
      chunks.push({ start: segments[chunkStartIndex]!.start, end: text.length })
      break
    }

    const splitIndex = wrapIndex > chunkStartIndex ? wrapIndex : Math.max(chunkStartIndex + 1, endIndex)
    chunks.push({
      start: segments[chunkStartIndex]!.start,
      end: segments[splitIndex - 1]!.end,
    })
    chunkStartIndex = splitIndex
  }

  return chunks.length > 0 ? chunks : [{ start: 0, end: text.length }]
}
