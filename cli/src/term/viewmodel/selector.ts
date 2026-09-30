import { backgroundOutputHeaderLines, backgroundOutputViewport, formatOutputPosition } from '../app/background-panel.js'
import { buildSessionRenameLines } from './session-rename.js'
import { buildOutputBlocks } from './output.js'
import { clipDisplayText } from '../../render/format.js'
import { SELECTOR_OWNER } from '../app/selector-identity.js'
import { wrapTextWithAnsi } from '../../render/wrap.js'
import { line, block, plain, dim, bold, colored, blocksToLines, styledLineToAnsi, type ViewBlock, type StyledSpan, type StyledLine } from './types.js'
import { finiteSize, spansWidth, truncateToWidth } from './width.js'
import { PREVIEW_ALERT_PREFIX, PREVIEW_SECTION_PREFIX, SELECTOR_VIEWPORT, selectorEffortLevel, type SelectorItem, type SelectorState } from '../selector.js'
import { HINT_SEPARATOR, formatChord } from '../design/key-hints.js'
import { getTheme } from '../../render/theme/index.js'
import { buildSkillSelectorLines } from './skill-selector.js'
import { scrollPreview } from './scroll-preview.js'
import { confirmationHint } from './confirmation-hint.js'
import { previewGeometry } from '../preview-scroll.js'
import { splitPaneHints } from '../split-pane.js'
import { buildSelectorHeader, buildSelectorRow } from './selector-row.js'
import { buildEffortCell, effortLabel, planEffortLayout } from './model-effort.js'
import { buildBrowseSelectorLines } from './browse-selector.js'
import { selectorColumns, selectorHints, selectorTitle, selectorSearch } from './selector-chrome.js'

/** Render a selector in pi's editorContainer position, never as a modal. */
export function buildSelectorRegionLines(
  state: SelectorState,
  columns: number,
  rows = 24,
  active = true,
): string[] {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80
  if (state.presentation === 'model') return ['', ...buildModelSelectorRegionLines(state, width, active)]

  const border = styledLineToAnsi(line(dim('─'.repeat(width))))
  if (state.owner === SELECTOR_OWNER.resume && state.rename) {
    return ['', border, ...buildSessionRenameLines(state.rename, width), border]
  }
  if (state.presentation === 'browser') {
    return ['', border, ...buildBrowseSelectorLines(state, width, rows, active), border]
  }
  if (state.presentation === 'skill') {
    return ['', border, ...buildSkillSelectorLines(state, width, rows, active), border]
  }
  if (state.presentation === 'background-list') {
    const budget = Math.max(1, Math.floor(rows) - 10)
    const start = Math.min(state.scrollOffset, state.focusIndex)
    const selected = state.items[state.focusIndex]
    const visible: StyledLine[] = []
    // Walk back from focus to fill the viewport, accounting for activity rows.
    let first = state.focusIndex
    let cost = 0
    for (let i = Math.min(state.focusIndex, state.items.length - 1); i >= start; i--) {
      const item = state.items[i]!
      const height = item.activity ? 2 : 1
      if (cost + height > budget && cost > 0) break
      first = i
      cost += height
    }
    for (let i = first; i < state.items.length && visible.length < budget; i++) {
      const item = state.items[i]!
      visible.push(item.header ? line(dim(`  ${item.label}`)) : buildSelectorRow(item, { highlighted: i === state.focusIndex, query: '' }))
      if (item.activity && visible.length < budget) visible.push(line(dim(`    ↳ ${clipDisplayText(item.activity, Math.max(1, width - 6))}`)))
    }
    return ['', border,
      styledLineToAnsi(selectorTitle(state.title, state.subtitle ?? `${state.items.length}`, width)),
      ...(visible.length ? visible : [line(dim(state.emptyMessage ?? 'No tasks'))]).map(styledLineToAnsi),
      ...selectorHints(selected?.hints ?? state.hints ?? [], width).map(styledLineToAnsi), border,
    ].map(text => wrapTextWithAnsi(text, width)[0] ?? '')
  }
  if (state.presentation === 'background-output') {
    return ['', border, ...buildBackgroundOutputRegionLines(state, width, rows), border]
  }

  return ['', border, ...blocksToLines(buildSelectorBlocks(state, width, active, rows)), border]
}

