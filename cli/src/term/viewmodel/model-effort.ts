/**
 * The model picker's effort column: a per-row tier gauge adjusted with ←/→.
 *
 * Geometry is planned once for the whole visible page rather than per row, so
 * every gauge starts in the same column, every affordance lands in the same
 * column, and every tier label lines up under the one above it. A row whose
 * ladder is shorter than the widest one pads between its last cell and the right
 * affordance, which holds those columns steady while still showing honestly that
 * the model offers fewer tiers.
 *
 * The gauge cell must be Neutral width, not Ambiguous: a cell that draws wider
 * than the column it was measured for fuses into its neighbour and destroys the
 * ladder this module exists to draw. `←→` stay Ambiguous, matching the spelling
 * `key-hints` already ships, since they sit at a column edge where an extra
 * column costs nothing.
 */

import { getTheme } from '../../ui/theme/index.js'
import type { SelectorEffort, SelectorItem } from '../../ui/selector.js'
import type { StyledSpan } from './types.js'

/**
 * Gauge cell, and the ←/→ affordances on the focused row.
 *
 * `◼` (U+25FC) rather than the obvious `■` (U+25A0), because `■` is East-Asian
 * **Ambiguous**: a CJK-configured terminal draws it two columns wide while
 * `visibleWidth` counts it as one. Each cell then overruns its own column and
 * butts against its neighbour, fusing the ladder into one solid bar — measured
 * in a real CJK terminal, where five cells rendered as a single unbroken run.
 * `◼` is Neutral width (one column in every locale), so cells stay discrete with
 * the hairline seam that makes the ladder readable. Devin uses the same glyph.
 *
 * Filled and empty are the *same* glyph, separated only by colour — measured
 * from Devin's rendering, where an unfilled cell is a solid `#444444` square,
 * not a hollow outline. One glyph keeps the pitch even; a hollow `□` would both
 * break that rhythm and read as a checkbox rather than an empty slot.
 */
export const GAUGE_CELL = '◼'
const ARROW_LEFT = '←'
const ARROW_RIGHT = '→'

/** Columns between the row text and the gauge, between an affordance and the
 *  gauge it moves, and between the gauge and its tier label. */
const TEXT_GAP = 2
const ARROW_GAP = 1
const LABEL_GAP = 2

/** Display names for wire tier names. Unknown tiers are title-cased as-is, so a
 *  server that adds a tier still renders instead of showing a blank cell. */
const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? (level ? level[0]!.toUpperCase() + level.slice(1) : '')
}

/** Ramp hue for cell `index` of a `levels`-tier ladder, sampled by relative
 *  position so a short ladder's top cell is as warm as a long one's. */
export function effortCellHex(index: number, levels: number): string {
  const { effortRampHex, brandHex } = getTheme()
  if (effortRampHex.length === 0) return brandHex
  const span = Math.max(1, levels - 1)
  const at = Math.round((Math.min(Math.max(index, 0), span) / span) * (effortRampHex.length - 1))
  return effortRampHex[at] ?? brandHex
}

/** Hue for the selected tier: the colour of the highest lit cell. */
export function effortLevelHex(effort: SelectorEffort): string {
  return effortCellHex(effort.index, effort.levels.length)
}

/** Planned column geometry shared by every row on the page. */
export interface EffortLayout {
  /** Column where the gauge block starts, measured from the line start. */
  column: number
  /** Cells reserved for the gauge: the longest ladder on the page. */
  gaugeWidth: number
  /** Cells reserved for the tier label: the widest label on the page. */
  labelWidth: number
}

/** Width of one effort cell: `←` + gap + gauge + gap + `→` + gap + label. */
function cellWidth(gaugeWidth: number, labelWidth: number): number {
  return 1 + ARROW_GAP + gaugeWidth + ARROW_GAP + 1 + LABEL_GAP + labelWidth
}

