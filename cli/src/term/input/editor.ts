import { complete, getGhostHint, type GhostHintContext } from '../../commands/completion.js'
import { COMMANDS, HIDDEN_COMMANDS } from '../../commands/index.js'
import { needsContinuation } from './continuation.js'
import {
  boundaryAtDisplayWidth,
  displayWidthBefore,
  nextSegmentBoundary,
  previousSegmentBoundary,
  segmentEditorText,
  snapToSegmentBoundary,
  wrapEditorText,
} from './grapheme.js'
import { findWordBackward, findWordForward } from './word-navigation.js'

export interface CompletionCandidate {
  label: string
  value: string
  description?: string
}

export interface CompletionMenu {
  items: CompletionCandidate[]
  selectedIndex: number
  replaceStart: number
  replaceEnd: number
  /** Context line under the candidates; absent on plain command completion. */
  note?: string
}

export interface EditorState {
  lines: string[]
  cursorLine: number
  cursorCol: number
  /** Display column retained while moving vertically across unequal rows. */
  preferredVisualCol?: number
  ghostHint: string
  completion: CompletionMenu | null
}

/** Check whether Enter should continue the draft instead of submitting it. */
export function editorNeedsContinuation(state: EditorState): boolean {
  const line = state.lines[state.cursorLine] ?? ''
  return line[state.cursorCol - 1] === '\\' || needsContinuation(getEditorText(state))
}

export interface HistoryState {
  entries: string[]
  index: number
  savedInput: string
}

export interface CompletionApplyResult {
  applied: boolean
  state: EditorState
}

export function createEditorState(): EditorState {
  return {
    lines: [''],
    cursorLine: 0,
    cursorCol: 0,
    ghostHint: '',
    completion: null,
  }
}

export function getEditorText(state: EditorState): string {
  return state.lines.join('\n')
}

/** UTF-16 offset in the complete draft, snapped to a user-perceived boundary. */
export function editorCursorOffset(state: EditorState): number {
  const line = state.lines[state.cursorLine] ?? ''
  const col = snapToSegmentBoundary(line, state.cursorCol)
  return state.lines.slice(0, state.cursorLine).reduce((offset, text) => offset + text.length + 1, 0) + col
}

/** Replace the entire suffix without changing anything before the cursor. */
export function replaceAfterCursor(state: EditorState, text: string): EditorState {
  const line = state.lines[state.cursorLine] ?? ''
  const col = snapToSegmentBoundary(line, state.cursorCol)
  const lines = [...state.lines.slice(0, state.cursorLine), line.slice(0, col)]
  return insertText({ ...state, lines, cursorCol: col }, text)
}

export function isEditorEmpty(state: EditorState): boolean {
  return state.lines.length === 1 && state.lines[0] === ''
}

export function clearEditor(state: EditorState): EditorState {
  return {
    ...state,
    lines: [''],
    cursorLine: 0,
    cursorCol: 0,
    preferredVisualCol: undefined,
    ghostHint: '',
    completion: null,
  }
}

export function insertText(state: EditorState, text: string): EditorState {
  const insertedLines = text.split('\n')
  const newLines = [...state.lines]
  const currentLine = newLines[state.cursorLine]!
  const before = currentLine.slice(0, state.cursorCol)
  const after = currentLine.slice(state.cursorCol)

  if (insertedLines.length === 1) {
    newLines[state.cursorLine] = before + insertedLines[0] + after
    return withCompletionsCleared({
      ...state,
      lines: newLines,
      cursorCol: state.cursorCol + insertedLines[0]!.length,
    })
  }

  const first = before + insertedLines[0]!
  const last = insertedLines[insertedLines.length - 1]! + after
  const middle = insertedLines.slice(1, -1)
  newLines.splice(state.cursorLine, 1, first, ...middle, last)
  return withCompletionsCleared({
    ...state,
    lines: newLines,
    cursorLine: state.cursorLine + insertedLines.length - 1,
    cursorCol: insertedLines[insertedLines.length - 1]!.length,
  })
}

