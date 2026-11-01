import stringWidth from 'string-width'
import { createAppSelectorState } from '../app/selector-identity.js'
import { RESUME_SELECTOR_TITLE } from '../app/resume.js'
import { SELECTOR_VIEWPORT, type SelectorItem, type SelectorState } from '../selector.js'
import type { PreviewViewport } from '../preview-scroll.js'
import { buildSelectorRegionLines } from './selector.js'
import { truncateAnsiToWidth } from '../../render/wrap.js'
import { selectorHints, selectorSearch, selectorTitle } from './selector-chrome.js'
import { buildSessionRenameLines } from './session-rename.js'
import { scrollPreview } from './scroll-preview.js'
import { splitPaneHints } from '../split-pane.js'
import { CURSOR_MARKER } from '../render-frame.js'
import { confirmationHint } from './confirmation-hint.js'
import { effortLabel } from './model-effort.js'
import { buildSelectorHeader, buildSelectorRow, buildSessionLineRow, SESSION_ID_COLUMN, sessionLineHeight, type SelectorRowOptions } from './selector-row.js'
import { dim, line, styledLineToAnsi, type StyledLine } from './types.js'
import { finiteSize } from './width.js'

function fullResumeSlot(): SelectorState {
  const items = Array.from({ length: SELECTOR_VIEWPORT + 2 }, (_, index) => ({
    id: `command-window-slot-${index}`,
    label: `session-${index}`,
    detail: 'source title [1 turn] now',
    preview: ['Session title', 'model · 1 turn · now'],
  }))
  return {
    ...createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items),
    subtitle: 'Recent sessions', focusIndex: 1, scrollOffset: 1,
  }
}

function fullModelSlot(): SelectorState {
  const items = Array.from({ length: 7 }, (_, groupIndex) => {
    const group = `Provider ${groupIndex}`
    return [
      { label: group, header: true, focusable: false, group },
      { id: `provider-${groupIndex}:model`, label: `Model ${groupIndex}`, group },
    ]
  }).flat()
  return {
    ...createAppSelectorState('model', 'Models', items),
    presentation: 'model', circularNavigation: true, focusIndex: 7,
  }
}

export interface CommandSelectorRegion {
  lines: string[]
  /** Compact details share this exact viewport with keyboard scrolling. */
  previewViewport?: PreviewViewport
}

/** Reserve populated-window geometry before async rows arrive. The shell
 * supplies the remaining height after status and composer; small panes use a
 * compact, focus-following list rather than scrolling those siblings away. */
export function buildCommandSelectorRegion(
  state: SelectorState,
  columns: number,
  rows: number,
  active: boolean,
  maxRows = Number.POSITIVE_INFINITY,
): CommandSelectorRegion {
  const lines = buildSelectorRegionLines(state, columns, rows, active)
  const slotHeight = Math.max(
    ...[fullResumeSlot(), fullModelSlot()].flatMap(slot => [
      buildSelectorRegionLines(slot, columns, rows, false).length,
      buildSelectorRegionLines(slot, columns, rows, true).length,
    ]),
  )
  const budget = Math.min(slotHeight, Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : slotHeight)
  if (slotHeight > budget || lines.length > budget) return compactCommandRegion(state, columns, budget, active)
  return { lines: [...Array(Math.max(0, budget - lines.length)).fill(''), ...lines] }
}

/** The compact surface has pinned search/action rows and a bounded list. Its
 * height depends on the pane budget, never loading state or keyboard focus. */