/**
 * Plan the effort column for a page of rows, or return null to omit it.
 *
 * Omitted when no row has a ladder, or when the column would not fit the
 * terminal. Dropping the whole column is the graceful degradation: a truncated
 * gauge would read as a different tier than the one selected.
 */
export function planEffortLayout(
  rows: { item: SelectorItem; width: number }[],
  available: number,
): EffortLayout | null {
  const ladders = rows.flatMap(row => row.item.effort ? [row.item.effort] : [])
  if (ladders.length === 0) return null

  const gaugeWidth = Math.max(...ladders.map(effort => effort.levels.length))
  const labelWidth = Math.max(...ladders.flatMap(effort =>
    effort.levels.map(level => effortLabel(level).length)))
  const column = Math.max(...rows.map(row => row.width)) + TEXT_GAP
  if (column + cellWidth(gaugeWidth, labelWidth) > available) return null
  return { column, gaugeWidth, labelWidth }
}

export interface EffortCellOptions {
  /** The row owning keyboard focus: only it shows the ←/→ affordances. */
  focused: boolean
  /** Whether the selector itself owns input; a preview shows no affordances. */
  active: boolean
  /** Painted band on the focused row, so the cell joins the selection. */
  bg?: string
}

/**
 * Render one row's effort cell, padded so it starts at `layout.column`.
 *
 * `rowWidth` is the row's already-built visible width; the caller has it from
 * layout planning, so the cell is positioned without re-measuring.
 */
export function buildEffortCell(
  effort: SelectorEffort,
  layout: EffortLayout,
  rowWidth: number,
  options: EffortCellOptions,
): StyledSpan[] {
  const { focused, active, bg } = options
  const { brandHex, mutedHex, subtleHex, selectionMutedHex } = getTheme()
  const band = bg ? { bg } : {}
  // On the focused band the ordinary dim gray goes too dark to read, so the
  // selection's own muted tone stands in for it.
  const quiet = (text: string): StyledSpan =>
    bg ? { text, hex: selectionMutedHex, ...band } : { text, dim: true }
  const loud = (text: string, hex: string): StyledSpan => ({ text, hex, bold: focused, ...band })

  const level = effort.levels[effort.index]
  if (level === undefined) return []

  const pad = Math.max(1, layout.column - rowWidth)
  // Affordances appear only where they would do something: at a ladder end the
  // cell shows a blank so the gauge never shifts column as focus moves.
  const showArrows = focused && active
  const canLeft = showArrows && effort.index > 0
  const canRight = showArrows && effort.index < effort.levels.length - 1

  const empty = GAUGE_CELL.repeat(Math.max(0, effort.levels.length - effort.index - 1))
  // Focused: each lit cell takes its ramp stop. Idle rows stay grey.
  const lit: StyledSpan[] = focused
    ? Array.from({ length: effort.index + 1 }, (_, at) => ({
      text: GAUGE_CELL, hex: effortCellHex(at, effort.levels.length), bold: true, ...band,
    }))
    : [{ text: GAUGE_CELL.repeat(effort.index + 1), hex: mutedHex }]
  const levelHex = effortLevelHex(effort)
  // Short ladders pad before the right affordance, so both arrows sit at a fixed
  // column on every row (measured from Devin: a 3-cell ladder's `→` lands in the
  // same column as a 6-cell one's).
  const slack = ' '.repeat(Math.max(0, layout.gaugeWidth - effort.levels.length))
  const label = effortLabel(level)

  return [
    quiet(' '.repeat(pad)),
    canLeft ? loud(ARROW_LEFT, brandHex) : quiet(' '),
    quiet(' '.repeat(ARROW_GAP)),
    ...lit,
    { text: empty, hex: subtleHex, ...band },
    quiet(slack),
    quiet(' '.repeat(ARROW_GAP)),
    canRight ? loud(ARROW_RIGHT, brandHex) : quiet(' '),
    quiet(' '.repeat(LABEL_GAP)),
    focused ? loud(label, levelHex) : quiet(label),
  ]
}
