/**
 * Background task panel: an interactive list of background terminals.
 *
 * Replaces the old line dump. Rows are selectable, a task can be stopped
 * in place, and its captured output can be pulled into the transcript — so
 * managing background work never requires typing a task id.
 *
 * Everything here is pure so the whole interaction is testable without a
 * terminal: the controller in `background-terminals.ts` owns the side effects.
 */

import { wrapTextWithAnsi } from '../../render/wrap.js'
import stripAnsi from 'strip-ansi'
import type { KeyEvent } from '../input.js'
import type { BackgroundProcess } from '../../native/index.js'
import type { Hint } from '../design/key-hints.js'
import type { SelectorItem, SelectorState } from '../selector.js'
import { createAppSelectorState } from './selector-identity.js'
import { clipDisplayText, formatElapsed } from '../../render/format.js'
import { taskCommandLabel, taskDirectory, taskTitle } from '../../render/task-label.js'
import type { UIToolCall } from './types.js'

export const BACKGROUND_PANEL_TITLE = 'Background'
export const BACKGROUND_OUTPUT_TITLE = 'Background output'

/**
 * Gesture advertised at the prompt while background work is live.
 *
 * ↓ is the primary way in: the hint sits directly above the composer, so the
 * key it names should be reachable without a modifier.
 */
export const BACKGROUND_PANEL_HINT_CHORD = '↓'

/** Panel toggle key. Ctrl+T is a portable C0 control character and unbound. */
export const BACKGROUND_PANEL_SHORTCUT_HINT = 'ctrl+t'

export function isBackgroundPanelShortcut(event: KeyEvent): boolean {
  return event.type === 'ctrl' && event.key === 't'
}

/**
 * Whether ↓ should open the panel instead of doing nothing.
 *
 * ↓ keeps every meaning it already had: the caller only consults this once
 * cursor movement and history navigation have both declined the key. The
 * remaining cases are gated on an empty composer, so ↓ never diverts attention
 * mid-sentence, and on live work, so the key does something only while the
 * prompt is actually advertising it.
 */
export function shouldDownOpenPanel(input: { editorEmpty: boolean; running: number }): boolean {
  return input.editorEmpty && input.running > 0
}

/** Statuses that are still doing work. */
export function isLiveStatus(status: BackgroundProcess['status']): boolean {
  return status === 'running' || status === 'running_foreground'
}

/**
 * Compact elapsed clock. Seconds below a minute, then `1m 3s` — a background
 * task often runs for minutes, where `94.0s` stops being readable.
 *
 * Defined in `render/format.ts` so the task tool cards spell a runtime exactly
 * the same way this panel does; re-exported here because the panel is where
 * callers expect to find it.
 */
export { formatElapsed }

/** A script label must not imply its first command is the active process. */
export function formatCommandLabel(command: string, maxChars = 96): string {
  const text = sanitizeTerminalOutput(command).trim()
  const lines = text.split('\n')
  return clipDisplayText(lines.length > 1 ? `script (${lines.length} lines)` : text || '(empty)', maxChars)
}

/** Parenthesised status shown after a row's command. */
export function formatStatusDetail(process: BackgroundProcess): string {
  const elapsed = formatElapsed(process.elapsed_ms)
  const exit = process.exit_code === null ? '' : `exit ${process.exit_code} · `
  switch (process.status) {
    case 'running':
    case 'running_foreground':
      return `running · ${elapsed}`
    case 'completed':
      return `${exit}${elapsed}`
    case 'failed':
      return `failed · ${exit}${elapsed}`
    case 'killed':
      // "cancelled" when the user asked for it, matching the task tool cards:
      // the same task must not read as `stopped` here and `cancelled by user`
      // there.
      return process.stopped_by_user
        ? `cancelled by user · ${elapsed}`
        : `stopped · ${elapsed}`
  }
}

/** Body text when no task is still running. */
export const PANEL_EMPTY_MESSAGE = 'No tasks currently running'

