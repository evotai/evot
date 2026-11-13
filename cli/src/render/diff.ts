/**
 * Diff rendering — themed structured diff with line numbers and word-level
 * highlighting, layered the way Zed's version-control colors are: the row tint
 * says which side a line is on, a stronger fill marks the changed tokens inside
 * it, and the ink stays bright enough to read on both. Long lines wrap via the
 * shared ANSI-aware primitive so nothing is truncated (the renderer runs with
 * auto-wrap off).
 */

import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { structuredPatch, diffWordsWithSpace } from 'diff'
import { getTheme } from '../ui/theme/index.js'

export interface DiffResult {
  text: string
  linesAdded: number
  linesRemoved: number
}

// Foreground styles — no full-width background bars, so wrapped continuation
// lines stay clean. Resolved per call (never bound at module load) so a theme
// swap or a late chalk.level change is picked up, matching the theme contract.
const style = {
  added: (s: string) => chalk.hex(getTheme().diffAddedFg)(s),
  removed: (s: string) => chalk.hex(getTheme().diffRemovedFg)(s),
  context: (s: string) => chalk.hex(getTheme().diffContextFg)(s),
  header: (s: string) => chalk.hex(getTheme().diffHeaderFg)(s),
  gutter: (s: string) => chalk.hex(getTheme().diffGutterFg)(s),
  ellipsis: (s: string) => chalk.hex(getTheme().diffGutterFg)(s),
  /**
   * Changed tokens inside a single-line edit. Zed gives these their own fill
   * (`version_control_word_added/deleted`); we do the same instead of inverse
   * video (SGR 7), which flips to the terminal's own palette and tears a bright
   * hole through the card fill.
   */
  addedWord: (s: string) => chalk.bgHex(getTheme().diffAddedWordBg).hex(getTheme().diffAddedFg)(s),
  removedWord: (s: string) => chalk.bgHex(getTheme().diffRemovedWordBg).hex(getTheme().diffRemovedFg)(s),
}

const WORD_DIFF_THRESHOLD = 0.4

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

interface DiffLine {
  type: 'add' | 'remove' | 'context'
  code: string
  lineNum: number
  paired?: DiffLine
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a colored structured diff between old and new text.
 */
export function formatDiff(oldText: string, newText: string, filename = ''): DiffResult {
  const patch = structuredPatch(filename, filename, oldText, newText, '', '', { context: 3 })
  let linesAdded = 0
  let linesRemoved = 0
  const output: string[] = []

  // One gutter width for the whole patch. Sizing it per hunk makes the columns
  // jog where a patch crosses a digit boundary between hunks (`3 ` then `30 `),
  // which reads as a rendering fault rather than as structure.
  const perHunk = patch.hunks.map(hunk => buildDiffLines(hunk.lines, hunk.oldStart, hunk.newStart))
  const numWidth = gutterWidth(perHunk.flat())

  for (let hi = 0; hi < perHunk.length; hi++) {
    if (hi > 0) output.push(style.ellipsis('  …'))
    for (const line of perHunk[hi]!) {
      if (line.type === 'add') linesAdded++
      if (line.type === 'remove') linesRemoved++
      output.push(renderLine(line, numWidth))
    }
  }

  return { text: output.join('\n'), linesAdded, linesRemoved }
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  oldLines: number
  newLines: number
  /** Optional enclosing function signature from the unified-diff header. */
  section?: string
  lines: string[]
}

/** A section heading is metadata about the excerpt, never a source-code row. */
export function formatDiffHunkHeader(hunk: DiffHunk): string {
  return `  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ''}`
}

/** Display partial patches too: streaming previews need not match hunk counts yet. */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  for (const text of diff.split('\n')) {
    const header = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/)
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[3]), oldLines: Number(header[2] ?? 1), newLines: Number(header[4] ?? 1), lines: [] }
      const section = stripAnsi(header[5] ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()
      if (section) current.section = section
      hunks.push(current)
    } else if (text.startsWith('diff ') || text.startsWith('Index:')) {
      current = undefined
    } else if (current && /^[ +\-\\]/.test(text)) {
      current.lines.push(text)
    }
  }
  return hunks
}