export function backspace(state: EditorState): EditorState {
  if (state.cursorCol > 0) {
    const newLines = [...state.lines]
    const currentLine = newLines[state.cursorLine]!
    const cursorCol = snapToSegmentBoundary(currentLine, state.cursorCol)
    const previousCol = previousSegmentBoundary(currentLine, cursorCol)
    newLines[state.cursorLine] = currentLine.slice(0, previousCol) + currentLine.slice(cursorCol)
    return withCompletionsCleared({
      ...state,
      lines: newLines,
      cursorCol: previousCol,
    })
  }

  if (state.cursorLine === 0) return state

  const newLines = [...state.lines]
  const prevLine = newLines[state.cursorLine - 1]!
  const currentLine = newLines[state.cursorLine]!
  newLines.splice(state.cursorLine - 1, 2, prevLine + currentLine)
  return withCompletionsCleared({
    ...state,
    lines: newLines,
    cursorLine: state.cursorLine - 1,
    cursorCol: prevLine.length,
  })
}

export function moveLeft(state: EditorState): EditorState {
  if (state.cursorCol > 0) {
    const line = state.lines[state.cursorLine]!
    return withoutGhost({ ...state, cursorCol: previousSegmentBoundary(line, state.cursorCol) })
  }
  if (state.cursorLine > 0) {
    return withoutGhost({
      ...state,
      cursorLine: state.cursorLine - 1,
      cursorCol: state.lines[state.cursorLine - 1]!.length,
    })
  }
  return state
}

export function moveRight(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  if (state.cursorCol < line.length) {
    return withoutGhost({ ...state, cursorCol: nextSegmentBoundary(line, state.cursorCol) })
  }
  if (state.cursorLine < state.lines.length - 1) {
    return withoutGhost({ ...state, cursorLine: state.cursorLine + 1, cursorCol: 0 })
  }
  return state
}

/** Alt/Ctrl+Left — word-aware left, crossing line boundaries at start-of-line. */
export function moveWordLeft(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  const cursorCol = snapToSegmentBoundary(line, state.cursorCol)
  if (cursorCol > 0) {
    return withoutGhost({ ...state, cursorCol: findWordBackward(line, cursorCol) })
  }
  if (state.cursorLine > 0) {
    const prevLine = state.lines[state.cursorLine - 1]!
    return withoutGhost({
      ...state,
      cursorLine: state.cursorLine - 1,
      cursorCol: prevLine.length,
    })
  }
  return state
}

/** Alt/Ctrl+Right — word-aware right, crossing line boundaries at end-of-line. */
export function moveWordRight(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  const cursorCol = snapToSegmentBoundary(line, state.cursorCol)
  if (cursorCol < line.length) {
    return withoutGhost({ ...state, cursorCol: findWordForward(line, cursorCol) })
  }
  if (state.cursorLine < state.lines.length - 1) {
    return withoutGhost({ ...state, cursorLine: state.cursorLine + 1, cursorCol: 0 })
  }
  return state
}

export function moveHome(state: EditorState): EditorState {
  return withoutGhost({ ...state, cursorCol: 0 })
}

export function moveEnd(state: EditorState): EditorState {
  return withoutGhost({ ...state, cursorCol: state.lines[state.cursorLine]!.length })
}

export function applyCompletion(state: EditorState): CompletionApplyResult {
  if (state.completion) return { state: acceptCompletion(state), applied: true }

  const currentLine = state.lines[state.cursorLine]!
  const result = complete(currentLine, state.cursorCol)
  if (!result) return { state, applied: false }

  const before = currentLine.slice(0, result.wordStart)
  const suffix = currentLine.slice(result.wordEnd ?? state.cursorCol)
  const after = result.replacement.endsWith('/') && suffix.startsWith('/') ? suffix.slice(1) : suffix
  const newLines = [...state.lines]
  newLines[state.cursorLine] = before + result.replacement + after
  const cursorCol = before.length + result.replacement.length
  const items = result.candidates.map(completionCandidate)

  return {
    state: {
      ...state,
      lines: newLines,
      cursorCol,
      preferredVisualCol: undefined,
      ghostHint: '',
      completion: items.length > 1
        ? { items, selectedIndex: 0, replaceStart: result.wordStart, replaceEnd: cursorCol }
        : null,
    },
    applied: true,
  }
}

export function showCompletions(
  state: EditorState,
  items: CompletionCandidate[],
  replaceStart: number,
  replaceEnd = state.cursorCol,
  note?: string,
): EditorState {
  return {
    ...state,
    ghostHint: '',
    completion: items.length > 0 || note
      ? { items, selectedIndex: 0, replaceStart, replaceEnd, ...(note ? { note } : {}) }
      : null,
  }
}

