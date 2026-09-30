import { wrapTextWithAnsi } from '../render/wrap.js'
import { PREVIEW_ALERT_PREFIX, PREVIEW_SECTION_PREFIX, type SelectorState } from './selector.js'

/**
 * One split for every list-with-details window (sessions, shares, tasks,
 * skills): the list is what the user scans and acts on, so it gets the larger
 * share; the details pane gets about a third, capped at a comfortable reading
 * width, and extra columns on wide terminals go back to the list.
 */
export const PANE_FRACTION = 0.38
export const PANE_MIN_WIDTH = 24
export const PANE_MAX_WIDTH = 72
/** Columns the list keeps before a side pane is worth showing. */
export const PANE_MIN_LIST_WIDTH = 46
/** Gap and rail between the list and the pane (`  │ `). */
const PANE_GUTTER = 4

/** Shared by keyboard handling and rendering: content never sets window size. */
export function previewGeometry(columns: number, rows: number) {
  const available = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80) - 1)
  const terminalRows = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))
  const preferred = Math.min(
    available - PANE_MIN_LIST_WIDTH - PANE_GUTTER,
    Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, Math.floor(available * PANE_FRACTION))),
  )
  const sideBySide = preferred >= PANE_MIN_WIDTH
  const height = Math.max(3, Math.min(12, terminalRows - (sideBySide ? 10 : 15)))
  return {
    width: sideBySide ? preferred : available,
    paneWidth: sideBySide ? preferred : 0,
    height,
    listRows: sideBySide ? Math.max(1, height - 2) : 3,
  }
}

/** Browse entries spend two rows, plus a search/action shell. Reserve room
 * for the transcript and composer; keyboard paging uses this exact budget. */
export function selectorPreviewGeometry(state: SelectorState, columns: number, rows: number) {
  const geometry = previewGeometry(columns, rows)
  if (state.presentation !== 'browser') return geometry
  const terminalRows = Number.isFinite(rows) ? Math.floor(rows) : 24
  return { ...geometry, height: Math.max(3, Math.min(geometry.height, terminalRows - (geometry.paneWidth ? 16 : 19))) }
}

export interface PreviewRow {
  text: string
  heading: boolean
  /** The entry reported something wrong; drawn in the alert colour. */
  alert: boolean
}

/** Wrap preview entries to rows, interpreting the entry markers: the first
 *  entry and `# ` labels are headings, `! ` entries are alerts. */
export function previewRows(preview: string[], width: number): PreviewRow[] {
  return preview.flatMap((entry, index) => {
    const heading = index === 0 || entry.startsWith(PREVIEW_SECTION_PREFIX)
    const alert = entry.startsWith(PREVIEW_ALERT_PREFIX)
    const text = heading && index > 0 ? entry.slice(PREVIEW_SECTION_PREFIX.length)
      : alert ? entry.slice(PREVIEW_ALERT_PREFIX.length)
        : entry
    return wrapTextWithAnsi(text, width).map(text => ({ text, heading, alert }))
  })
}

export function previewScrollLimit(preview: string[], width: number, height: number): number {
  return Math.max(0, previewRows(preview, width).length - Math.max(1, height - 1))
}