/**
 * Count line under the title. Counts live tasks only.
 *
 * "active" is deliberately broader than the footer chip's "background shells
 * running": this counts `running` and `running_foreground` alike, because the
 * panel lists both, whereas the chip counts only detached shells. The two lines
 * can therefore disagree by design, and the wording is what keeps that honest.
 *
 * An empty list has no subtitle: the body already says there is nothing to show,
 * and repeating it two rows apart reads like two different statements.
 */
export function formatPanelSubtitle(processes: BackgroundProcess[]): string | undefined {
  const live = processes.filter(process => isLiveStatus(process.status)).length
  return live > 0 ? `${live} active ${live === 1 ? 'shell' : 'shells'}` : undefined
}

/** Marker on the row of a task the agent is blocked on right now. */
export const WAITING_MARK = '◷ waiting'

/** Activity rows report silence from this long on: a stuck task looks idle. */
export const QUIET_NOTICE_MS = 60_000

/**
 * Tasks a running blocking `task_output` call is waiting on. The engine only
 * counts such waits, so the ids come from the live tool calls; `block`
 * defaults to true, matching the engine.
 */
export function awaitedTaskIds(calls: readonly UIToolCall[]): string[] {
  return calls
    .filter(call => call.status === 'running'
      && ['task_output', 'taskoutput'].includes(call.name.toLowerCase())
      && call.args?.block !== false
      && typeof call.args?.task_id === 'string')
    .map(call => call.args.task_id as string)
}

/**
 * The command column beside a title. With a description as the title, the
 * command follows it; a command title already is the command, so only a `cd`
 * into another directory adds anything.
 */
function panelCommandDetail(process: BackgroundProcess): string | undefined {
  const dir = taskDirectory(process.command, process.cwd)
  const where = dir ? `in ${dir}` : ''
  if (!process.description?.trim()) return where || undefined
  const command = sanitizeTerminalOutput(taskCommandLabel(process.command))
  return [command, where].filter(Boolean).join('  ')
}

/** Status column: never truncated, so the runtime survives a narrow terminal. */
function panelStatus(process: BackgroundProcess, awaited: boolean): SelectorItem['status'] {
  const text = formatStatusDetail(process)
  return awaited ? { text: `${text}  ${WAITING_MARK}`, tone: 'active' } : { text, tone: 'muted' }
}

/** The last output line under a row, plus how long the task has been silent. */
export function formatPanelActivity(lastLine: string | undefined, process: BackgroundProcess): string | undefined {
  const quiet = (process.quiet_for_ms ?? 0) >= QUIET_NOTICE_MS
    ? `quiet ${formatElapsed(process.quiet_for_ms ?? 0)}` : ''
  const text = [lastLine?.trim(), quiet].filter(Boolean).join(' · ')
  return text || undefined
}

/** Only live tasks occupy the management panel. */
export function formatPanelItems(processes: BackgroundProcess[], awaited: readonly string[] = []): SelectorItem[] {
  const live = processes.filter(process => isLiveStatus(process.status))
  return live.map((process): SelectorItem => ({
    label: clipDisplayText(sanitizeTerminalOutput(taskTitle(process)), 96),
    detail: panelCommandDetail(process),
    status: panelStatus(process, awaited.includes(process.task_id)),
    id: process.task_id,
    hints: backgroundPanelHints({ id: process.task_id, live: true }, live.length),
    // The full command and id stay searchable even though the row is truncated.
    searchText: `${process.description ?? ''} ${process.command} ${process.task_id}`,
  }))
}

/** Open the panel over the current task list. */
export function createBackgroundPanelState(
  processes: BackgroundProcess[],
  awaited: readonly string[] = [],
): SelectorState {
  return {
    ...createAppSelectorState('background', BACKGROUND_PANEL_TITLE, formatPanelItems(processes, awaited)),
    presentation: 'background-list',
    subtitle: formatPanelSubtitle(processes),
    noFilter: true,
    emptyMessage: PANEL_EMPTY_MESSAGE,
    // Fallback for an empty list, where no row can carry hints.
    hints: backgroundPanelHints(null, 0),
  }
}

/**
 * Refresh an open panel in place.
 *
 * Preserve a surviving task's focus by id; when it finishes, focus the nearest
 * remaining live row.
 */