export function moveCompletion(state: EditorState, delta: number): EditorState {
  const menu = state.completion
  if (!menu || menu.items.length === 0) return state
  const selectedIndex = (menu.selectedIndex + delta + menu.items.length) % menu.items.length
  return { ...state, completion: { ...menu, selectedIndex } }
}

export function acceptCompletion(state: EditorState): EditorState {
  const menu = state.completion
  const item = menu?.items[menu.selectedIndex]
  if (!menu || !item) return state
  const currentLine = state.lines[state.cursorLine]!
  const newLines = [...state.lines]
  const suffix = currentLine.slice(menu.replaceEnd)
  const after = item.value.endsWith('/') && suffix.startsWith('/') ? suffix.slice(1) : suffix
  newLines[state.cursorLine] = currentLine.slice(0, menu.replaceStart) + item.value + after
  return {
    ...state,
    lines: newLines,
    cursorCol: menu.replaceStart + item.value.length,
    preferredVisualCol: undefined,
    ghostHint: '',
    completion: null,
  }
}

export function closeCompletion(state: EditorState): EditorState {
  return state.completion ? { ...state, completion: null } : state
}

function completionCandidate(value: string): CompletionCandidate {
  const command = [...COMMANDS, ...HIDDEN_COMMANDS].find(
    item => item.name === value || item.aliases?.includes(value),
  )
  return {
    label: value,
    value: command ? `${value} ` : value,
    description: command?.description,
  }
}

/**
 * Session facts the ghost hint depends on. The editor is a pure state
 * machine fed by keystrokes; the REPL sets this when the session or its fork
 * ancestry changes so the next refresh picks it up without threading a
 * context through every mutator.
 */
let ghostHintContext: GhostHintContext = { forked: false }

export function setGhostHintContext(context: GhostHintContext): void {
  ghostHintContext = context
}

export function refreshGhostHint(state: EditorState): EditorState {
  const currentLine = state.lines[state.cursorLine]!
  return {
    ...state,
    ghostHint: getGhostHint(currentLine, state.cursorCol, ghostHintContext) ?? '',
  }
}

export function createHistoryState(entries: string[]): HistoryState {
  return {
    entries,
    index: entries.length,
    savedInput: '',
  }
}

export function pushHistory(state: HistoryState, entry: string): HistoryState {
  const text = entry.trim()
  const entries = !text || state.entries.at(-1) === text ? state.entries : [...state.entries, text]
  return {
    entries,
    index: entries.length,
    savedInput: '',
  }
}

export function historyPrev(history: HistoryState, editor: EditorState): { history: HistoryState; editor: EditorState; changed: boolean } {
  if (history.index <= 0) return { history, editor, changed: false }

  const savedInput = history.index === history.entries.length ? getEditorText(editor) : history.savedInput
  const index = history.index - 1
  return {
    history: { ...history, index, savedInput },
    editor: editorFromText(editor, history.entries[index]!),
    changed: true,
  }
}

export function historyNext(history: HistoryState, editor: EditorState): { history: HistoryState; editor: EditorState; changed: boolean } {
  if (history.index >= history.entries.length) return { history, editor, changed: false }

  const index = history.index + 1
  const text = index === history.entries.length ? history.savedInput : history.entries[index]!
  return {
    history: { ...history, index },
    editor: editorFromText(editor, text),
    changed: true,
  }
}


// ---------------------------------------------------------------------------
// Ctrl+U — clear line before cursor
// ---------------------------------------------------------------------------

export function clearLineBefore(state: EditorState): EditorState {
  const newLines = [...state.lines]
  newLines[state.cursorLine] = newLines[state.cursorLine]!.slice(state.cursorCol)
  return withCompletionsCleared({ ...state, lines: newLines, cursorCol: 0 })
}

// ---------------------------------------------------------------------------
// Ctrl+K — clear line after cursor
// ---------------------------------------------------------------------------

export function clearLineAfter(state: EditorState): EditorState {
  const newLines = [...state.lines]
  newLines[state.cursorLine] = newLines[state.cursorLine]!.slice(0, state.cursorCol)
  return withCompletionsCleared({ ...state, lines: newLines })
}

