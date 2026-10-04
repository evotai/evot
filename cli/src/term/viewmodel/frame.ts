/**
 * The frame drawn around the prompt editor: a rule above, a rule below, and a
 * `❭` caret leading the draft.
 *
 * There are deliberately no vertical rails. A terminal copies mouse selections
 * cell by cell, so a boxed editor puts a `│` at both ends of every line the
 * user drags across. Horizontal rules sit on their own rows and never land in
 * a selection of the text between them; the caret is one familiar character
 * on one row.
 *
 * Colour follows attention. The rules are separators, so they take the subtle
 * border hue and stay out of the way. The caret is where you type, so it
 * carries the brand colour. A mode label on the top rule takes the mode's own
 * hue, so "plan" reads as plan without the whole frame turning yellow.
 *
 * A frame owns one invariant: every rule it emits is exactly `columns` wide,
 * and every content row indents by the same prefix width. Callers get
 * `contentWidth` from the frame rather than deriving it, so content and prefix
 * cannot disagree about the budget.
 */

import stringWidth from 'string-width'
import { getTheme } from '../../render/theme/index.js'
import { atLeastHeight, atLeastWidth, heightTier, widthTier } from './breakpoints.js'
import { line, plain, type StyledLine, type StyledSpan } from './types.js'
import { spansWidth, truncateSpansToWidth, truncateToWidth } from './width.js'

/** The caret that leads the draft. `❭` rather than `>` so copied text does not read as a shell prompt or a quote. */
export const PROMPT_CARET = '❭'
/** `❭ ` — two columns every framed row spends before content. */
const PREFIX_WIDTH = 2

export interface RuleLabels {
  /** Leads the rule: `── ↑ 3 lines ────`. Muted, like the rule itself. */
  lead?: string
  /**
   * Trails the rule in parentheses: `──── (plan) ─`. Carries `hex`, the
   * mode's own colour, so the mode is legible without recolouring the frame.
   */
  mode?: { text: string; hex: string }
}

export interface Frame {
  /** Columns available to content after the prefix. */
  readonly contentWidth: number
  /** False when the terminal is too narrow to spend columns on a caret. */
  readonly framed: boolean
  /**
   * False on very short terminals, where even a horizontal rule is a row the
   * transcript needs more. Callers skip the rule rows entirely.
   */
  readonly ruled: boolean
  /** Top rule, optionally labelled at either end. */
  top(labels?: RuleLabels): StyledLine
  /** Bottom rule, optionally labelled at either end. */
  bottom(labels?: RuleLabels): StyledLine
  /**
   * Lay one content line out behind the prefix. `caret` puts the `❭` there;
   * every other row indents by the same width so text lines up underneath.
   */
  row(styled: StyledLine, caret?: boolean): StyledLine
}

export interface FrameOptions {
  /** Terminal rows. Short terminals drop the rules to keep the transcript. */
  rows?: number
}

export function createFrame(columns: number, options: FrameOptions = {}): Frame {
  const { rows } = options
  // Two chrome rows are affordable down to 10 rows. Below that a framed
  // composer plus footer claims the whole screen, so the rules go.
  const ruled = rows === undefined || atLeastHeight(heightTier(rows), 'sm')
  const framed = ruled && atLeastWidth(widthTier(columns), 'sm')
  const contentWidth = Math.max(1, framed ? columns - PREFIX_WIDTH : columns)

  const rule = (labels: RuleLabels = {}): StyledLine => ruleLine(columns, labels)

  return {
    contentWidth,
    framed,
    ruled,
    top: rule,
    bottom: rule,
    row: (styled, caret = false) => {
      const width = spansWidth(styled.spans)
      const spans = width <= contentWidth
        ? styled.spans
        : truncateSpansToWidth(styled.spans, contentWidth)
      // A row background has to cover the padding too, otherwise the band
      // stops at the end of the text instead of reaching the right edge.
      // Without a background there is nothing to pad for, and trailing blanks
      // would only end up in a mouse selection.
      const padding = Math.max(0, contentWidth - Math.min(width, contentWidth))
      const fill: StyledSpan[] = styled.bg ? [{ text: ' '.repeat(padding), bg: styled.bg }] : []

      if (!framed) {
        if (styled.bg) return { spans: [...spans, ...fill] }
        return spans === styled.spans ? styled : { spans }
      }
      // A blank filler row has nothing to indent. Emitting the prefix anyway
      // would leave two spaces on an otherwise empty row for a selection to pick up.
      // Zero-width is not blank: an empty draft line still carries the cursor
      // marker, and dropping it hides the cursor after Enter.
      if (!caret && !styled.bg && styled.spans.every(span => span.text === '')) return line(plain(''))
      // The prefix carries the row background so a selected row reads as one
      // continuous band from the left edge.
      const prefix: StyledSpan = caret
        ? { text: `${PROMPT_CARET} `, hex: getTheme().brandHex, ...(styled.bg ? { bg: styled.bg } : {}) }
        : styled.bg ? { text: ' '.repeat(PREFIX_WIDTH), bg: styled.bg } : plain(' '.repeat(PREFIX_WIDTH))
      return line(prefix, ...spans, ...fill)
    },
  }
}

/**
 * `── lead ───────── (mode) ─` — a full-width rule. The lead label shares the
 * rule's muted hue; the mode label keeps its own. When both cannot fit, the
 * mode label wins: it is state, the lead is a hint.
 */
function ruleLine(columns: number, labels: RuleLabels): StyledLine {
  const borderHex = getTheme().subtleHex
  const dash = (n: number): StyledSpan => ({ text: '─'.repeat(Math.max(0, n)), hex: borderHex })

  const trail = labels.mode ? ` (${labels.mode.text}) ` : ''
  const trailWidth = stringWidth(trail)
  // One dash on the right so the label never touches the edge.
  const trailBudget = trailWidth ? trailWidth + 1 : 0

  if (!labels.lead) {
    if (!labels.mode) return line(dash(columns))
    if (trailBudget > columns) return line({ text: truncateToWidth(trail.trimStart(), columns), hex: labels.mode.hex })
    return line(dash(columns - trailBudget), { text: trail, hex: labels.mode.hex }, dash(1))
  }

  const lead = `── ${labels.lead} `
  const leadRoom = columns - trailBudget
  if (leadRoom < stringWidth('── … ')) {
    // No room for the lead at all: draw as if it were absent.
    return ruleLine(columns, { mode: labels.mode })
  }
  const leadText = truncateToWidth(lead, leadRoom)
  const middle = columns - stringWidth(leadText) - trailBudget
  if (!labels.mode) return line({ text: leadText, hex: borderHex }, dash(middle))
  return line({ text: leadText, hex: borderHex }, dash(middle), { text: trail, hex: labels.mode.hex }, dash(1))
}
