export const graphemeSegmenter = /* @__PURE__ */ new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Move the text cursor one user-perceived character, without paste-ref semantics. */
export function previousGraphemeBoundary(text: string, cursorCol: number): number {
  const clamped = Math.max(0, Math.min(cursorCol, text.length))
  let previous = 0
  for (const item of graphemeSegmenter.segment(text)) {
    if (item.index >= clamped) break
    previous = item.index
  }
  return previous
}

export function nextGraphemeBoundary(text: string, cursorCol: number): number {
  const clamped = Math.max(0, Math.min(cursorCol, text.length))
  for (const item of graphemeSegmenter.segment(text)) {
    const end = item.index + item.segment.length
    if (clamped < end) return end
  }
  return text.length
}
