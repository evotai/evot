import { getTheme } from '../../render/theme/index.js'
import { clipDisplayText } from '../../render/format.js'
import { wrapTextWithAnsi } from '../../render/wrap.js'
import { SELECTOR_VIEWPORT, type SelectorState } from '../selector.js'
import { previewGeometry } from '../preview-scroll.js'
import { buildSelectorRow } from './selector-row.js'
import { line, plain, styledLineToAnsi } from './types.js'
import { selectorColumns, selectorHints, selectorSearch, selectorTitle } from './selector-chrome.js'

/** Source-grouped tree on the left, bounded usage details on the right. */
export function buildSkillSelectorLines(state: SelectorState, width: number, rows: number, active: boolean): string[] {
  const theme = getTheme()
  const muted = (text: string) => theme.thinkText.paint(text)
  // Same split as every other list-with-details window.
  const paneWidth = previewGeometry(width + 1, rows).paneWidth
  const wide = paneWidth > 0
  const listWidth = wide ? width - paneWidth - 5 : Math.max(1, width - 2)
  const detailWidth = wide ? paneWidth : Math.max(1, width - 2)
  const clip = (text: string, size = width) => clipDisplayText(text, Math.max(0, size))
  const budget = Math.max(1, Math.min(SELECTOR_VIEWPORT, Math.floor(rows) - (wide ? 14 : 20)))
  let start = Math.min(Math.max(0, state.scrollOffset), Math.max(0, state.items.length - budget))
  if (state.focusIndex < start) start = state.focusIndex
  if (state.focusIndex >= start + budget) start = state.focusIndex - budget + 1
  const end = Math.min(state.items.length, start + budget)
  const list: string[] = []
  let category: string | undefined
  for (let index = start; index < end; index++) {
    const item = state.items[index]!
    const source = item.badge === 'official' ? 'Official' : 'Custom'
    if (source !== category) {
      if (category) list.push('')
      list.push(theme.accent.paint(`  ${source}`))
      category = source
    }
    const child = Boolean(item.group && item.expanded === undefined)
    // Preserve package context when its parent has scrolled out of the window.
    if (index === start && child) list.push(muted(clip(`    ${item.group}/`, listWidth)))
    const groupOpen = item.expanded !== undefined && (item.expanded || Boolean(state.query.trim()))
    const prefix = item.expanded !== undefined ? (groupOpen ? '▾ ' : '▸ ') : child ? '    ' : ''
    // Official source is already shown by the section heading; children inherit parent badges.
    const badge = item.badge && item.badge !== 'official' && !child ? ` [${item.badge}]` : ''
    const label = clip(prefix + item.label, listWidth - 2 - badge.length)
    let text = styledLineToAnsi(buildSelectorRow({ ...item, label, detail: undefined }, {
      highlighted: index === state.focusIndex, query: state.query,
    }))
    if (badge) text += theme.accent.paint(badge)
    list.push(text)
  }
  if (!state.items.length) list.push(muted(state.query ? '  No matching skills' : `  ${state.emptyMessage ?? 'No skills installed'}`))
  if (start > 0 || end < state.items.length) list.push(muted(`  ${start + 1}–${end} · ↑↓ scroll`))

  const selected = state.items[state.focusIndex]
  const preview = selected?.preview ?? []
  const details: string[] = []
  const append = (text: string, limit: number, paint: (text: string) => string): void => {
    const wrapped = wrapTextWithAnsi(text, detailWidth)
    const shown = wrapped.slice(0, limit)
    if (wrapped.length > limit && shown.length) {
      shown[shown.length - 1] = `${clip(shown[shown.length - 1] ?? '', detailWidth - 2)} …`
    }
    details.push(...shown.map(paint))
  }
  if (selected) {
    append(preview[0] ?? selected.label, 1, theme.brandBold.paint)
    details.push('')
    append(preview[2] ?? 'No description available.', 3, theme.text.paint)
    if (preview[5]) {
      details.push('', muted('Example'))
      append(preview[5], 3, theme.text.paint)
    }
  }
  const body: string[] = []
  if (wide) {
    const height = Math.max(list.length, details.length, Math.min(budget + 2, 8))
    const pad = (values: string[]) => Array.from({ length: height }, (_, index) => line(plain(values[index] ?? '')))
    body.push(...selectorColumns(pad(list), pad(details), listWidth, '  │  ').map(styledLineToAnsi))
  } else {
    body.push(...list, ...(details.length ? ['', ...details.map(text => `  ${text}`)] : []))
  }
  const focused = active && state.listFocused !== true
  const search = styledLineToAnsi(selectorSearch(state.query, width, focused, 'Search skills…'))
  const hints = [
    { keys: ['up', 'down'], action: 'move' },
    ...(selected?.expanded !== undefined && !state.query ? [{ keys: 'enter', action: selected.expanded ? 'collapse' : 'expand' }] : []),
    { keys: 'type', action: 'search' },
    { keys: 'escape', action: 'close' },
    { keys: '/skill list', action: 'manage' },
  ]
  return [
    styledLineToAnsi(selectorTitle('Skills', `${state.items.length}`, width)),
    search,
    '',
    ...body,
    '',
    ...selectorHints(hints, width).map(styledLineToAnsi),
  ].map(text => wrapTextWithAnsi(text, width)[0] ?? '')
}