export type DiffRowKind = 'add' | 'remove' | 'context' | 'ellipsis' | 'header'

export interface DiffRow {
  /** Foreground-styled row text (gutter + sigil + code). */
  text: string
  kind: DiffRowKind
  /** Separate chrome from code so wrapped continuations never enter the gutter. */
  gutter?: string
  code?: string
}

/**
 * Colorize a unified diff one row at a time. Callers that lay rows out on a
 * filled block use `kind` to give added/removed rows their own fill, the way
 * opencode tints diff rows inside a tool block.
 *
 * `minGutter` floors the line-number column. A patch that grows between frames
 * would otherwise widen its gutter on crossing 9→10→100 lines and re-indent
 * every row already painted, including rows the renderer has left behind in
 * native scrollback. Callers that stream a patch pass a fixed width instead.
 */
export function colorizeUnifiedDiffRows(diff: string, showSigns = true, minGutter = 0): DiffRow[] {
  const hunks = parseDiffHunks(diff)
  const output: DiffRow[] = []
  if (hunks.length === 0) {
    return diff.split('\n').map(text => ({ text: style.context(text), kind: 'context' }))
  }
  // One gutter width for the whole patch — see `formatDiff`. This also makes the
  // width monotonic in the patch as a whole rather than in each hunk, which is
  // what the append-only scrollback contract needs.
  const perHunk = hunks.map(hunk =>
    buildDiffLines(hunk.lines.filter(line => !line.startsWith('\\')), hunk.oldStart, hunk.newStart))
  const numW = gutterWidth(perHunk.flat(), minGutter)

  for (let hi = 0; hi < perHunk.length; hi++) {
    const hunk = hunks[hi]!
    if (hi > 0 && !hunk.section) output.push({ text: style.ellipsis('  …'), kind: 'ellipsis' })
    if (hunk.section) output.push({ text: style.header(formatDiffHunkHeader(hunk)), kind: 'header' })
    for (const line of perHunk[hi]!) {
      output.push({
        text: renderLine(line, numW, showSigns), kind: line.type,
        gutter: style.gutter(`${String(line.lineNum).padStart(numW)} `),
        code: renderLine(line, numW, showSigns, false),
      })
    }
  }
  return output
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function gutterWidth(lines: DiffLine[], minGutter = 0): number {
  const maxNum = Math.max(...lines.map(l => l.lineNum), 0)
  return Math.max(String(maxNum).length, 1, minGutter)
}

/** Parse raw diff lines → structured DiffLines with line numbers + pairing. */
function buildDiffLines(rawLines: string[], startLine: number, newStartLine = startLine): DiffLine[] {
  const parsed = rawLines.map(raw => {
    if (raw.startsWith('+')) return { type: 'add' as const, code: raw.slice(1) }
    if (raw.startsWith('-')) return { type: 'remove' as const, code: raw.slice(1) }
    return { type: 'context' as const, code: raw.startsWith(' ') ? raw.slice(1) : raw }
  })
  const paired = pairChanges(parsed)
  return assignLineNumbers(paired, startLine, newStartLine)
}

/** Pair adjacent remove→add sequences for word-level diff. */
function pairChanges(
  lines: { type: 'add' | 'remove' | 'context'; code: string }[],
): { type: 'add' | 'remove' | 'context'; code: string; pairedCode?: string }[] {
  const out: { type: 'add' | 'remove' | 'context'; code: string; pairedCode?: string }[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.type !== 'remove') { out.push(lines[i]!); i++; continue }

    const removes: typeof lines = []
    while (i < lines.length && lines[i]!.type === 'remove') { removes.push(lines[i]!); i++ }
    const adds: typeof lines = []
    while (i < lines.length && lines[i]!.type === 'add') { adds.push(lines[i]!); i++ }

    const n = Math.min(removes.length, adds.length)
    for (let k = 0; k < n; k++) out.push({ ...removes[k]!, pairedCode: adds[k]!.code })
    for (let k = n; k < removes.length; k++) out.push(removes[k]!)
    for (let k = 0; k < n; k++) out.push({ ...adds[k]!, pairedCode: removes[k]!.code })
    for (let k = n; k < adds.length; k++) out.push(adds[k]!)
  }
  return out
}

