import { getTheme } from '../../render/theme/index.js'
import type { SelectorItem } from '../selector.js'
import { colored, dim, line, plain, type StyledLine, type StyledSpan } from './types.js'
import { spansWidth, truncateSpansToWidth, truncateToWidth, wrapTextByWidth } from './width.js'

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

/** Narrowest summary column worth sharing a line with a full session id. */
export const SESSION_LINE_MIN_LABEL = 20
/** Widest id column: a UUID. Longer ids extend only their own row. */
export const SESSION_ID_COLUMN = 36

function sessionLineRight(item: SelectorItem, secondaryHex: string): StyledSpan[] {
  const status = item.status
  return [
    ...(item.badge ? [{ text: item.badge, hex: secondaryHex }] : []),
    ...(status ? [
      ...(item.badge ? [plain(' ')] : []),
      status.tone === 'active' ? colored(status.text, 'cyan') : { text: status.text, hex: secondaryHex },
    ] : []),
  ]
}

interface SessionLineLayout {
  /** The label sits under the id: the list is too narrow to share a line. */
  under: boolean
  /** Columns before the label on its first line. */
  lead: number
  /** The label split into the lines it occupies, the last cut with `…`. */
  lines: string[]
}

/**
 * Where a session row's label goes and how it wraps. Shared by the renderer
 * and the row budget, so a row is drawn in exactly the rows it was given.
 * `labelLines` caps the label: the plain list keeps one line, search results
 * give the summary room for two.
 */
function sessionLineLayout(item: SelectorItem, width: number, idWidth: number, labelLines: number): SessionLineLayout {
  const right = sessionLineRight(item, '')
  const rightWidth = right.length ? spansWidth(right) + 2 : 0
  const lead = 2 + Math.max(idWidth, spansWidth([plain(item.id ?? '')])) + 2
  const under = width - lead - rightWidth < SESSION_LINE_MIN_LABEL
  const room = Math.max(1, under ? width - 2 - rightWidth : width - lead - rightWidth)
  const ranges = wrapTextByWidth(item.label, room)
  const max = Math.max(1, labelLines)
  const lines = ranges.slice(0, max).map(range => item.label.slice(range.start, range.end).trim())
  if (ranges.length > max) {
    const rest = item.label.slice(ranges[max - 1]!.start).trim()
    lines[max - 1] = truncateToWidth(rest, room)
  }
  return { under, lead: under ? 2 : lead, lines: lines.length ? lines : [''] }
}

/** Rows one session entry occupies, including the id line when the label sits under it. */
export function sessionLineHeight(item: SelectorItem, width: number, idWidth: number, labelLines = 1): number {
  const layout = sessionLineLayout(item, width, idWidth, labelLines)
  return layout.lines.length + (layout.under ? 1 : 0)
}

/**
 * Session row: `· <full id>  <label>  <badge> <status>`. The id column has a
 * fixed width so labels align; the label takes what is left, wraps onto at
 * most `labelLines` lines aligned under itself, and is cut with `…`. When the
 * list is too narrow for both, the label moves under the id instead of
 * cutting the id.
 */
export function buildSessionLineRow(item: SelectorItem, options: SelectorRowOptions, width: number, idWidth: number, labelLines = 1): StyledLine[] {
  const { brandHex, mutedHex, selectionBgHex, selectionMutedHex } = getTheme()
  const { highlighted, query = '' } = options
  const bg = highlighted ? selectionBgHex : undefined
  const secondaryHex = highlighted ? selectionMutedHex : mutedHex
  const withBg = (spans: StyledSpan[]) => spans.map(span => ({ ...span, ...(bg ? { bg } : {}) }))
  const id = item.id ?? ''
  const idSpans = highlightSelectorMatches(id, query, { hex: secondaryHex })
  const labelSpans = (text: string): StyledSpan[] => highlighted
    ? [{ text, hex: brandHex, bold: true }]
    : highlightSelectorMatches(text, query, {})
  const right = sessionLineRight(item, secondaryHex)
  const fill = (spans: StyledSpan[]): StyledLine => {
    const cut = truncateSpansToWidth(spans, width)
    cut.push({ text: ' '.repeat(Math.max(0, width - spansWidth(cut))) })
    return { spans: withBg(cut), ...(bg ? { bg } : {}) }
  }
  const marker = rowMarker(highlighted, bg)
  const layout = sessionLineLayout(item, width, idWidth, labelLines)
  const withRight = (spans: StyledSpan[], used: number): StyledSpan[] => right.length
    ? [...spans, plain(' '.repeat(Math.max(2, width - used - spansWidth(spans) - spansWidth(right)))), ...right]
    : spans
  const indent = plain(' '.repeat(layout.lead))
  const [first = '', ...rest] = layout.lines
  if (layout.under) {
    return [
      fill([marker, ...idSpans]),
      fill([indent, ...withRight(labelSpans(first), layout.lead)]),
      ...rest.map(text => fill([indent, ...labelSpans(text)])),
    ]
  }
  const pad = plain(' '.repeat(Math.max(0, layout.lead - spansWidth([marker]) - spansWidth(idSpans))))
  return [
    fill([marker, ...idSpans, pad, ...withRight(labelSpans(first), layout.lead)]),
    ...rest.map(text => fill([indent, ...labelSpans(text)])),
  ]
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