/**
 * Bounded detail: pinned header, a fixed-height body window, one position
 * line, one hint line. The body window is sized from the terminal, not from
 * the scroll position, so paging through earlier output never resizes the
 * overlay or moves the composer beneath it.
 */
function buildBackgroundOutputRegionLines(state: SelectorState, width: number, rows: number): string[] {
  const item = state.items[0]
  const metadata = backgroundOutputHeaderLines(state)
  // List rows summarize commands; detail views show the full command in the
  // scrollable body exactly once. Keep task identity pinned instead.
  const taskId = item?.id?.slice(0, 8)
  const status = metadata.find(text => /^  [●✓✗■]/u.test(text)) ?? item?.detail ?? ''
  const warnings = metadata.filter(text => text.includes('output file was capped'))
  const header = [
    ...buildOutputBlocks([
      { id: 'background-title', kind: 'tool', text: `⌘ Background task${taskId ? ` · ${taskId}` : ''}` },
      { id: 'background-status', kind: 'tool', text: status },
    ], { columns: width }).flatMap(block => block.lines).map(styledLineToAnsi),
    ...warnings.map(text => styledLineToAnsi(line(colored(clipDisplayText(text, width), 'yellow')))),
  ]
  const viewport = backgroundOutputViewport(state, width, rows)
  const indent = width > 2 ? '  ' : ''
  const visible = viewport.body.slice(viewport.start, viewport.end)
  const hints = state.hints ?? [{ keys: 'escape', action: 'back' }]
  return [
    ...header,
    ...visible.map(text => {
      if (text.trim() === '(no output yet)') {
        return styledLineToAnsi(line(dim('  ↳ No stdout/stderr received yet')))
      }
      return styledLineToAnsi(line(plain(`${indent}${text}`)))
    }),
    styledLineToAnsi(line(dim(formatOutputPosition(viewport)))),
    ...selectorHints(hints, width).map(styledLineToAnsi),
  ].map(text => wrapTextWithAnsi(text, width)[0] ?? '')
}

