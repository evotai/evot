import { getTheme } from '../../render/theme/index.js'
import type { SelectorItem } from '../selector.js'
import { colored, dim, line, plain, type StyledLine, type StyledSpan } from './types.js'
import { spansWidth, truncateSpansToWidth, truncateToWidth } from './width.js'

const ROW_MARKER = '·'

/**
 * The gutter cell every selectable row starts with: same glyph whether current
 * or not, so the current row is marked by colour, weight and band, never by a
 * different shape. One definition serves `/model`, `/skill`, `/resume`, the
 * completion menu and the ask overlay, so they cannot drift apart.
 */
export function rowMarker(highlighted: boolean, bg?: string): StyledSpan {
  const { brandHex, mutedHex } = getTheme()
  return highlighted
    ? { text: `${ROW_MARKER} `, hex: brandHex, bold: true, ...(bg ? { bg } : {}) }
    : { text: `${ROW_MARKER} `, hex: mutedHex }
}

/** A group heading over its rows: same treatment on every list, so `/model`,
 *  `/skill` and `/resume` cannot each invent their own. A count, when present,
 *  is the dim tally after the label. */
export function buildSelectorHeader(label: string, count?: number): StyledLine {
  const { accentHex } = getTheme()
  return line(
    plain('  '),
    { text: label, hex: accentHex, bold: true },
    ...(count === undefined ? [] : [dim(` (${count})`)]),
  )
}

export interface SelectorRowOptions {
  /** The row represented by `focusIndex`, even while the composer/filter owns input. */
  highlighted: boolean
  /** Optional filter text. Matches are emphasized only on non-highlighted rows. */
  query?: string
  /** Models use a compact detail/tag gap; generic selectors use two cells. */
  detailGap?: string
}

/**
 * Render one selectable row with the shared selection treatment.
 *
 * A current row is one indivisible visual state: brand foreground, weight, and
 * background always travel together. Keyboard ownership belongs to the selector
 * controller and must not make `/mo`, `/resume`, or a submitted selector draw
 * the same current item differently.
 */
export function buildSelectorRow(item: SelectorItem, options: SelectorRowOptions): StyledLine {
  const {
    highlighted,
    query = '',
    detailGap = '  ',
  } = options
  const { brandHex, selectionBgHex, selectionMutedHex } = getTheme()
  const bg = highlighted ? selectionBgHex : undefined
  const prefix = rowMarker(highlighted, bg)

  const label = highlighted
    ? [{ text: item.label, hex: brandHex, bold: true, bg }]
    : highlightSelectorMatches(item.label, query, {})
  const detail = item.detail
    ? highlighted
      ? [{ text: `${detailGap}${item.detail}`, hex: selectionMutedHex, bg }]
      : highlightSelectorMatches(`${detailGap}${item.detail}`, query, { dim: true })
    : []
  const pinned = item.pinned
    ? [
        { text: ' ', ...(bg ? { bg } : {}) },
        { text: '★', hex: brandHex, ...(bg ? { bg } : {}) },
      ]
    : []
  const selected = item.selected
    ? [
        { text: ' ', ...(bg ? { bg } : {}) },
        { text: '✓', hex: brandHex, bold: true, ...(bg ? { bg } : {}) },
      ]
    : []

  return {
    spans: [prefix, ...label, ...detail, ...pinned, ...selected],
    ...(bg ? { bg } : {}),
  }
}

/** Title-first two-line entry for browsing durable objects. The continuation
 * rail and shared selection band bind metadata to its title. Status has its
 * own width budget, so long titles cannot push running/paused/open off screen. */
export function buildBrowseRow(item: SelectorItem, options: SelectorRowOptions, width: number): StyledLine[] {
  const { brandHex, mutedHex, subtleHex, selectionMutedHex } = getTheme()
  const secondaryHex = options.highlighted ? selectionMutedHex : mutedHex
  const status = item.status
  const statusText = status ? truncateToWidth(status.text, Math.max(0, Math.min(18, width - 8))) : ''
  const right: StyledSpan[] = statusText ? [status?.tone === 'attention' ? colored(statusText, 'red')
    : status?.tone === 'success' ? colored(statusText, 'green')
    : status?.tone === 'active' ? colored(statusText, 'cyan')
    : { text: statusText, hex: secondaryHex }] : []
  const title = buildSelectorRow({ ...item, detail: undefined }, options)
  const titleWidth = Math.max(1, width - spansWidth(right) - (right.length ? 2 : 0))
  const left = truncateSpansToWidth(title.spans, titleWidth)
  const gap = Math.max(0, width - spansWidth(left) - spansWidth(right))
  const bg = title.bg
  const top: StyledLine = { spans: [...left, { text: ' '.repeat(gap), ...(bg ? { bg } : {}) },
    ...right.map(span => ({ ...span, ...(bg ? { bg } : {}) }))], ...(bg ? { bg } : {}) }
  const detail = highlightSelectorMatches(item.detail ?? '', options.query ?? '', { hex: secondaryHex })
  const bottom = truncateSpansToWidth([
    { text: item.detail ? '│ ' : '  ', hex: options.highlighted ? brandHex : subtleHex },
    ...detail,
  ], width)
  bottom.push({ text: ' '.repeat(Math.max(0, width - spansWidth(bottom))) })
  return [top, {
    spans: bottom.map(span => ({ ...span, ...(bg ? { bg } : {}) })),
    ...(bg ? { bg } : {}),
  }]
}

/** Highlight every filter-token occurrence without changing the source text. */
function highlightSelectorMatches(text: string, query: string, base: Partial<StyledSpan>): StyledSpan[] {
  if (!query) return [{ text, ...base }]
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [{ text, ...base }]

  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const token of tokens) {
    let from = 0
    while (from < lower.length) {
      const index = lower.indexOf(token, from)
      if (index === -1) break
      for (let cursor = index; cursor < index + token.length; cursor++) marks[cursor] = true
      from = index + token.length
    }
  }

  const spans: StyledSpan[] = []
  let index = 0
  while (index < text.length) {
    const marked = marks[index] === true
    let end = index + 1
    while (end < text.length && (marks[end] === true) === marked) end++
    const slice = text.slice(index, end)
    spans.push(marked ? colored(slice, 'yellow', { bold: true }) : { text: slice, ...base })
    index = end
  }
  return spans.length > 0 ? spans : [dim(text)]
}
