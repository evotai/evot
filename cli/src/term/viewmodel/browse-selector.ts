import type { SelectorState } from '../selector.js'
import { selectorPreviewGeometry } from '../preview-scroll.js'
import { splitPaneHints } from '../split-pane.js'
import { CURSOR_MARKER } from '../render-frame.js'
import { buildBrowseRow, buildSelectorHeader } from './selector-row.js'
import { selectorColumns, selectorHints, selectorSearch, selectorTitle } from './selector-chrome.js'
import { scrollPreview } from './scroll-preview.js'
import { confirmationHint } from './confirmation-hint.js'
import { dim, line, plain, styledLineToAnsi, type StyledLine } from './types.js'
import { finiteSize, truncateSpansToWidth } from './width.js'

/** Shared browsing surface. Domain factories supply content/actions only. */
export function buildBrowseSelectorLines(state: SelectorState, columns: number, rows: number, active: boolean): string[] {
  const width = Math.max(1, finiteSize(columns, 80) - 1)
  const geometry = selectorPreviewGeometry(state, columns, rows)
  const listWidth = geometry.paneWidth ? width - geometry.paneWidth - 4 : width
  const listHeight = geometry.paneWidth ? geometry.height : Math.min(4, geometry.height)
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
  const cost = (at: number) => state.items[at]?.header ? 1 : 2
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
    list.push(...(item.header ? [buildSelectorHeader(item.label, item.headerCount)]
      : buildBrowseRow(item, { highlighted: end === state.focusIndex, query: state.query }, listWidth)))
  }
  if (!state.items.length) list.push(line(dim(state.query ? 'No matches · Esc clears search' : state.emptyMessage ?? 'No items yet')))
  while (list.length < listHeight) list.push(line(plain('')))
  const preview = selected?.preview ?? []
  if (geometry.paneWidth) {
    lines.push(...selectorColumns(list, scrollPreview(preview, geometry.paneWidth, listHeight, state.previewPane?.offset ?? 0), listWidth))
  } else {
    lines.push(...list)
    if (preview.length) lines.push(line(plain('')), ...scrollPreview(preview, width, geometry.height, state.previewPane?.offset ?? 0))
  }
  lines.push(line(dim(count ? `${state.items.slice(0, state.focusIndex + 1).filter(item => !item.header).length} / ${count}${start > 0 || end < state.items.length ? ' · ↑↓ more' : ''}` : '')))
  const hints = splitPaneHints(state)
  const footer = selectorHints(hints, width, state.lowercaseHints)
  // Reserve the largest list footer, so Tab/confirmation never move the prompt.
  const hintSets = new Set(state.allItems.map(item => item.hints ?? state.hints))
  let footerHeight = footer.length
  for (const set of hintSets) footerHeight = Math.max(footerHeight, selectorHints(set ?? [], width, state.lowercaseHints).length)
  lines.push(...footer)
  for (let pad = footer.length; pad < footerHeight; pad++) lines.push(line(plain('')))
  return lines.map(row => styledLineToAnsi({ ...row, spans: truncateSpansToWidth(row.spans.filter(span => span.text !== CURSOR_MARKER || active), width) }))
}