/** Mirrors pi's ModelSelectorComponent hierarchy and line geometry. */
function buildModelSelectorRegionLines(state: SelectorState, width: number, active: boolean): string[] {
  // Keyboard ownership only controls the search caret. The current model row
  // keeps the same shared selection treatment in previews and focused windows.
  const searchFocused = active && state.listFocused !== true
  const border = line(dim('─'.repeat(width)))
  const lines: StyledLine[] = [
    border,
    line(plain('')),
    line(dim(state.subtitle ?? 'Only showing models from configured providers. Run /login to add cloud models.')),
    line(plain('')),
    buildModelSearchLine(state.query, width, searchFocused),
    line(plain('')),
  ]

  const maxVisible = SELECTOR_VIEWPORT
  const start = Math.max(
    0,
    Math.min(
      state.focusIndex - Math.floor(maxVisible / 2),
      state.items.length - maxVisible,
    ),
  )
  const end = Math.min(start + maxVisible, state.items.length)

  const { brandHex } = getTheme()
  // Plan from all filtered model rows, not the current viewport. Policy rows
  // have no effort control and must not push model gauges across the terminal
  // while their explanatory text enters/leaves the viewport.
  const measuredModels = state.items.filter(item => !item.header && item.effort).map(item => ({
    item,
    width: spansWidth(buildSelectorRow(item, { highlighted: false, query: state.query, detailGap: ' ' }).spans),
  }))
  const effortLayout = planEffortLayout(measuredModels, Math.max(1, width - 1))
  // Group separators consume rows too. Reserve the largest viewport geometry
  // so scrolling across a heading never moves the search line or footer.
  let pageHeight = 0
  for (let offset = 0; offset <= Math.max(0, state.items.length - maxVisible); offset++) {
    const page = state.items.slice(offset, offset + maxVisible)
    pageHeight = Math.max(pageHeight, page.length + page.filter((item, at) => at > 0 && item.header).length)
  }
  const pageLines: StyledLine[] = []
  const rowRefs: { item: SelectorItem; width: number; at: number; focused: boolean }[] = []
  let visibleListRowSeen = false
  for (let index = start; index < end; index++) {
    const item = state.items[index]!
    // Group headings are explicit rows, so the server's own label is shown
    // verbatim rather than reverse-engineered from a row's detail text.
    if (item.header) {
      // The viewport can begin halfway through a large group, with its header
      // scrolled offscreen. Still separate the next group from those rows.
      if (visibleListRowSeen) pageLines.push(line(plain('')))
      pageLines.push(buildSelectorHeader(item.label))
      visibleListRowSeen = true
      continue
    }

    const highlighted = index === state.focusIndex
    const row = buildSelectorRow(item, {
      highlighted,
      query: state.query,
      detailGap: ' ',
    })
    rowRefs.push({ item, width: spansWidth(row.spans), at: pageLines.length, focused: highlighted })
    pageLines.push(row)
    visibleListRowSeen = true
  }

  // One column stays free so a full-width row cannot wrap into the next line.
  if (effortLayout) {
    for (const ref of rowRefs) {
      if (!ref.item.effort) continue
      const target = pageLines[ref.at]!
      pageLines[ref.at] = {
        ...target,
        spans: [
          ...target.spans,
          ...buildEffortCell(ref.item.effort, effortLayout, ref.width, {
            focused: ref.focused,
            active,
            ...(target.bg ? { bg: target.bg } : {}),
          }),
        ],
      }
    }
  }
  lines.push(...pageLines)
  for (let pad = pageLines.length; pad < pageHeight; pad++) lines.push(line(plain('')))

  if (start > 0 || end < state.items.length) {
    // Headings are not choices, so the counter reflects models only.
    const models = state.items.filter(item => !item.header)
    const position = models.indexOf(state.items[state.focusIndex]!) + 1
    lines.push(line(dim(`  (${position}/${models.length})`)))
  }

  if (state.items.length === 0) {
    lines.push(line(dim('  No matching models')))
  } else {
    const selected = state.items[state.focusIndex]
    if (selected && !selected.header) {
      lines.push(line(plain('')))
      lines.push(line(dim(`  Model Name: ${selected.label}`)))
      // The gauge alone does not say it can be moved, so the gesture is named
      // only on a row that actually carries a ladder — and only where it would
      // actually work. In a command-window preview the composer still owns the
      // line, so ←/→ move the text cursor there; naming them would be a lie.
      const level = selectorEffortLevel(selected)
      if (level !== undefined) {
        lines.push(line(
          dim('  Effort: '),
          { text: effortLabel(level), hex: brandHex },
          ...(active ? [dim(`${HINT_SEPARATOR}${formatChord(['left', 'right'])} to adjust`)] : []),
        ))
      } else if (measuredModels.length > 0) {
        lines.push(line(plain('')))
      }
    }
  }

  lines.push(line(plain('')))
  lines.push(border)
  return lines.flatMap((styledLine, index) => {
    const rendered = styledLineToAnsi(styledLine)
    if (!rendered) return ['']
    // pi's Input owns horizontal scrolling and does not pass through Text's
    // wrapping, even when the two-column prompt is wider than the viewport.
    if (index === 4) return [rendered]
    return wrapTextWithAnsi(rendered, width)
  })
}

function buildModelSearchLine(query: string, width: number, active: boolean): StyledLine {
  if (width <= 2) return line(plain('> '))
  const search = selectorSearch(query, width, active, '', '> ')
  return line(...search.spans, plain(' '.repeat(Math.max(0, width - spansWidth(search.spans)))))
}

function highlightSpans(text: string, query: string, base: Partial<StyledSpan>): StyledSpan[] {
  if (!query) return [{ text, ...base }]
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [{ text, ...base }]

  // Mark every occurrence of every keyword so multi-token filters light up all
  // matched fragments, not only the first contiguous phrase.
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const token of tokens) {
    if (!token) continue
    let from = 0
    while (from < lower.length) {
      const idx = lower.indexOf(token, from)
      if (idx === -1) break
      for (let i = idx; i < idx + token.length; i++) marks[i] = true
      from = idx + token.length
    }
  }

  const spans: StyledSpan[] = []
  let index = 0
  while (index < text.length) {
    const marked = marks[index] === true
    let end = index + 1
    while (end < text.length && (marks[end] === true) === marked) end++
    const slice = text.slice(index, end)
    spans.push(marked ? { text: slice, fg: 'yellow', bold: true } : { text: slice, ...base })
    index = end
  }
  return spans.length > 0 ? spans : [{ text, ...base }]
}