/** Assign line numbers and link paired lines. */
function assignLineNumbers(
  lines: { type: 'add' | 'remove' | 'context'; code: string; pairedCode?: string }[],
  startLine: number,
  newStartLine: number,
): DiffLine[] {
  const dls: (DiffLine & { pairedCode?: string })[] = lines.map(l => ({
    type: l.type, code: l.code, lineNum: 0, pairedCode: l.pairedCode,
  }))

  let oldNum = startLine
  let newNum = newStartLine
  for (const dl of dls) {
    if (dl.type === 'context') { dl.lineNum = oldNum; oldNum++; newNum++ }
    else if (dl.type === 'remove') { dl.lineNum = oldNum; oldNum++ }
    else { dl.lineNum = newNum; newNum++ }
  }

  for (const dl of dls) {
    if (dl.pairedCode !== undefined) {
      dl.paired = { type: dl.type === 'remove' ? 'add' : 'remove', code: dl.pairedCode, lineNum: 0 }
    }
  }
  return dls
}

/**
 * Render one diff line: `<num> <sigil> <code>`.
 *
 * Zed's layering: the line number is chrome and stays recessed, the sigil is
 * the one part of the gutter that carries meaning so it takes the row's ink,
 * and the code is the brightest thing on the row. Single-line edits get a
 * stronger fill on the changed tokens. No background bars and no padding, so
 * the shared wrapper can reflow long lines cleanly.
 *
 * Column count is identical in both `showSigns` modes to the character — the
 * gutter width is load-bearing for append-only scrollback (see WRITE_DIFF_GUTTER).
 */
function renderLine(line: DiffLine, numWidth: number, showSigns = true, withGutter = true): string {
  const num = String(line.lineNum).padStart(numWidth)
  const sigil = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
  const gutterStr = withGutter ? style.gutter(`${num} `) : ''
  // Sigil and code share one paint call so the row's text stays contiguous
  // under strip-ansi. Splitting them would wedge escapes between `+` and the
  // code, which breaks substring assertions on the rendered body for no gain.
  const body = showSigns ? `${sigil}${line.code}` : line.code

  if (line.type === 'context') {
    return gutterStr + style.context(body)
  }

  const paint = line.type === 'add' ? style.added : style.removed

  // Word-level diff for single-line edits: fill the changed tokens.
  if (line.paired) {
    const painted = wordDiff(line, showSigns ? sigil : '')
    if (painted !== null) return gutterStr + painted
  }

  return gutterStr + paint(body)
}

/**
 * Word-level diff. Returns the painted line body, or null if too different.
 *
 * `sigil` is painted as the leading run in the row's ink. Changed tokens carry
 * their own fill, so the sigil cannot simply join the first segment — that
 * segment may be a filled one, and the marker would pick up a background it has
 * no business wearing.
 */
function wordDiff(line: DiffLine, sigil: string): string | null {
  if (!line.paired) return null
  const oldText = line.type === 'remove' ? line.code : line.paired.code
  const newText = line.type === 'remove' ? line.paired.code : line.code
  const parts = diffWordsWithSpace(oldText, newText)

  const totalLen = oldText.length + newText.length
  if (totalLen === 0) return null
  const changedLen = parts.filter(p => p.added || p.removed).reduce((s, p) => s + p.value.length, 0)
  if (changedLen / totalLen > WORD_DIFF_THRESHOLD) return null

  const paint = line.type === 'add' ? style.added : style.removed
  const fill = line.type === 'add' ? style.addedWord : style.removedWord
  const segs: string[] = sigil ? [paint(sigil)] : []
  for (const p of parts) {
    if (line.type === 'add') {
      if (p.removed) continue
      segs.push(p.added ? fill(p.value) : paint(p.value))
    } else {
      if (p.added) continue
      segs.push(p.removed ? fill(p.value) : paint(p.value))
    }
  }
  return segs.join('')
}
