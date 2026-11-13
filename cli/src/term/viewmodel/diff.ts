/** Responsive patch layout shared by live and completed edit cards. */
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import { colorizeUnifiedDiffRows, formatDiffHunkHeader, parseDiffHunks } from '../../render/diff.js'
import { wrapTextWithAnsi } from '../../ui/wrap.js'
import { getTheme } from '../../ui/theme/index.js'
import { line, plain, type StyledLine, type StyledSpan } from './types.js'

/** Match opencode's inline edit breakpoint; narrower panes retain unified diff. */
export const SPLIT_DIFF_MIN_COLUMNS = 121

type Cell = { number: number; code: string; kind: 'add' | 'remove' | 'context' }

/**
 * Rule between hunks, standing in for Zed's excerpt divider.
 *
 * A bare `  …` reads as content that happens to be dim; a rule reads as
 * structure, which is what a skipped region is. Falls back to the ellipsis when
 * the width is unknown, since a rule needs one.
 */
function hunkSeparator(columns?: number): StyledLine {
  const theme = getTheme()
  if (!columns || columns < 8) return line({ text: '  …', hex: theme.diffGutterFg })
  // Keep the two-column indent the rest of the diff uses, so the rule reads as
  // part of the body rather than as a card divider.
  return line({ text: `  ${'┄'.repeat(columns - 2)}`, hex: theme.diffGutterFg })
}

/** Every hunk is pure additions (new file) or pure removals (deleted file). */
export function isOneSided(hunks: ReturnType<typeof parseDiffHunks>): boolean {
  return hunks.length > 0
    && (hunks.every(hunk => hunk.oldLines === 0) || hunks.every(hunk => hunk.newLines === 0))
}

/**
 * `minGutter` floors the line-number column so a patch that grows between
 * frames never re-indents rows it has already painted. See
 * [`colorizeUnifiedDiffRows`].
 */
export function buildDiffLines(patch: string, columns?: number, minGutter = 0): StyledLine[] {
  const hunks = parseDiffHunks(patch)
  // A side-by-side view needs two sides. A new file (or a deleted one) has
  // only one: splitting it leaves half the width blank and squeezes the code
  // into the other half, so those read as a single column at any width.
  if (!columns || columns < SPLIT_DIFF_MIN_COLUMNS || isOneSided(hunks)) {
    const theme = getTheme()
    return colorizeUnifiedDiffRows(patch, false, minGutter).flatMap(row => {
      if (row.kind === 'ellipsis') return [hunkSeparator(columns)]
      const width = Math.max(1, columns ?? 10000)
      const gutterWidth = stringWidth(row.gutter ?? '')
      const separate = row.code !== undefined && gutterWidth < width
      const fragments = wrapTextWithAnsi(separate ? row.code! : row.text, separate ? width - gutterWidth : width)
      return fragments.map((text, index) => ({
        ...line(plain((separate ? index === 0 ? row.gutter! : ' '.repeat(gutterWidth) : '') + text)),
        bg: row.kind === 'header' ? theme.diffHeaderBg
          : row.kind === 'add' ? theme.diffAddedBg : row.kind === 'remove' ? theme.diffRemovedBg : undefined,
      }))
    })
  }
  if (!hunks.length) return wrapTextWithAnsi(patch, columns).map(text => line(plain(text)))
  const leftWidth = Math.floor((columns - 3) / 2)
  const rightWidth = columns - 3 - leftWidth
  const result: StyledLine[] = []
  const cell = (value: Cell | undefined, width: number, gutter: number): StyledLine[] => {
    if (!value) return [line(plain(' '.repeat(width)))]
    const theme = getTheme()
    const prefix = `${String(value.number).padStart(gutter)} `
    const code = stripAnsi(value.code).replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    const fragments = wrapTextWithAnsi(code, Math.max(1, width - prefix.length))
    // Same layering as the unified renderer: recessed line number, row ink on
    // the code, row tint behind changed sides only.
    const fg = value.kind === 'add'
      ? theme.diffAddedFg
      : value.kind === 'remove' ? theme.diffRemovedFg : theme.diffContextFg
    const bg = value.kind === 'add'
      ? theme.diffAddedBg
      : value.kind === 'remove' ? theme.diffRemovedBg : undefined
    // The fill rides on the spans, not the line: `append` merges a left and a
    // right cell into one row, and each side carries its own fill.
    return (fragments.length ? fragments : ['']).map((text, index) => {
      const lead = index === 0 ? prefix : ' '.repeat(prefix.length)
      const pad = ' '.repeat(Math.max(0, width - stringWidth(lead + text)))
      const spans: StyledSpan[] = [
        { text: lead, hex: theme.diffGutterFg, bg },
        { text: text + pad, hex: fg, bg },
      ]
      return { spans }
    })
  }
  // One gutter width for the whole patch, so the columns do not jog where a
  // patch crosses a digit boundary between hunks. Matches the unified renderer.
  const gutter = hunks.reduce(
    (width, hunk) => Math.max(width, String(Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)).length),
    minGutter,
  )
  for (const hunk of hunks) {
    // The blue metadata row already separates excerpts, like GitHub Web.
    if (result.length && !hunk.section) result.push(hunkSeparator(columns))
    if (hunk.section) {
      const theme = getTheme()
      result.push(...wrapTextWithAnsi(formatDiffHunkHeader(hunk), columns)
        .map(text => ({ ...line({ text, hex: theme.diffHeaderFg }), bg: theme.diffHeaderBg })))
    }
    let old = hunk.oldStart
    let next = hunk.newStart
    const append = (left?: Cell, right?: Cell) => {
      const a = cell(left, leftWidth, gutter)
      const b = cell(right, rightWidth, gutter)
      // Pane divider shares the gutter hue, so every piece of diff chrome
      // (line numbers, hunk rule, divider) recedes by the same amount.
      const divider: StyledSpan = { text: ' │ ', hex: getTheme().diffGutterFg }
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        result.push(line(...(a[index]?.spans ?? [plain(' '.repeat(leftWidth))]), divider, ...(b[index]?.spans ?? [plain(' '.repeat(rightWidth))])))
      }
    }
    for (let i = 0; i < hunk.lines.length;) {
      const text = hunk.lines[i]!
      if (text.startsWith('\\')) { i++; continue }
      if (text.startsWith(' ')) {
        append({ number: old++, code: text.slice(1), kind: 'context' }, { number: next++, code: text.slice(1), kind: 'context' })
        i++
        continue
      }
      const removed: Cell[] = []
      const added: Cell[] = []
      while (i < hunk.lines.length && !hunk.lines[i]!.startsWith(' ')) {
        const change = hunk.lines[i++]!
        if (change.startsWith('-')) removed.push({ number: old++, code: change.slice(1), kind: 'remove' })
        else if (change.startsWith('+')) added.push({ number: next++, code: change.slice(1), kind: 'add' })
      }
      for (let k = 0; k < Math.max(removed.length, added.length); k++) append(removed[k], added[k])
    }
  }
  return result
}