export function buildSelectorBlocks(
  state: SelectorState,
  columns: number,
  active = true,
  rows = 24,
): ViewBlock[] {
  const selectable = (items: SelectorItem[]) => items.filter(i => !i.header).length
  const countLabel = `${selectable(state.items)}${state.query ? ` of ${selectable(state.allItems)}` : ''}`
  const lines: StyledLine[] = [
    selectorTitle(state.title, countLabel, Math.max(1, finiteSize(columns, 80) - 1)),
  ]

  if (state.subtitle) {
    const pending = state.pendingDeleteId !== undefined && state.items[state.focusIndex]?.id === state.pendingDeleteId
    lines.push(line(confirmationHint(state.subtitle, pending)))
  }

  lines.push(line(plain('')))
  // A no-filter list reserves bare letters for actions, so it shows no filter
  // line: offering one would invite typing that goes nowhere.
  if (!state.noFilter) {
    const filterFocused = active && state.listFocused !== true
    const target = state.searchHint ?? SEARCH_TARGET
    const searchEntry = state.listFocused === true ? `/ to search ${target}` : `type to search ${target}`
    lines.push(selectorSearch(state.query, Math.max(1, finiteSize(columns, 80) - 1), filterFocused, searchEntry, 'Filter  '))
    lines.push(line(plain('')))
  }

  // The focused row's preview sits beside the list, so rows and pane share the
  // width budget. Without a preview the list keeps the whole line. One column
  // stays free so a full-width row cannot wrap into the next terminal line.
  const available = Math.max(1, finiteSize(columns, 80) - 1)
  const paneWidth = selectorPaneWidth(state, available)
  const geometry = state.previewPane ? previewGeometry(columns, rows) : undefined
  const listLines = buildSelectorListLines(state, geometry?.listRows)
  if (paneWidth > 0) {
    const preview = state.items[state.focusIndex]?.preview ?? []
    // Height is the list viewport, not the focused preview: a short session
    // would otherwise shrink the pane and jump the composer when focus moves.
    const paneRows = state.previewPane
      ? geometry!.height
      : Math.max(listLines.length, PANE_MIN_ROWS)
    lines.push(...joinPaneColumns(
      listLines,
      state.previewPane
        ? scrollPreview(preview, paneWidth, paneRows, state.previewPane.offset)
        : padPreviewLines(buildPreviewLines(preview, state.query, paneWidth, paneRows), paneRows),
      available - paneWidth - PANE_DIVIDER.length,
    ))
  } else {
    lines.push(...listLines)
    if (state.previewPane && state.items[state.focusIndex]?.preview) {
      lines.push(line(plain('')))
      lines.push(...scrollPreview(state.items[state.focusIndex]!.preview!, available, geometry!.height, state.previewPane.offset))
    }
  }

  lines.push(line(plain('')))
  // A focused row's own hints win over the selector's, so a gesture is only ever
  // offered where it would actually do something. Selectors that predate the
  // hint list keep their hand-written lines below.
  const hints = state.previewPane ? splitPaneHints(state) : state.items[state.focusIndex]?.hints ?? state.hints
  if (hints) {
    lines.push(...selectorHints(hints, available, state.lowercaseHints))
  } else {
    const defaults = state.owner === SELECTOR_OWNER.queue
      ? [{ keys: 'enter', action: 'edit' }, { keys: 'Ctrl+D', action: 'remove' }, { keys: 'esc', action: 'close' }]
      : [{ keys: '↑↓', action: state.circularNavigation ? 'move · wraps' : 'move' },
        { keys: 'enter', action: 'select' }, { keys: 'type', action: 'filter' }, { keys: 'esc', action: 'close' }]
    lines.push(...selectorHints(defaults, available))
  }
  return [block(lines, 1)]
}