export function refreshBackgroundPanelState(
  state: SelectorState,
  processes: BackgroundProcess[],
  awaited: readonly string[] = [],
): SelectorState {
  const focusedId = state.items[state.focusIndex]?.id
  const items = formatPanelItems(processes, awaited)
  const next: SelectorState = {
    ...state,
    items,
    allItems: items,
    subtitle: formatPanelSubtitle(processes),
    scrollOffset: Math.min(state.scrollOffset, Math.max(0, items.length - 1)),
  }
  const focusIndex = focusedId ? items.findIndex(item => item.id === focusedId) : -1
  if (focusIndex >= 0) return { ...next, focusIndex }
  // The focused task disappeared. Clamp onto the nearest surviving row, skipping
  // group headings: they are not focusable, and landing on one would leave the
  // panel with no actionable selection.
  return { ...next, focusIndex: nearestFocusable(items, state.focusIndex) }
}

/** The closest focusable row at or before `index`, else the first one. */
function nearestFocusable(items: SelectorItem[], index: number): number {
  const clamped = Math.min(index, Math.max(0, items.length - 1))
  for (let i = clamped; i >= 0; i--) {
    if (items[i] && items[i]!.focusable !== false) return i
  }
  const forward = items.findIndex(item => item.focusable !== false)
  return forward >= 0 ? forward : 0
}

export type BackgroundPanelAction =
  | { kind: 'view'; taskId: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'stop-all' }
  | { kind: 'close' }
  | { kind: 'none' }

/**
 * Map a keypress inside the panel onto an action.
 *
 * `enter` views output, `x` stops the focused task, `X` stops every task, and
 * `esc` closes. Stopping an already-finished task is a no-op rather than an
 * error: its process is gone, so there is nothing to signal.
 *
 * The panel deliberately has no type-to-filter: a session holds at most a
 * handful of shells, and reserving bare letters for actions keeps `x` free for
 * the destructive gesture instead of hiding it behind a modifier.
 */
export function decideBackgroundPanelAction(
  event: KeyEvent,
  focused: { id: string; live: boolean } | null,
): BackgroundPanelAction {
  if (event.type === 'escape') return { kind: 'close' }
  if (event.type === 'enter') {
    return focused ? { kind: 'view', taskId: focused.id } : { kind: 'none' }
  }
  // Shift+X arrives as `shift-char` under the kitty protocol (already
  // lowercased) and as a bare uppercase `char` on legacy terminals. Both mean
  // stop-all, so both are accepted.
  if (event.type === 'shift-char' && event.char.toLowerCase() === 'x') return { kind: 'stop-all' }
  if (event.type === 'char' && event.char === 'X') return { kind: 'stop-all' }
  if (event.type === 'char' && event.char === 'x') {
    if (!focused || !focused.live) return { kind: 'none' }
    return { kind: 'stop', taskId: focused.id }
  }
  return { kind: 'none' }
}

/** The focused row as an action target, or null when the list is empty. */
export function focusedPanelTarget(
  state: SelectorState,
  processes: BackgroundProcess[],
): { id: string; live: boolean } | null {
  const id = state.items[state.focusIndex]?.id
  if (!id) return null
  const process = processes.find(candidate => candidate.task_id === id)
  return { id, live: process ? isLiveStatus(process.status) : false }
}

/**
 * Footer hints for the panel, matching the gestures that are live right now.
 *
 * Every entry is conditional on being usable: `↑/↓ to select` needs a row to
 * move onto, `x to stop` needs the focused row to be running, and
 * `X to stop all` only earns its place when more than one shell is live (with
 * exactly one, it duplicates `x`). A hint for a key that does nothing is worse
 * than no hint, because pressing it is the only way to find out.
 */
export function backgroundPanelHints(
  focused: { id: string; live: boolean } | null,
  runningCount: number,
): Hint[] {
  return [
    ...(focused ? [{ keys: ['up', 'down'], action: 'select' } satisfies Hint] : []),
    ...(focused ? [{ keys: 'enter', action: 'view output' } satisfies Hint] : []),
    ...(focused?.live ? [{ keys: 'x', action: 'stop' } satisfies Hint] : []),
    ...(runningCount > 1 ? [{ keys: 'X', action: 'stop all' } satisfies Hint] : []),
    { keys: 'escape', action: 'close' },
  ]
}

