import stringWidth from 'string-width'
import type { SelectorState } from '../selector.js'
import { selectorPreviewGeometry } from '../preview-scroll.js'
import { splitPaneHints } from '../split-pane.js'
import { CURSOR_MARKER } from '../render-frame.js'
import { buildBrowseRow, buildSelectorHeader, buildSessionLineRow, SESSION_ID_COLUMN, sessionLineHeight } from './selector-row.js'
import { selectorColumns, selectorHints, selectorSearch, selectorTitle } from './selector-chrome.js'
import { scrollPreview } from './scroll-preview.js'
import { confirmationHint } from './confirmation-hint.js'
import { dim, line, plain, styledLineToAnsi, type StyledLine } from './types.js'
import { finiteSize, truncateSpansToWidth } from './width.js'

/** Shared browsing surface. Domain factories supply content/actions only. */
export function buildBrowseSelectorLines(state: SelectorState, columns: number, rows: number, active: boolean): string[] {
  const width = Math.max(1, finiteSize(columns, 80) - 1)
  const geometry = selectorPreviewGeometry(state, columns, rows)
  // One-line session rows take the full width; there is no details pane.
  const lineRows = state.rowLayout === 'session-line'
  const paneWidth = lineRows ? 0 : geometry.paneWidth
  const listWidth = paneWidth ? width - paneWidth - 4 : width
  const listHeight = paneWidth || lineRows ? geometry.height : Math.min(4, geometry.height)
  // Align labels after the ids in view. Ids longer than a UUID (some task
  // runs) push only their own row, so one outlier cannot shove every label right.
  let idWidth = 0
  if (lineRows) {
    for (const item of state.items) if (!item.header) idWidth = Math.max(idWidth, stringWidth(item.id ?? ''))
    idWidth = Math.min(idWidth, SESSION_ID_COLUMN)
  }
  const count = state.items.filter(item => !item.header).length
  const total = state.allItems.filter(item => !item.header).length
  const lines: StyledLine[] = [selectorTitle(state.title, state.query ? `${count} / ${total}` : `${count}`, width)]
  const pending = state.pendingDeleteId !== undefined && state.items[state.focusIndex]?.id === state.pendingDeleteId
  lines.push(line(confirmationHint(state.subtitle ?? '', pending)))
  if (!state.noFilter) {
    const focused = active && state.listFocused !== true && !state.previewPane?.focused
    lines.push(selectorSearch(state.query, width, focused,
      focused ? `type to search ${state.searchHint ?? 'titles and text'}` : '/ to search'))
  }
  lines.push(line(plain('')))

  const selected = state.items[state.focusIndex]
  const cost = (at: number) => {
    const item = state.items[at]
    if (!item || item.header) return 1
    return lineRows ? sessionLineHeight(item, listWidth, idWidth, state.labelLines) : 2
  }
  let start = Math.max(0, Math.min(state.scrollOffset, state.focusIndex))
  // Pixel/row budgeting instead of item count: two-line entries and headings
  // must both fit, even when the generic navigator uses a ten-item viewport.
  let used = 0
  for (let at = start; at <= state.focusIndex; at++) used += cost(at)
  while (used > listHeight && start < state.focusIndex) used -= cost(start++)
  const list: StyledLine[] = []
  let end = start
  for (; end < state.items.length; end++) {
    if (list.length + cost(end) > listHeight) break
    const item = state.items[end]!
    // Never leave a heading stranded at the bottom without its first entry.
    if (item.header && end + 1 < state.items.length && list.length + 1 + cost(end + 1) > listHeight) break
    const highlighted = end === state.focusIndex
    list.push(...(item.header ? [buildSelectorHeader(item.label, item.headerCount)]
      : lineRows ? buildSessionLineRow(item, { highlighted, query: state.query }, listWidth, idWidth, state.labelLines)
        : buildBrowseRow(item, { highlighted, query: state.query }, listWidth)))
  }
  if (!state.items.length) list.push(line(dim(state.query ? 'No matches · Esc clears search' : state.emptyMessage ?? 'No items yet')))
  while (list.length < listHeight) list.push(line(plain('')))
  const preview = lineRows ? [] : selected?.preview ?? []
  if (paneWidth) {
    lines.push(...selectorColumns(list, scrollPreview(preview, paneWidth, listHeight, state.previewPane?.offset ?? 0), listWidth))
  } else {
    lines.push(...list)
    if (preview.length) lines.push(line(plain('')), ...scrollPreview(preview, width, geometry.height, state.previewPane?.offset ?? 0))
  }
  lines.push(line(dim(count ? `${state.items.slice(0, state.focusIndex + 1).filter(item => !item.header).length} / ${count}${start > 0 || end < state.items.length ? ' · ↑↓ more' : ''}` : '')))
  const hints = splitPaneHints(state)
  const footer = selectorHints(hints, width)
  // Reserve the largest list footer, so Tab/confirmation never move the prompt.
  const hintSets = new Set(state.allItems.map(item => item.hints ?? state.hints))
  let footerHeight = footer.length
  for (const set of hintSets) footerHeight = Math.max(footerHeight, selectorHints(set ?? [], width).length)
  lines.push(...footer)
  for (let pad = footer.length; pad < footerHeight; pad++) lines.push(line(plain('')))
  return lines.map(row => styledLineToAnsi({ ...row, spans: truncateSpansToWidth(row.spans.filter(span => span.text !== CURSOR_MARKER || active), width) }))
}