/** The list rows themselves — everything between the filter line and the hints. */
function buildSelectorListLines(state: SelectorState, viewport = SELECTOR_VIEWPORT): StyledLine[] {
  if (state.items.length === 0) {
    if (state.emptyMessage) return [line(dim(`  ${state.emptyMessage}`))]
    // A no-filter list has no query to explain an empty result, so the generic
    // "no matching items" would misdescribe it.
    if (state.noFilter) return []
    return [line(dim('  No matching items'))]
  }

  const lines: StyledLine[] = []
  const maxVisible = viewport
  // The window follows scrollOffset (updated one row at a time by up/down),
  // clamped defensively so the focused row is always on screen.
  let start = Math.min(Math.max(state.scrollOffset, 0), Math.max(0, state.items.length - maxVisible))
  if (state.focusIndex < start) start = state.focusIndex
  else if (state.focusIndex >= start + maxVisible) start = state.focusIndex - maxVisible + 1
  const end = Math.min(start + maxVisible, state.items.length)

  if (start > 0) {
    lines.push(line(dim(`  ↑ ${start} above`)))
  }
  // Groups after the first are separated by one blank line, whether the list
  // supplies its own spacer header or not. Keyed off what is on screen, since
  // the viewport can start mid-list.
  let seenRow = false
  let blankPending = false
  for (let i = start; i < end; i++) {
    const item = state.items[i]!
    if (item.header) {
      if (!item.label) {
        blankPending = seenRow
        continue
      }
      if (seenRow) lines.push(line(plain('')))
      lines.push(buildSelectorHeader(item.label, item.headerCount))
      seenRow = true
      blankPending = false
      continue
    }
    if (blankPending) lines.push(line(plain('')))
    blankPending = false
    seenRow = true
    const highlighted = i === state.focusIndex
    lines.push(buildSelectorRow(item, {
      highlighted,
      query: state.query,
    }))
  }
  if (end < state.items.length) {
    lines.push(line(dim(`  ↓ ${state.items.length - end} below`)))
  }
  return lines
}

/** What the session list's filter searches; other lists name their own. */
const SEARCH_TARGET = 'titles, prompts and transcript text'

/** Gap and rail between the list and its preview pane. */
const PANE_DIVIDER = '  │ '

/**
 * Rows the pane keeps even when the list is shorter. Session summaries need a
 * few lines of body text to be worth reading; a two-row pane beside a two-row
 * list would only ever show metadata.
 */
const PANE_MIN_ROWS = SELECTOR_VIEWPORT

/**
 * Pane width in columns, or 0 when the pane is suppressed. Every split window
 * shares `previewGeometry`, so the list/details proportion is the same
 * everywhere, and narrow terminals keep the single-column layout.
 */
function selectorPaneWidth(state: SelectorState, columns: number): number {
  const focused = state.items[state.focusIndex]
  if (!focused?.preview || focused.preview.length === 0) return 0
  // One width for every focused row, so moving between sessions does not
  // slide the divider.
  return previewGeometry(columns + 1, 24).paneWidth
}

/**
 * Rows the pane header may claim when there is a body to show. A long title
 * would otherwise push the body out entirely, and the body is the reason the
 * pane exists.
 */
const PANE_MAX_HEADER_ROWS = 4

/**
 * Rows one body entry may claim. A single long turn (a pasted draft, a spec)
 * would otherwise fill the pane by itself and read as an unattributed wall of
 * text, hiding every other turn in the session.
 */
const PANE_MAX_ENTRY_ROWS = 3

/**
 * Render a preview into the pane. Entries before the first blank are the header
 * and stay pinned; the rest is the body, laid out as labelled sections.
 *
 * Sections trim by priority, not position. The first section (what the session
 * set out to do) is pinned. The second is the list: when space is short it
 * keeps its tail — the latest turns say where the session left off — or, while
 * filtering, the run of entries from the first match so the user can see why
 * the row matched; either cut is marked with `⋮`. Sections after the second
 * are dropped whole before anything else is truncated. The body is windowed by
 * entry, never by wrapped row, so a marker (`› `) is never orphaned from its
 * text.
 */