/** Output lines shown in the live tail view. */
export const OUTPUT_TAIL_LINES = 200

/** Build the dedicated, full-width live output view for one task. */
export function createBackgroundOutputState(
  process: BackgroundProcess,
  output: string,
  returnToPrompt = false,
): SelectorState {
  const safeOutput = sanitizeTerminalOutput(output)
  return {
    ...createAppSelectorState('backgroundOutput', BACKGROUND_OUTPUT_TITLE, [{
      id: process.task_id,
      label: formatCommandLabel(process.command),
      detail: formatStatusDetail(process),
      preview: formatLiveOutputView(process, safeOutput),
    }]),
    presentation: 'background-output',
    subtitle: process.task_id.slice(0, 8),
    noFilter: true,
    outputView: { returnToPrompt },
    hints: backgroundOutputHints(process, returnToPrompt),
  }
}

/** Hints describe only actions available on this task. */
export function backgroundOutputHints(process: BackgroundProcess, returnToPrompt = false) : Hint[] {
  return [
    { keys: 'escape', action: returnToPrompt ? 'close' : 'back' },
    ...(isLiveStatus(process.status) ? [{ keys: 'x', action: 'stop' } satisfies Hint] : []),
    { keys: ['up', 'down'], action: 'scroll' },
  ]
}