// ---------------------------------------------------------------------------
// Ctrl+D — delete char at cursor (or signal exit if empty)
// ---------------------------------------------------------------------------

export function deleteForward(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  if (state.cursorCol < line.length) {
    const cursorCol = snapToSegmentBoundary(line, state.cursorCol)
    const nextCol = nextSegmentBoundary(line, cursorCol)
    const newLines = [...state.lines]
    newLines[state.cursorLine] = line.slice(0, cursorCol) + line.slice(nextCol)
    return withCompletionsCleared({ ...state, lines: newLines, cursorCol })
  }
  // Join with next line
  if (state.cursorLine < state.lines.length - 1) {
    const newLines = [...state.lines]
    newLines[state.cursorLine] = newLines[state.cursorLine]! + newLines[state.cursorLine + 1]!
    newLines.splice(state.cursorLine + 1, 1)
    return withCompletionsCleared({ ...state, lines: newLines })
  }
  return state
}

// ---------------------------------------------------------------------------
// Ctrl+W / Alt+Backspace — delete word before cursor
// ---------------------------------------------------------------------------

export function deleteWordBefore(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  const cursorCol = snapToSegmentBoundary(line, state.cursorCol)
  const segments = segmentEditorText(line).filter(segment => segment.end <= cursorCol)
  let segmentIndex = segments.length - 1

  // Delete trailing whitespace, then the preceding run of non-whitespace
  // segments. Paste/image references are one segment even though their display
  // labels contain spaces, so Ctrl+W can never leave a partial reference.
  while (segmentIndex >= 0 && /^\s+$/u.test(segments[segmentIndex]!.text)) segmentIndex--
  while (segmentIndex >= 0 && !/^\s+$/u.test(segments[segmentIndex]!.text)) segmentIndex--

  const deleteStart = segments[segmentIndex + 1]?.start ?? cursorCol
  if (deleteStart === cursorCol) {
    // At start of line: join with previous line (same as backspace).
    if (state.cursorLine === 0) return state
    return backspace(state)
  }
  const newLines = [...state.lines]
  newLines[state.cursorLine] = line.slice(0, deleteStart) + line.slice(cursorCol)
  return withCompletionsCleared({ ...state, lines: newLines, cursorCol: deleteStart })
}

// ---------------------------------------------------------------------------
// Alt+D — delete word after cursor
// ---------------------------------------------------------------------------

export function deleteWordForward(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  const cursorCol = snapToSegmentBoundary(line, state.cursorCol)
  const segments = segmentEditorText(line).filter(segment => segment.start >= cursorCol)
  let segmentIndex = 0

  // Delete leading whitespace, then the following run of non-whitespace
  // segments. Paste/image references stay atomic.
  while (segmentIndex < segments.length && /^\s+$/u.test(segments[segmentIndex]!.text)) segmentIndex++
  while (segmentIndex < segments.length && !/^\s+$/u.test(segments[segmentIndex]!.text)) segmentIndex++

  const deleteEnd = segmentIndex > 0 ? segments[segmentIndex - 1]!.end : cursorCol
  if (deleteEnd === cursorCol) return deleteForward(state)
  const newLines = [...state.lines]
  newLines[state.cursorLine] = line.slice(0, cursorCol) + line.slice(deleteEnd)
  return withCompletionsCleared({ ...state, lines: newLines, cursorCol })
}

// ---------------------------------------------------------------------------
// Insert newline (Alt+Enter / continuation)
// ---------------------------------------------------------------------------

export function insertNewline(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  const newLines = [...state.lines]
  newLines.splice(state.cursorLine, 1, line.slice(0, state.cursorCol), line.slice(state.cursorCol))
  return withCompletionsCleared({
    ...state,
    lines: newLines,
    cursorLine: state.cursorLine + 1,
    cursorCol: 0,
  })
}

/** `\\` before the cursor is a newline gesture, not part of the prompt. */
export function insertContinuationNewline(state: EditorState): EditorState {
  const line = state.lines[state.cursorLine]!
  if (line[state.cursorCol - 1] !== '\\') return insertNewline(state)

  const newLines = [...state.lines]
  newLines.splice(
    state.cursorLine,
    1,
    line.slice(0, state.cursorCol - 1),
    line.slice(state.cursorCol),
  )
  return withCompletionsCleared({
    ...state,
    lines: newLines,
    cursorLine: state.cursorLine + 1,
    cursorCol: 0,
  })
}