function buildPreviewLines(preview: string[], query: string, width: number, maxRows: number): StyledLine[] {
  const split = preview.indexOf('')
  const header = split === -1 ? preview : preview.slice(0, split)
  const body = split === -1 ? [] : preview.slice(split + 1)

  const headerRows = header
    .flatMap((entry, index) => wrapTextWithAnsi(entry, width).map(row => ({ row, heading: index === 0 })))
    .slice(0, body.length > 0 ? Math.min(PANE_MAX_HEADER_ROWS, maxRows - 1) : maxRows)
    .map(({ row, heading }) => line(...(
      query
        ? highlightSpans(row, query, heading ? { bold: true } : { dim: true })
        : [heading ? bold(row) : dim(row)]
    )))

  const sections = parsePreviewSections(body, width)
  // A blank row separates header from body, so the body's budget is one less.
  const budget = Math.max(0, maxRows - headerRows.length - 1)
  if (sections.length === 0 || budget === 0) return headerRows
  return [...headerRows, line(plain('')), ...layoutPreviewSections(sections, query, budget)]
}

interface PaneEntry {
  /** Wrapped rows. */
  rows: string[]
  /** Drawn in the alert colour regardless of section emphasis. */
  alert: boolean
}

interface PaneSection {
  label?: string
  entries: PaneEntry[]
}

/** Split a body into labelled sections; a body without labels is one section. */
function parsePreviewSections(body: string[], width: number): PaneSection[] {
  const sections: PaneSection[] = []
  for (const entry of body) {
    if (entry.startsWith(PREVIEW_SECTION_PREFIX)) {
      sections.push({ label: entry.slice(PREVIEW_SECTION_PREFIX.length), entries: [] })
      continue
    }
    // Blank entries only separate sections; the layout re-inserts spacing.
    if (!entry) continue
    if (sections.length === 0) sections.push({ entries: [] })
    const alert = entry.startsWith(PREVIEW_ALERT_PREFIX)
    const text = alert ? entry.slice(PREVIEW_ALERT_PREFIX.length) : entry
    sections[sections.length - 1]!.entries.push({ rows: wrapPreviewEntry(text, width), alert })
  }
  return sections.filter(section => section.entries.length > 0)
}

function sectionRows(section: PaneSection): number {
  return (section.label ? 1 : 0) + section.entries.reduce((sum, entry) => sum + entry.rows.length, 0)
}

function layoutPreviewSections(all: PaneSection[], query: string, budget: number): StyledLine[] {
  let sections = all.map(section => ({ ...section, entries: [...section.entries], cut: false }))
  const listIndex = sections.length > 1 ? 1 : 0
  const total = () => sections.reduce((sum, section) => sum + sectionRows(section), 0) + Math.max(0, sections.length - 1)

  // 1. Trim the list section to whole entries that fit, anchored on a filter
  //    hit or on the tail. The `⋮` marker costs a row of the list's budget.
  if (total() > budget) {
    const list = sections[listIndex]!
    const others = total() - sectionRows(list)
    const room = Math.max(1, budget - others - (list.label ? 1 : 0) - 1)
    const kept = selectPreviewEntries(list.entries, query, room)
    list.cut = kept.length < list.entries.length || kept.some((entry, i) => entry !== list.entries[i])
    list.entries = kept
  }
  // 2. Drop optional trailing sections whole.
  while (total() > budget && sections.length > 2) sections = sections.slice(0, -1)
  // 3. Last resort: truncate the pinned section's rows so something still shows.
  if (total() > budget && sections.length > 0) {
    const pinned = sections[0]!
    const others = total() - sectionRows(pinned)
    const room = Math.max(1, budget - others - (pinned.label ? 1 : 0))
    pinned.entries = truncateEntries(pinned.entries, room)
  }

  const lines: StyledLine[] = []
  sections.forEach((section, index) => {
    if (index > 0) lines.push(line(plain('')))
    if (section.label) lines.push(line(dim(section.label)))
    if (section.cut) lines.push(line(dim('  ⋮')))
    const isList = index === listIndex && sections.length > 1
    section.entries.forEach((entry, entryIndex) => {
      // The pinned opening ask and the newest turn carry full contrast; the
      // rest of the list and any path summary stay subdued.
      const emphasized = index === 0 ? sections.length > 1 : isList && entryIndex === section.entries.length - 1
      for (const row of entry.rows) lines.push(previewBodyLine(row, query, emphasized, entry.alert))
    })
  })
  return lines
}

/**
 * Whole entries that fit `budget` rows: the earliest filter hit onwards, else
 * the latest turns. Walking forward from the chosen anchor keeps entries in
 * conversation order and stops before one would be cut in half.
 */