/** Strip terminal control sequences before command output enters the renderer. */
export function sanitizeTerminalOutput(output: string): string {
  return stripAnsi(output)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

/** Pinned metadata, a blank separator, then the tail-following body. */
export function formatLiveOutputView(process: BackgroundProcess, output: string): string[] {
  const normalized = output.endsWith('\n') ? output.slice(0, -1) : output
  const all = normalized.length === 0 ? [] : normalized.split('\n')
  const visible = all.slice(-OUTPUT_TAIL_LINES)
  const hidden = all.length - visible.length
  const body = visible.length === 0 ? ['(no output yet)'] : visible
  return [
    `  ${STATUS_MARK[process.status]} · ${formatStatusDetail(process)}`,
    `  Output: ${sanitizeTerminalOutput(process.output_path)}`,
    ...(process.output_file_truncated
      ? ['  ⚠ output file was capped; earlier output was dropped']
      : []),
    ...(hidden > 0 ? [`  … ${hidden} earlier ${hidden === 1 ? 'line' : 'lines'}`] : []),
    '',
    'Command',
    ...sanitizeTerminalOutput(process.command).split('\n'),
    '',
    'Output',
    ...body,
  ]
}

export function backgroundOutputRows(state: SelectorState, columns: number): string[] {
  const preview = state.items[0]?.preview ?? ['', '(no output yet)']
  const split = preview.indexOf('')
  const body = split < 0 ? preview : preview.slice(split + 1)
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80
  return body.flatMap(entry => wrapTextWithAnsi(entry, Math.max(1, width - 2)))
}

/** Pinned lines above the body: title and status, plus the capped-file warning. */
export function backgroundOutputHeaderLines(state: SelectorState): string[] {
  const preview = state.items[0]?.preview ?? []
  const split = preview.indexOf('')
  return split < 0 ? [] : preview.slice(0, split)
}

/**
 * Rows the output overlay may occupy in total, excluding the outer renderer's
 * leading blank and two borders. Capped so a tall terminal does not turn the
 * overlay into a second screen; floored so short terminals still show activity.
 */
export function backgroundOutputBudget(rows: number): number {
  return Math.max(4, Math.min(24, Math.floor(rows) - 4))
}

/** Rows below the body: the position line and the key hints. */
const OUTPUT_FOOTER_LINES = 2

/** Header rows: title and status, plus one per warning. */
function outputHeaderHeight(state: SelectorState): number {
  const warnings = backgroundOutputHeaderLines(state).filter(text => text.includes('output file was capped'))
  return 2 + warnings.length
}

export interface BackgroundOutputViewport {
  /** Every wrapped body row (command, output, markers). */
  body: string[]
  /** Rows the body viewport can show at once. */
  height: number
  /** First visible body row. */
  start: number
  /** One past the last visible body row. */
  end: number
  /** True while the view is pinned to the tail. */
  following: boolean
}

/**
 * Body window for the output overlay.
 *
 * `outputView.scrollOffset` is the first visible body row; undefined follows
 * the tail. The window is always `height` rows when the body is that long, and
 * the whole body otherwise, so scrolling never changes the overlay's height:
 * the composer and footer below it stay exactly where they are.
 */
export function backgroundOutputViewport(
  state: SelectorState,
  columns: number,
  rows: number,
): BackgroundOutputViewport {
  const body = backgroundOutputRows(state, columns)
  const height = Math.max(1, backgroundOutputBudget(rows) - outputHeaderHeight(state) - OUTPUT_FOOTER_LINES)
  const maxStart = Math.max(0, body.length - height)
  const offset = state.outputView?.scrollOffset
  const following = offset === undefined || offset >= maxStart
  const start = following ? maxStart : Math.max(0, offset)
  return { body, height, start, end: Math.min(body.length, start + height), following }
}

export type OutputScrollKey = 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end' | 'command'

/**
 * The scroll offset after one navigation key, or undefined to follow the tail.
 *
 * Scrolling is clamped to the body: a body that already fits cannot be scrolled
 * at all, so ↑ on a short output is inert rather than pausing an empty window.
 * Reaching the bottom by any route resumes following, so the tail picks up
 * again without a dedicated key.
 */
export function scrollBackgroundOutput(
  viewport: BackgroundOutputViewport,
  key: OutputScrollKey,
): number | undefined {
  const maxStart = Math.max(0, viewport.body.length - viewport.height)
  if (maxStart === 0) return undefined
  const page = Math.max(1, viewport.height - 1)
  let next: number
  switch (key) {
    case 'home':
    case 'command':
      next = 0
      break
    case 'end':
      return undefined
    case 'up':
      next = viewport.start - 1
      break
    case 'down':
      next = viewport.start + 1
      break
    case 'page-up':
      next = viewport.start - page
      break
    case 'page-down':
      next = viewport.start + page
      break
  }
  const clamped = Math.max(0, Math.min(maxStart, next))
  return clamped >= maxStart ? undefined : clamped
}

/**
 * One line describing where the window sits. Always present (possibly empty)
 * so the overlay keeps a constant height whether or not the view is paused.
 */
export function formatOutputPosition(viewport: BackgroundOutputViewport): string {
  const total = viewport.body.length
  if (!viewport.following) {
    return `Paused · ${viewport.start + 1}–${viewport.end} of ${total} · ↓ or End to follow latest`
  }
  if (viewport.start > 0) {
    return `Following latest · ${viewport.start} earlier ${viewport.start === 1 ? 'line' : 'lines'} · ↑ to scroll back`
  }
  return ''
}

/** Replace status and tail while preserving the open output view. */
export function refreshBackgroundOutputState(
  state: SelectorState,
  process: BackgroundProcess,
  output: string,
): SelectorState {
  const next = createBackgroundOutputState(process, output, state.outputView?.returnToPrompt)
  // Freeze the captured body while reading older output. A moving file tail
  // must not move the user's reading position (even when lines repeat).
  if (state.outputView?.scrollOffset !== undefined) {
    const previous = state.items[0]?.preview ?? []
    const preview = next.items[0]?.preview
    if (preview && previous.includes('')) {
      const frozenBody = previous.slice(previous.indexOf('') + 1)
      preview.splice(preview.indexOf('') + 1, Infinity, ...frozenBody)
    }
  }
  return { ...next, query: state.query, outputView: state.outputView }
}

const STATUS_MARK: Record<BackgroundProcess['status'], string> = {
  running_foreground: '●',
  running: '●',
  completed: '✓',
  failed: '✗',
  killed: '■',
}