// ---------------------------------------------------------------------------
// Multi-line cursor movement (up/down within multi-line editor)
// ---------------------------------------------------------------------------

export function moveUp(state: EditorState, width = Number.POSITIVE_INFINITY): EditorState {
  return moveVertically(state, width, -1)
}

export function moveDown(state: EditorState, width = Number.POSITIVE_INFINITY): EditorState {
  return moveVertically(state, width, 1)
}

function moveVertically(state: EditorState, width: number, direction: -1 | 1): EditorState {
  const current = visualCursor(state, width)
  const preferredVisualCol = state.preferredVisualCol ?? current.visualCol
  let lineIndex = state.cursorLine
  let rows = current.rows
  let rowIndex = current.rowIndex

  while (true) {
    rowIndex += direction
    if (rowIndex < 0 || rowIndex >= rows.length) {
      lineIndex += direction
      if (lineIndex < 0 || lineIndex >= state.lines.length) return state
      rows = visualRows(state.lines[lineIndex]!, width)
      rowIndex = direction === -1 ? rows.length - 1 : 0
    }
    const target = rows[rowIndex]!
    const cursorCol = cursorAtVisualColumn(
      state.lines[lineIndex]!, target, preferredVisualCol, rowIndex < rows.length - 1,
    )
    // A reference can span several rows without any editable boundary inside.
    if (cursorCol === undefined) continue
    return withoutGhost({ ...state, cursorLine: lineIndex, cursorCol, preferredVisualCol }, true)
  }
}

interface VisualRow {
  start: number
  end: number
}

function visualRows(text: string, width: number): VisualRow[] {
  const finiteWidth = Number.isFinite(width)
  const safeWidth = finiteWidth ? Math.max(1, Math.floor(width)) : Number.MAX_SAFE_INTEGER
  const rows = wrapEditorText(text, safeWidth)
  const last = rows[rows.length - 1]
  if (finiteWidth && text.length > 0 && last
    && displayWidthBefore(text.slice(last.start, last.end), last.end - last.start) >= safeWidth) {
    rows.push({ start: text.length, end: text.length })
  }
  return rows
}

function visualCursor(state: EditorState, width: number): {
  rows: VisualRow[]
  rowIndex: number
  visualCol: number
} {
  const text = state.lines[state.cursorLine]!
  const cursorCol = snapToSegmentBoundary(text, state.cursorCol)
  const rows = visualRows(text, width)
  let rowIndex = rows.findIndex(row => cursorCol >= row.start && cursorCol < row.end)
  if (rowIndex < 0) rowIndex = rows.length - 1
  const row = rows[rowIndex]!
  return {
    rows,
    rowIndex,
    visualCol: displayWidthBefore(text.slice(row.start, row.end), cursorCol - row.start),
  }
}

function cursorAtVisualColumn(
  text: string,
  row: VisualRow,
  visualCol: number,
  continues: boolean,
): number | undefined {
  const candidate = row.start + boundaryAtDisplayWidth(text.slice(row.start, row.end), visualCol)
  // A shared wrap boundary belongs to the following row. Landing there would
  // leave ↑ on the same visual row forever when the preceding row is shorter.
  const boundaries = [0, ...segmentEditorText(text).map(segment => segment.end)]
    .filter(offset => offset >= row.start && (continues ? offset < row.end : offset <= row.end))
  return boundaries.findLast(offset => offset <= candidate) ?? boundaries[0]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function editorFromText(state: EditorState, text: string): EditorState {
  const lines = text.split('\n')
  return {
    ...state,
    lines,
    cursorLine: lines.length - 1,
    cursorCol: lines[lines.length - 1]!.length,
    preferredVisualCol: undefined,
    ghostHint: '',
    completion: null,
  }
}

function withCompletionsCleared(state: EditorState): EditorState {
  return refreshGhostHint({ ...state, preferredVisualCol: undefined, completion: null })
}

function withoutGhost(state: EditorState, preserveVisualColumn = false): EditorState {
  return {
    ...state,
    preferredVisualCol: preserveVisualColumn ? state.preferredVisualCol : undefined,
    ghostHint: '',
    completion: null,
  }
}