function selectPreviewEntries(entries: PaneEntry[], query: string, budget: number): PaneEntry[] {
  const anchor = previewAnchorEntry(entries, query, budget)
  const kept: PaneEntry[] = []
  let used = 0
  for (let i = anchor; i < entries.length; i++) {
    const entry = entries[i]!
    if (used + entry.rows.length > budget) break
    kept.push(entry)
    used += entry.rows.length
  }
  // A single entry taller than the whole budget still has to say something, so
  // it is truncated rather than dropped.
  if (kept.length === 0) {
    const first = entries[anchor]
    return first ? [{ ...first, rows: first.rows.slice(0, budget) }] : []
  }
  return kept
}

/** Keep whole entries from the top while they fit, then cut the next one. */
function truncateEntries(entries: PaneEntry[], budget: number): PaneEntry[] {
  const kept: PaneEntry[] = []
  let used = 0
  for (const entry of entries) {
    if (used >= budget) break
    const rows = entry.rows.slice(0, budget - used)
    kept.push({ ...entry, rows })
    used += rows.length
  }
  return kept
}

/** Index of the first entry to show: the earliest filter hit, else the tail. */
function previewAnchorEntry(entries: PaneEntry[], query: string, budget: number): number {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length > 0) {
    const hit = entries.findIndex(entry => {
      const text = entry.rows.join(' ').toLowerCase()
      return tokens.some(token => text.includes(token))
    })
    if (hit !== -1) return hit
  }
  // Walk back from the end while whole entries still fit.
  let used = 0
  let anchor = entries.length
  while (anchor > 0) {
    const rows = entries[anchor - 1]?.rows.length ?? 0
    if (used + rows > budget) break
    used += rows
    anchor--
  }
  return Math.min(anchor, entries.length - 1)
}

function previewBodyLine(row: string, query: string, emphasized = false, alert = false): StyledLine {
  if (alert) return line(colored(row, 'red'))
  if (query) return line(...highlightSpans(row, query, emphasized ? {} : { dim: true }))
  return line(emphasized ? plain(row) : dim(row))
}

/**
 * Wrap one preview entry, indenting continuations under a leading marker so a
 * long entry reads as one block instead of merging into the next. Capped at
 * [`PANE_MAX_ENTRY_ROWS`], with the cut marked in place.
 */
function wrapPreviewEntry(entry: string, width: number): string[] {
  const marker = /^(\S\s)/.exec(entry)?.[1]
  const indent = marker ? '' : (/^(\s+)/.exec(entry)?.[1] ?? '')
  const lead = marker ?? indent
  // A marker attributes only its first row; continuation rows indent under it
  // so a wrapped turn still reads as one block. An indented entry keeps its
  // indent on every row.
  const rows = lead
    ? wrapTextWithAnsi(entry.slice(lead.length), Math.max(1, width - lead.length))
      .map((row, index) => `${index === 0 ? lead : marker ? ' '.repeat(marker.length) : indent}${row}`)
    : wrapTextWithAnsi(entry, width)
  if (rows.length <= PANE_MAX_ENTRY_ROWS) return rows

  const kept = rows.slice(0, PANE_MAX_ENTRY_ROWS)
  const last = kept[PANE_MAX_ENTRY_ROWS - 1] ?? ''
  kept[PANE_MAX_ENTRY_ROWS - 1] = `${truncateToWidth(last, Math.max(1, width - 1))}…`
  return kept
}

/**
 * Lay the list and pane side by side. Each list row is padded to `listWidth`
 * so the divider column stays straight regardless of row content, and a row's
 * own background (model presentation) is not used here, so plain padding is
 * enough.
 */
function joinPaneColumns(listLines: StyledLine[], paneLines: StyledLine[], listWidth: number): StyledLine[] {
  return selectorColumns(listLines, paneLines, listWidth, PANE_DIVIDER)
}

/** Keep the pane the same height as the list, even when the preview is short. */
function padPreviewLines(lines: StyledLine[], rows: number): StyledLine[] {
  if (lines.length >= rows) return lines.slice(0, rows)
  return [...lines, ...Array.from({ length: rows - lines.length }, () => line(plain('')))]
}