function compactCommandRegion(state: SelectorState, columns: number, budget: number, active: boolean): CommandSelectorRegion {
  if (budget === 0) return { lines: [] }
  const width = finiteSize(columns, 80)
  if (state.rename) {
    const rename = buildSessionRenameLines(state.rename, width)
    const cursor = Math.max(0, rename.findIndex(text => text.includes(CURSOR_MARKER)))
    const start = Math.max(0, Math.min(cursor, rename.length - budget))
    const visible = rename.slice(start, start + budget)
    return { lines: [...Array(Math.max(0, budget - visible.length)).fill(''), ...visible] }
  }
  const selected = state.items[state.focusIndex]
  const pending = state.pendingDeleteId !== undefined && selected?.id === state.pendingDeleteId
  const searchFocused = active && state.listFocused !== true && !state.previewPane?.focused
  const search = styledLineToAnsi(pending && state.subtitle && (state.noFilter || budget < 4)
    ? line(confirmationHint(state.subtitle, true))
    : state.noFilter
      ? selectorTitle(state.title, `${state.items.length}`, width)
      : selectorSearch(state.query, width, searchFocused, 'type to search'))
  if (budget === 1) {
    const detail = state.previewPane?.focused
      ? scrollPreview(selected?.preview ?? [], width, 1, state.previewPane.offset).slice(0, 1).map(styledLineToAnsi)
      : [search]
    return { lines: detail.map(text => truncateAnsiToWidth(text, width)),
      ...(state.previewPane ? { previewViewport: { width, height: 1 } } : {}) }
  }

  const header = budget >= 4 && !state.noFilter
    ? [styledLineToAnsi(pending && state.subtitle
      ? line(confirmationHint(state.subtitle, true))
      : selectorTitle(state.title, `${state.items.filter(item => !item.header).length}`, width))]
    : []
  const hint = active
    ? `↑↓ select${selected?.effort ? ' · ←→ reasoning' : ''} · enter confirm · esc close`
    : '↑↓ focus · esc close'
  const hints = state.previewPane ? splitPaneHints(state) : selected?.hints ?? state.hints
  const footer = budget >= 3 ? [styledLineToAnsi(
    active && hints ? selectorHints(hints, width)[0] ?? line(dim(hint)) : line(dim(hint)),
  )] : []
  const listRows = budget - header.length - 1 - footer.length
  let start = Math.max(0, Math.min(state.scrollOffset, Math.max(0, state.items.length - listRows)))
  if (state.focusIndex < start) start = state.focusIndex
  else if (state.focusIndex >= start + listRows) start = state.focusIndex - listRows + 1
  const sessionRow = compactSessionRow(state, width - 1)
  const visible = state.previewPane?.focused
    ? scrollPreview(selected?.preview ?? [], width, listRows, state.previewPane.offset).slice(0, listRows).map(styledLineToAnsi)
    : state.items.slice(start, start + listRows).map((item, index) => {
      const options = { highlighted: start + index === state.focusIndex, query: state.query }
      const session = item.header ? undefined : sessionRow?.(item, options)
      if (session) return styledLineToAnsi(session)
      const detail = item.effort
        ? [effortLabel(item.effort.levels[item.effort.index] ?? ''), item.detail].filter(Boolean).join(' · ')
        : item.detail
      return styledLineToAnsi(item.header ? buildSelectorHeader(item.label, item.headerCount)
        : buildSelectorRow({ ...item, detail }, options))
    })
  if (visible.length === 0) visible.push(styledLineToAnsi(line(dim(state.emptyMessage ?? 'No matches'))))
  while (visible.length < listRows) visible.push('')
  return {
    lines: [...header, search, ...visible, ...footer].map(text => truncateAnsiToWidth(text, width)),
    ...(state.previewPane ? { previewViewport: { width, height: listRows } } : {}),
  }
}

/**
 * One-line session lists keep their `· <id>  <title>  <age>` row in the
 * compact surface too: the id is what `/resume <id>` takes. Each compact
 * entry has one row, so a pane too narrow to share a line with the id falls
 * back to the plain title row.
 */
function compactSessionRow(state: SelectorState, width: number) {
  if (state.rowLayout !== 'session-line') return undefined
  let idWidth = 0
  for (const item of state.items) if (!item.header) idWidth = Math.max(idWidth, stringWidth(item.id ?? ''))
  idWidth = Math.min(idWidth, SESSION_ID_COLUMN)
  return (item: SelectorItem, options: SelectorRowOptions): StyledLine | undefined => {
    if (sessionLineHeight(item, width, idWidth) !== 1) return undefined
    return buildSessionLineRow(item, options, width, idWidth)[0]
  }
}
