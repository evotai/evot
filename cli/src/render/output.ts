/**
 * OutputLine — a single line of REPL output.
 *
 * All REPL output (user messages, assistant text, tool results, verbose events)
 * is modeled as an append-only list of OutputLines. These are rendered by
 * Ink's <Static> component, which writes them once and never re-renders.
 *
 * This module is pure logic — no React, no stdout. Easy to test.
 */

import { providerFailurePresentation } from '../provider/error-presentation.js'
import { parsePrivacyStop, privacyCard, type PrivacyStop } from '../privacy/notice.js'
import { renderMarkdown, renderThinkingMarkdown } from './markdown.js'
import { colorizeUnifiedDiffRows, type DiffRowKind } from './diff.js'
import { truncate, formatDuration, formatElapsed, formatWallClock, toolResultLines, formatBashCommandDisplay, EXPAND_HINT, COLLAPSE_HINT, summarizeInline } from './format.js'
import { formatCompactionCompleted } from './verbose.js'
import type { UICompaction, UIMessage, UIToolCall } from '../term/app/types.js'

// ---------------------------------------------------------------------------
// Tool presentation — icon + primary argument per tool, followed by a stable
// lifecycle status row. Optional reasons, progress, diffs, and result output
// always render after those first two rows.
// ---------------------------------------------------------------------------

interface ToolGlyph { icon: string }

/** Map an engine tool name to a compact glyph. Unknown tools fall back to `·`. */
function toolGlyph(name: string): ToolGlyph {
  switch (name.toLowerCase()) {
    case 'bash': return { icon: '⌘' }
    case 'read': case 'read_code': return { icon: '◫' }
    case 'grep': case 'glob': case 'find': case 'search': return { icon: '⌕' }
    case 'web_fetch': case 'webfetch': return { icon: '⊕' }
    case 'edit': case 'file_edit': case 'write': case 'file_write': return { icon: '✎' }
    // Background task tools act on a shell, so they share the bash glyph
    // family rather than falling through to the anonymous `·`.
    case 'task_output': case 'taskoutput': return { icon: '◷' }
    case 'task_stop': case 'taskstop': return { icon: '⊘' }
    default: return { icon: '·' }
  }
}

/** User-facing label for internal tool names. Protocol names remain unchanged. */
function toolDisplayName(name: string): string {
  switch (name.toLowerCase()) {
    case 'task_output': case 'taskoutput': return 'background shell'
    case 'task_stop': case 'taskstop': return 'stop background shell'
    default: return name
  }
}

/** True for the tools that act on an existing background task by id. */
function isTaskTool(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'task_output' || n === 'taskoutput' || n === 'task_stop' || n === 'taskstop'
}

/** Resolve a path-like tool argument, preserving empty/invalid values so failed
 *  cards still show what was attempted (e.g. path="." or a missing path). */
function toolPathArg(args: Record<string, unknown>): { raw: string | undefined; display: string } {
  const raw = args?.path ?? args?.file ?? args?.file_path
  if (typeof raw !== 'string') return { raw: undefined, display: '' }
  const trimmed = raw.trim()
  if (!trimmed) return { raw, display: 'path=""' }
  // Bare "." / "./" is almost always a model mistake for edit/write/read.
  if (trimmed === '.' || trimmed === './') return { raw, display: `path="${trimmed}"` }
  return { raw, display: trimmed }
}

/** Short one-line summary of edit replacements for the failed/expanded card. */
function editReplacementHeadline(args: Record<string, unknown>): string {
  const edits = Array.isArray(args.edits) ? args.edits : []
  if (edits.length === 0) {
    const oldText = typeof args.oldText === 'string' ? args.oldText
      : typeof args.old_string === 'string' ? args.old_string : ''
    const newText = typeof args.newText === 'string' ? args.newText
      : typeof args.new_string === 'string' ? args.new_string : ''
    if (!oldText && !newText) return ''
    return formatReplacementPair(oldText, newText)
  }
  if (edits.length === 1) {
    const edit = edits[0] as Record<string, unknown>
    const oldText = typeof edit?.oldText === 'string' ? edit.oldText
      : typeof edit?.old_string === 'string' ? edit.old_string : ''
    const newText = typeof edit?.newText === 'string' ? edit.newText
      : typeof edit?.new_string === 'string' ? edit.new_string : ''
    return formatReplacementPair(oldText, newText)
  }
  return `${edits.length} replacements`
}

function formatReplacementPair(oldText: string, newText: string): string {
  const oldPart = oldText ? summarizeInline(oldText, 40) : '∅'
  const newPart = newText ? summarizeInline(newText, 40) : '∅'
  return `replace ${JSON.stringify(oldPart)} → ${JSON.stringify(newPart)}`
}

/** The single most useful argument to show beside the tool name. */
function toolPrimaryArg(
  name: string,
  args: Record<string, unknown>,
  previewCommand?: string,
  expanded?: boolean,
  options?: { failed?: boolean },
): string {
  const n = name.toLowerCase()
  if (n === 'bash') {
    const command = toolDraftText({ previewCommand, command: args?.command }, ['previewCommand', 'command'])
    return formatBashCommandDisplay(command, expanded, true).headline
  }
  if (isTaskTool(name)) {
    // The engine resolves the task id to its command via preview_command, so
    // concurrent cards name different shells instead of all reading
    // `task_output`. Falls back to the raw id when the task is already gone.
    const command = toolDraftText({ previewCommand, task_id: args?.task_id }, ['previewCommand', 'task_id'])
    if (!command) return ''
    return formatBashCommandDisplay(command, expanded, true).headline
  }

  const { display: pathDisplay } = toolPathArg(args)
  if (n === 'edit' || n === 'file_edit') {
    const replacement = editReplacementHeadline(args)
    const edits = Array.isArray(args.edits) ? args.edits : []
    // Multi-edit failures list each replacement as detail lines; keep the
    // headline to path only so it doesn't repeat "N replacements".
    if (pathDisplay && options?.failed && edits.length > 1) return pathDisplay
    if (pathDisplay && replacement && options?.failed) {
      return `${pathDisplay} · ${replacement}`
    }
    if (pathDisplay) return pathDisplay
    if (replacement) return replacement
    return options?.failed ? '(missing path)' : ''
  }
  if (n === 'write' || n === 'file_write' || n === 'read' || n === 'read_code') {
    if (pathDisplay) return pathDisplay
    return options?.failed ? '(missing path)' : ''
  }
  if (pathDisplay) return pathDisplay

  const pattern = (args?.pattern ?? args?.query ?? args?.url) as string | undefined
  // Show the full value — the viewmodel wraps the card arg to terminal width,
  // so the tail is never lost. Newlines collapse to a single logical line.
  if (pattern) return String(pattern).replace(/\r?\n/g, ' ').trim()
  return ''
}

/** Tool call line text: `<glyph> <name>  <primary-arg>`. The viewmodel paints
 *  the glyph and parts; status (✓/✗) lives on the subordinate result line. */
function toolCallText(
  name: string,
  args: Record<string, unknown>,
  previewCommand?: string,
  expanded?: boolean,
  options?: { failed?: boolean },
): string {
  const glyph = toolGlyph(name).icon
  const displayName = toolDisplayName(name)
  const primary = toolPrimaryArg(name, args, previewCommand, expanded, options)
  return primary ? `${glyph} ${displayName}  ${primary}` : `${glyph} ${displayName}`
}

function toolDraftText(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function normalizeWritePreviewText(text: string): string {
  return text
    .replace(/\r/g, '')
    // Four spaces to match the split-diff renderer's own tab expansion, so the
    // streamed body and the engine diff that replaces it indent identically.
    .replace(/\t/g, '    ')
    // Tool arguments are untrusted model output. Never pass embedded terminal
    // controls through the preview; only line feeds are meaningful here.
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '�')
}

function writePreviewLines(content: string): string[] {
  if (!content) return []
  const lines = normalizeWritePreviewText(content).split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lineCount(text: string): number {
  return writePreviewLines(text).length
}

/**
 * The streamed body of a `write` call, shaped as the all-additions patch a new
 * file produces. It goes through [`diffOutputLines`], so the card is a diff
 * from the first streamed line; the engine's authoritative diff then only has
 * to extend it with context and removals for a rewrite.
 */
function streamedWritePatch(content: string): string {
  const body = writePreviewLines(content)
  if (body.length === 0) return ''
  return [`@@ -0,0 +1,${body.length} @@`, ...body.map(line => `+${line}`)].join('\n')
}

/**
 * Fixed gutter width for every diff on a `write` card.
 *
 * A streamed body grows line by line, so a gutter sized to the current line
 * count would widen at 9→10 and 99→100 and shift every row already painted.
 * The renderer treats scrollback as append-only, so rows that already scrolled
 * out would keep the narrow gutter and the transcript would show a permanent
 * one-column jog. Four digits covers real writes; the engine diff that
 * replaces the streamed body uses the same width so the swap moves nothing.
 */
const WRITE_DIFF_GUTTER = 4

/** Live write body while arguments stream and the tool executes. */
function appendWriteBody(lines: OutputLine[], call: UIToolCall): void {
  const name = call.name.toLowerCase()
  if (name !== 'write' && name !== 'file_write') return
  const patch = streamedWritePatch(toolDraftText(call.args, ['content']))
  if (!patch) return
  lines.push(...diffOutputLines(patch, WRITE_DIFF_GUTTER))
}

function toolDraftSummary(call: UIToolCall): string {
  const name = call.name.toLowerCase()
  if (name === 'write' || name === 'file_write') {
    const content = toolDraftText(call.args, ['content'])
    const count = content ? lineCount(content) : 0
    return count > 0 ? `generating ${count} ${count === 1 ? 'line' : 'lines'}` : 'generating content'
  }
  if (name === 'edit' || name === 'file_edit') {
    const edits = Array.isArray(call.args.edits) ? call.args.edits.length : 0
    return edits > 0 ? `preparing ${edits} ${edits === 1 ? 'replacement' : 'replacements'}` : 'preparing replacement'
  }
  return 'preparing arguments'
}

function toolStatusLine(mark: '○' | '●' | '✓' | '✗', parts: string[], hint = ''): OutputLine {
  const detail = parts.filter(Boolean).join(' · ')
  return {
    id: genId('tool-status'),
    kind: 'tool',
    text: `  ${mark}${detail ? ` · ${detail}` : ''}${hint ? ` ${hint}` : ''}`,
  }
}

/** A collapsed/expand hint row under a card. */
function toolHintLine(text: string): OutputLine {
  return { id: genId('tool-hint'), kind: 'tool_result', text }
}

function insertToolStatus(lines: OutputLine[], status: OutputLine): void {
  const callIndex = lines.findIndex(line => line.kind === 'tool' && !line.text.startsWith('  '))
  lines.splice(callIndex < 0 ? 0 : callIndex + 1, 0, status)
}

/** Keep each patch together so responsive layout also works across history-cache slices. */
function diffOutputLines(diff: string, gutter = 0): OutputLine[] {
  return [{
    id: genId('tool-diff'),
    kind: 'tool',
    text: colorizeUnifiedDiffRows(diff, true, gutter).map(row => row.text).join('\n'),
    diffText: diff,
    diffGutter: gutter > 0 ? gutter : undefined,
  }]
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputLine {
  id: string
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool_result' | 'verbose' | 'error' | 'system' | 'cancelled'
  text: string
  rawMarkdown?: string
  /** Thinking text already contains markdown ANSI; apply only the outer tint. */
  thinkingStyle?: boolean
  /** Render-only identity: adjacent reasoning blocks keep separate windows. */
  thinkingBlockId?: string
  /**
   * Fold policy shared by every line of one reasoning block. The viewmodel
   * wraps the whole block first, then keeps its newest visual rows. The same
   * window stays visible after streaming ends. Absent means never fold
   * (expanded view).
   */
  thinkingFold?: ThinkingFold
  /** System text that already carries its own ANSI styling (e.g. `/skill`).
   *  Rendered verbatim instead of being flattened to one dim gray. */
  preStyled?: boolean
  /** Tool line that is one row of a rendered diff; added/removed rows get
   *  their own fill inside the card. */
  /** Width-aware compact command budget; expanded cards have no row limit. */
  commandMaxRows?: number
  diffRow?: DiffRowKind
  /** Original patch retained for responsive split/unified layout at render time. */
  diffText?: string
  /** Fixed gutter width, so a patch that grows between frames never re-indents
   *  rows already painted (and already in scrollback). See WRITE_DIFF_GUTTER. */
  diffGutter?: number
  codeBlockId?: string
  codeLanguage?: string
  /** Visual spacer inserted between streamed markdown chunks. It creates a
   *  blank line but must not start a new assistant message marker. */
  isContinuationSpacer?: boolean
  /** First line of a committed user/assistant message: gets an OSC 133 zone
   *  start marker so terminals can select/copy the whole message. */
  zoneStart?: boolean
  /** Last line of a committed user/assistant message: gets the OSC 133 zone
   *  end marker. */
  zoneEnd?: boolean
  /** Wall-clock time the message was committed, in epoch millis. Captured at
   *  build time (not render time) so a re-render — and the incremental history
   *  cache — reproduces the same header a full rebuild would. */
  timestamp?: number
  /**
   * Membership in a tool card. Every line of one call carries the same state
   * so the viewmodel can lay the whole card on the panel; `first`/`last` mark
   * the card's edges, where the padded rows go.
   */
  toolCard?: ToolCardMembership
  /** Display-only events persisted for sharing, independent of rendered copy. */
  shareEvents?: Array<
    | { kind: 'thinking_level_change'; data: { thinking_level: string } }
    | { kind: 'model_change'; data: { provider: string; model: string } }
  >
}

/** Compact reasoning scrolls in a tail window, then keeps that window. */
export type ThinkingFold = 'tail'

export type ToolCardState = 'pending' | 'success' | 'error'

export interface ToolCardMembership {
  state: ToolCardState
  first: boolean
  last: boolean
}

/** Stamp a finished card's lines with their shared state and edges. */
function stampToolCard(lines: OutputLine[], state: ToolCardState): OutputLine[] {
  const last = lines.length - 1
  return lines.map((line, index) => ({
    ...line,
    toolCard: { state, first: index === 0, last: index === last },
  }))
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

let nextId = 0

function genId(prefix: string): string {
  return `${prefix}-${nextId++}`
}

/** Reset ID counter (for tests). */
export function resetIdCounter(): void {
  nextId = 0
}

// ---------------------------------------------------------------------------
// Builders — pure functions that create OutputLines from events
// ---------------------------------------------------------------------------

export function buildUserMessage(text: string, timestamp: number = Date.now()): OutputLine[] {
  if (!text) return []
  return [{ id: genId('user'), kind: 'user', text, zoneStart: true, zoneEnd: true, timestamp }]
}

export function buildAssistantLines(
  markdownText: string,
  options: { streaming?: boolean; idPrefix?: string } = {},
): OutputLine[] {
  if (!markdownText.trim()) return []
  const rendered = renderMarkdown(markdownText, { streaming: options.streaming })
  if (!rendered || !rendered.trim()) return []
  const cleaned = rendered.replace(/^\n+/, '').replace(/\n+$/, '')
  const parts = cleaned.split('\n')
  return parts.map((line, i) => ({
    id: options.idPrefix === undefined ? genId('asst') : `${options.idPrefix}-${i}`,
    kind: 'assistant' as const,
    text: line,
    rawMarkdown: markdownText,
    // Wrap the whole assistant message in one OSC 133 zone (first line starts,
    // last line ends) so it selects/copies as a single block.
    zoneStart: i === 0,
    zoneEnd: i === parts.length - 1,
  }))
}

/**
 * True when reasoning text carries something to read.
 *
 * An evot-pro-anthropic diagnostic request returned a thinking_delta whose
 * entire text was `...`, after its tool call. This placeholder is already in
 * the gateway's wire response; it is not evidence of a short reasoning turn
 * or of any particular OpenAI summary policy. Suppress it only in the view,
 * retaining the original signed thinking block for replay. Real text that
 * merely contains dots ("checking ... now") must still render.
 */
function hasReasoningContent(text: string): boolean {
  return text.replace(/[.\u2026\s]/g, '').length > 0
}

/**
 * Reasoning rows, rendered as markdown and tinted muted by the viewmodel.
 *
 * Unless `expanded`, a short tail window scrolls in place while reasoning
 * streams. Once the block finishes, the same window stays in the transcript
 * with its original text and an expand hint for any hidden rows.
 * `streaming` only selects fence handling in the markdown pipeline.
 */
export function buildThinkingLines(
  text: string,
  options: { streaming?: boolean; expanded?: boolean } = {},
): OutputLine[] {
  if (!text.trim() || !hasReasoningContent(text)) return []
  const rendered = renderThinkingMarkdown(text, { streaming: options.streaming })
  if (!rendered || !rendered.trim()) return []
  const cleaned = rendered.replace(/^\n+/, '').replace(/\n+$/, '')
  const thinkingFold: ThinkingFold | undefined = options.expanded ? undefined : 'tail'
  const thinkingBlockId = genId('think')
  return cleaned.split('\n').map((line, index) => ({
    id: index === 0 ? thinkingBlockId : genId('think'),
    kind: 'thinking' as const,
    text: line,
    thinkingStyle: true,
    thinkingBlockId,
    thinkingFold,
  }))
}

export function buildToolCall(
  name: string,
  args: Record<string, unknown>,
  previewCommand?: string,
  expanded?: boolean,
  options?: { failed?: boolean },
): OutputLine[] {
  // Keep the operation headline first so every lifecycle state has the same
  // stable card geometry: headline → status → optional reason/output details.
  const lines: OutputLine[] = [{
    id: genId('tool'),
    kind: 'tool',
    text: toolCallText(name, args, previewCommand, expanded, options),
    commandMaxRows: name.toLowerCase() === 'bash' || isTaskTool(name) ? (expanded ? undefined : 2) : undefined,
  }]
  for (const reason of formatReasonLines(args)) {
    lines.push({ id: genId('tool'), kind: 'tool', text: `  ${reason}` })
  }
  // Failed edit cards: show each replacement summary under the headline so the
  // user can see what was attempted without expanding the full result body.
  if (options?.failed) {
    for (const detail of failedArgDetailLines(name, args)) {
      lines.push({ id: genId('tool'), kind: 'tool', text: `  ${detail}` })
    }
  }
  // Expanded multi-line bash: keep newlines instead of flattening into a wall.
  // Collapse hint matches expanded tool results / progress cards — but only
  // when the user explicitly expanded (not auto-expanded failures).
  if ((name.toLowerCase() === 'bash' || isTaskTool(name)) && expanded) {
    const command = toolDraftText({ previewCommand, command: args?.command }, ['previewCommand', 'command'])
    const details = formatBashCommandDisplay(command, true).detailLines
    for (const detail of details) {
      lines.push({ id: genId('tool'), kind: 'tool', text: detail })
    }
    if (details.length > 0) {
      lines.push(toolHintLine(`  [2m${COLLAPSE_HINT}[0m`))
    }
  }
  return lines
}

/** Extra indented lines that only appear on failed cards to make the attempt
 *  obvious (multi-edit replacements, empty path, etc.). */
function failedArgDetailLines(name: string, args: Record<string, unknown>): string[] {
  const n = name.toLowerCase()
  if (n !== 'edit' && n !== 'file_edit') return []
  const edits = Array.isArray(args.edits) ? args.edits : []
  if (edits.length <= 1) return []
  const lines: string[] = []
  const maxShow = 3
  for (let i = 0; i < Math.min(edits.length, maxShow); i++) {
    const edit = edits[i] as Record<string, unknown>
    const oldText = typeof edit?.oldText === 'string' ? edit.oldText
      : typeof edit?.old_string === 'string' ? edit.old_string : ''
    const newText = typeof edit?.newText === 'string' ? edit.newText
      : typeof edit?.new_string === 'string' ? edit.new_string : ''
    lines.push(`${i + 1}/${edits.length} ${formatReplacementPair(oldText, newText)}`)
  }
  if (edits.length > maxShow) {
    lines.push(`… +${edits.length - maxShow} more replacements`)
  }
  return lines
}

export function buildToolCard(call: UIToolCall, expanded?: boolean, _now = Date.now()): OutputLine[] {
  // ask_user owns an interactive overlay and commits the selected answer (or
  // cancellation) separately. Rendering its engine-side lifecycle as a generic
  // tool card duplicates that UI with an unhelpful `ready/running` card.
  if (isAskUserTool(call.name)) return []
  if (isScheduleWakeupTool(call.name)) return buildLoopCard(call, _now)

  const details = asDetails(call.details)
  const diff = typeof details.diff === 'string' ? details.diff : undefined
  const args = diff ? { ...call.args, diff } : call.args
  // Pre-compute failure so the headline can surface path="." / missing path and
  // edit replacement summaries before the status line is inserted.
  const exitCode = call.name.toLowerCase() === 'bash' ? detailNumber(details, 'exit_code') : undefined
  const settledFailed = call.status === 'error'
    || details.error === true
    || (exitCode !== undefined && exitCode !== 0)
  // Note: failure enriches the headline ({failed}) but does NOT force the
  // command body open — a huge heredoc stays collapsed; ctrl+o still works.
  const lines = buildToolCall(
    call.name,
    args,
    isTaskTool(call.name) ? detailString(details, 'command') ?? call.previewCommand : call.previewCommand,
    expanded,
    { failed: settledFailed },
  )

  const write = call.name.toLowerCase() === 'write' || call.name.toLowerCase() === 'file_write'
  const showFinalDiff = call.status === 'done' && !settledFailed && !!diff
  if (write && typeof call.args.content === 'string') {
    // All mutable metadata follows the code, and the body's gutter is fixed, so
    // rows already painted into native scrollback stay byte-identical as the
    // content grows and when the engine's diff replaces it. That includes the
    // status row: inserting it under the headline once the call settles would
    // push every body row down one line, and the rows already in native
    // scrollback cannot follow, so the transcript would keep the jog.
    if (showFinalDiff && diff) lines.push(...diffOutputLines(diff, WRITE_DIFF_GUTTER))
    else appendWriteBody(lines, call)
    if (call.status === 'queued') {
      lines.push(toolStatusLine('○', [call.argsComplete ? 'ready' : toolDraftSummary(call)]))
    } else if (call.status === 'running') {
      const progress = liveProgress(call, expanded)
      lines.push(toolStatusLine('●', [...runningStatusParts(call.name, args), ...progress.parts], progress.hint))
      for (const text of progress.rows) {
        lines.push({ id: genId('tool-progress'), kind: 'tool_result', text: `  ${text}` })
      }
    } else {
      // The body is already above, so the outcome rows must not repeat it:
      // `buildToolResult` renders any `diff` it finds on `args`.
      lines.push(...buildToolResult(call.name, call.args, call.status,
        call.result, call.durationMs, expanded, details))
    }
    return stampToolCard(lines, call.status === 'queued' || call.status === 'running'
      ? 'pending' : settledFailed ? 'error' : 'success')
  }

  if (call.status === 'queued') {
    const summary = call.argsComplete ? 'ready' : toolDraftSummary(call)
    insertToolStatus(lines, toolStatusLine('○', [summary]))
    appendWriteBody(lines, call)
    return stampToolCard(lines, 'pending')
  }

  if (call.status !== 'running') {
    // buildToolResult auto-previews failed bodies itself (tail lines), so pass
    // the raw user toggle: ctrl+o still expands/collapses failed cards.
    const resultLines = buildToolResult(
      call.name,
      args,
      call.status,
      call.result,
      call.durationMs,
      expanded,
      details,
    )
    insertToolStatus(lines, resultLines.shift() ?? toolStatusLine(settledFailed ? '✗' : '✓', []))
    lines.push(...resultLines)
    return stampToolCard(lines, settledFailed ? 'error' : 'success')
  }

  if (diff) {
    // A write card keeps the fixed gutter it streamed with, so swapping the
    // streamed body for the engine's diff does not re-indent anything.
    lines.push(...diffOutputLines(diff, write ? WRITE_DIFF_GUTTER : 0))
  } else {
    // Keep the streamed content visible between tool_started and the engine's
    // preview diff so the card never blanks out mid-transition (pi behavior).
    appendWriteBody(lines, call)
  }
  const progress = liveProgress(call, expanded)
  insertToolStatus(lines, toolStatusLine('●', [...runningStatusParts(call.name, args), ...progress.parts], progress.hint))
  for (const text of progress.rows) {
    lines.push({ id: genId('tool-progress'), kind: 'tool_result', text: `  ${text}` })
  }

  return stampToolCard(lines, 'pending')
}

/**
 * Streamed output of a running tool. Compact mode folds a multi-row body onto
 * the status row (`● · running · 12 lines (ctrl+o)`), the same shape the
 * settled card will take, so the card does not grow a row and then lose it.
 * A single row shows inline; expanded mode shows everything.
 */
function liveProgress(call: UIToolCall, expanded?: boolean): { parts: string[]; hint: string; rows: string[] } {
  if (!call.progress || call.progress.startsWith('__evot_spill_event__ ')) return { parts: [], hint: '', rows: [] }
  const rows = toolResultLines(formatToolResultContent(call.progress), false, call.name, true)
  if (expanded || rows.length <= 1) return { parts: [], hint: '', rows }
  return { parts: [plural(rows.length, 'line')], hint: EXPAND_HINT, rows: [] }
}

/** Failed tool bodies stay folded; the status row carries a short reason. */
function errorReason(result: string, summary: string): string {
  const first = result.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).find(Boolean) ?? ''
  // `Exit code: 7` or `HTTP 404 error` restate the summary; add only new facts.
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const known = normalize(summary)
  const candidate = normalize(first).replace(/^exitcode/, 'exit')
  if (!first || !known || candidate === known || candidate.startsWith(known) && candidate.length - known.length <= 6) return ''
  return summarizeInline(first, 96)
}

/** Process output from a `task_output` result, without the protocol envelope. */
function taskOutputBody(result: string): string {
  if (!result.startsWith('Task ID:')) return result
  const marker = '\nOutput:\n'
  const at = result.indexOf(marker)
  return at === -1 ? '' : result.slice(at + marker.length)
}

/**
 * Status parts for a card that is still executing.
 *
 * Most tools just say `running`. A `task_output` says what it is doing to the
 * task instead, because several such cards can be in flight at once and
 * `running` on each one says nothing about which is which or why it is waiting.
 */
function runningStatusParts(name: string, args: Record<string, unknown>): string[] {
  const n = name.toLowerCase()
  if (n === 'task_output' || n === 'taskoutput') {
    // `block` defaults to true, matching the engine's `is_none_or`.
    const blocking = args?.block !== false
    return [blocking ? 'waiting for task' : 'checking task']
  }
  if (n === 'task_stop' || n === 'taskstop') return ['stopping task']
  return ['running']
}

/** Tool latency below this is not shown on the status row. */
export const SHOWN_DURATION_MS = 1000

export function buildToolResult(
  name: string,
  args: Record<string, unknown>,
  status: 'done' | 'error',
  result?: string,
  durationMs?: number,
  expanded?: boolean,
  details: Record<string, unknown> = {},
): OutputLine[] {
  // Privacy refused the call before it ran: say why and how to allow it.
  const privacy = status === 'error' && result ? parsePrivacyStop(result) : null
  if (privacy) {
    const [statusRow, ...rows] = privacyCard(privacy).rows
    return [
      { id: genId('tool-status'), kind: 'tool', text: `  ${statusRow?.text ?? '✗ · blocked by privacy'}` },
      ...rows.map((row): OutputLine => ({ id: genId('tool-res'), kind: row.tone === 'error' ? 'error' : 'tool_result', text: `  ${row.text}` })),
    ]
  }
  const exitCode = name.toLowerCase() === 'bash' ? detailNumber(details, 'exit_code') : undefined
  const isError = status === 'error' || details.error === true || (exitCode !== undefined && exitCode !== 0)
  // A task poll is summarized by the task's output, not by the protocol
  // envelope around it (`Task ID: … Output:`), so its counts match the fold.
  const summary = toolResultSummary(name, args, result && !isError && isTaskTool(name) ? taskOutputBody(result) : result, details, isError)
  // Sub-second latency is noise on a card (`12ms` vs `30ms` for a read says
  // nothing); only a wait worth noticing is shown.
  const duration = durationMs !== undefined && durationMs >= SHOWN_DURATION_MS ? formatDuration(durationMs) : ''
  // Failed status: lead with "failed" so the line reads as an outcome, not a
  // size/duration metric ("74 B · 0ms" is meaningless for a missing path).
  const backgrounded = details.backgrounded === true
  // A task tool reports the *task's* outcome, not the poll's: `completed · exit
  // 0 · 1m 47s` rather than a byte count of the response body.
  const taskParts = !isError && isTaskTool(name) ? taskToolStatusParts(details) : []
  // Glyph decisions read the status field, not the rendered label. They used to
  // string-match the label ("still running", "failed"), which meant rewording a
  // card silently changed its icon: renaming the backgrounded label to "running
  // in background" flipped a live task from `●` to `✓`, reporting unfinished work
  // as done.
  const taskStatus = !isError && isTaskTool(name) ? detailString(details, 'status') : undefined
  // The poll succeeded but the task did not. Marking that `✓` would report a
  // broken build as a success, so the glyph follows the task, not the call.
  const taskFailed = taskStatus === 'failed'
  // A poll that found the task still running is in-flight work, not a completed
  // step, so it keeps the `●` running glyph — whether the task is detached or
  // still being waited on in the foreground.
  const stillRunning = taskStatus === 'running' || taskStatus === 'running_foreground'

  // The result body. Compact mode strips the task envelope and drops the
  // body of a backgrounded shell; expanded mode keeps everything for
  // diagnostics. Compact edit/write cards also drop a successful body: the
  // diff below is the real content, and `Updated path. Current content of the
  // changed region(s): …` only repeats it.
  const diff = args?.diff as string | undefined
  const hasDiff = !isError && typeof diff === 'string' && diff.length > 0
  const body = !result ? ''
    : !expanded && !isError && isTaskTool(name) ? taskOutputBody(result)
    : !expanded && !isError && (details.backgrounded === true || hasDiff) ? ''
    : result
  const formattedResult = formatToolResultContent(body)
  const bodyRows = body.trim() ? toolResultLines(formattedResult, isError, name, true) : []
  // A multi-row body folds in compact mode. The fold is reported on the
  // status row, not on a row of its own: `✓ · exit 0 · 1.2s · 4 lines (ctrl+o)`
  // says everything the old `… (+4 lines, ctrl+o to expand)` row did, one
  // row shorter on every tool call. A status that already shows the same
  // count (`read` says `3 lines`) only gets the hint. Shell output folds
  // even at one row: a command's single line is often a long path or a
  // wrapped error, and the status row already says how the command ended.
  const shell = name.toLowerCase() === 'bash' || isTaskTool(name)
  const folded = !expanded && (bodyRows.length > 1 || (shell && !isError && !taskFailed && bodyRows.length > 0))
  const statusParts = isError
    ? ['failed', summary, duration, result && !expanded ? errorReason(result, summary || 'failed') : ''].filter(Boolean)
    : taskParts.length > 0
      ? taskFailed && result && !expanded && result.startsWith('Task ID:') && taskOutputBody(result)
        ? [...taskParts, errorReason(taskOutputBody(result), taskParts.join(' '))].filter(Boolean)
        : taskParts
      : [summary, duration].filter(Boolean)
  // `read` says `3 lines` and `grep` says `2 matches` already; a status that
  // counts its result in any unit skips the line count and keeps the hint.
  const counted = /\b\d+ (line|match|hit|file|director|result|entr)/
  const foldParts = folded && !statusParts.some(part => counted.test(part)) ? [plural(bodyRows.length, 'line')] : []
  const mark = isError || taskFailed ? '✗' : backgrounded || stillRunning ? '●' : '✓'
  const lines: OutputLine[] = [toolStatusLine(mark, [...statusParts, ...foldParts], folded ? EXPAND_HINT : '')]

  // Diff (for write/edit tools) — skip on failure; the attempt is already
  // summarized on the headline and the error body is what matters.
  if (hasDiff && diff) {
    // A write's authoritative diff replaces a streamed body that was already
    // painted with a fixed gutter, so it has to keep that same width.
    const writeTool = name.toLowerCase() === 'write' || name.toLowerCase() === 'file_write'
    lines.push(...diffOutputLines(diff, writeTool ? WRITE_DIFF_GUTTER : 0))
  }

  // Tool result content. A folded body is already accounted for on the
  // status row. A single-row success is shown inline (nothing to fold); a
  // single-row failure is not, because the status row names the reason.
  if (!folded && bodyRows.length > 0 && !((isError || taskFailed) && !expanded)) {
    for (const rl of bodyRows) {
      lines.push({ id: genId('tool-res'), kind: isError ? 'error' : 'tool_result', text: `  ${rl}` })
    }
    // Collapse hint under any user-expanded multiline body (success or
    // failure) — ctrl+o collapses back to the default view.
    if (expanded && bodyRows.length > 1) {
      lines.push(toolHintLine(`  [2m${COLLAPSE_HINT}[0m`))
    }
  }

  return lines
}

export function buildToolProgress(name: string, text: string, expanded?: boolean): OutputLine[] {
  const progressLines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const total = progressLines.length
  // Collapsed: no content preview. The header carries the line count and,
  // for a multiline body, the expand hint; no extra row.
  const count = `${total} ${total === 1 ? 'line' : 'lines'}`
  const header = `${toolGlyph(name).icon} ${name}  · ${expanded || total <= 1 ? count : `${count} ${EXPAND_HINT}`}`
  const lines: OutputLine[] = [{ id: genId('tool'), kind: 'tool', text: header }]
  if (expanded) {
    // Expanded: full progress body + collapse hint.
    for (const l of progressLines) {
      lines.push({ id: genId('tool-res'), kind: 'tool_result', text: `  ${l}` })
    }
    if (progressLines.length > 1) {
      lines.push(toolHintLine(`  [2m${COLLAPSE_HINT}[0m`))
    }
    return lines
  }
  if (total <= 1) {
    lines.push({ id: genId('tool-res'), kind: 'tool_result', text: `  ${progressLines[0] ?? ''}` })
  }
  return lines
}

export function buildVerboseEvent(eventText: string): OutputLine[] {
  if (!eventText) return []
  return eventText.split('\n').map((line) => ({
    id: genId('verb'),
    kind: 'verbose' as const,
    text: line,
  }))
}

/** True for events that must always reach the TUI: LLM errors/retries,
 *  significant prompt-cache misses, and compactions that actually changed
 *  context. Per-call/no-op stats remain in screen.log only. */
export function isVisibleEvent(text: string): boolean {
  return /^\[LLM\]\s+[↻✗⚠]/u.test(text)
    || /^\[COMPACT\]\s+✓\s+·\s+(?!skipped\b)/u.test(text)
    // Only a prune that changed the context is a card; a judge round that
    // merely recorded verdicts is bookkeeping and stays in the log.
    || /^\[JEV\]\s+✂/u.test(text)
}

/**
 * Render a visible LLM event (error / retry / cache-miss notice) as a
 * tool-style card so it reads like any other tool in the stream:
 *   ✦ llm  <model|retry|cache miss …>
 *     ✗|↻|⚠ · <meta>
 *     <error message>
 * Falls back to plain verbose lines if the text isn't in the expected shape.
 */
export function buildLlmCard(text: string): OutputLine[] {
  const rawLines = text.split('\n')
  const head = (rawLines[0] ?? '').match(/^\[LLM\]\s+([↻✗⚠])\s*·?\s*(.*)$/u)
  if (!head) return buildVerboseEvent(text)
  const mark = head[1]!
  const rest = (head[2] ?? '').trim()
  const isRetry = mark === '↻'
  // Body: drop the `    error     ` label, keep the message text.
  const body = rawLines.slice(1)
    .map((l) => l.replace(/^\s*error\s+/u, '').trim())
    .filter((l) => l.length > 0)

  // Privacy stopped the request before it left: say that, not "invalid request".
  const privacy = mark === '✗' ? parsePrivacyStop(body.join(' ')) : null
  if (privacy) return buildPrivacyCard(privacy)

  const lines: OutputLine[] = []
  if (isRetry) {
    lines.push({ id: genId('tool'), kind: 'tool', text: '✦ llm  retry' })
    lines.push({ id: genId('tool'), kind: 'tool', text: `  ${mark} · ${rest}` })
  } else {
    const parts = rest.split(' · ')
    const model = parts[0] ?? 'unknown'
    const meta = parts.slice(1).join(' · ')
    lines.push({ id: genId('tool'), kind: 'tool', text: `✦ llm  ${model}` })
    lines.push({ id: genId('tool'), kind: 'tool', text: `  ${mark}${meta ? ` · ${meta}` : ''}` })
  }
  for (const b of body) {
    const failure = providerFailurePresentation({ error: b })
    lines.push({ id: genId('tool-res'), kind: 'error', text: `  ${failure.label}` })
  }
  return stampToolCard(lines, mark === '✗' ? 'error' : isRetry ? 'pending' : 'success')
}

/**
 * Split a runtime event summary into the one figure that belongs on the
 * headline and the metadata that belongs on the status row below it.
 *
 * Every runtime card (`jev prune`, `compact`, `llm`) takes the same shape as a
 * tool card: `<glyph> <name>  <arg>` then `  ✓ · <meta>`. For context work the
 * arg is the token transition (`70k → 63k`), the number the user scans for;
 * the counts and the trigger are detail and go on the status row. The
 * message-count transition and the parenthesised saving are dropped from the
 * card: both repeat what the token transition and the context bar already
 * say, and both remain in the verbose log.
 */
function splitEventSummary(head: string): { arg: string; meta: string[] } {
  const parts = head.split(' · ').map(part => part.trim()).filter(part => part.length > 0)
  const tokensIndex = parts.findIndex(part => /^\S+ → \S+(?: \(−\S+\))?$/u.test(part) && !part.endsWith('msgs'))
  if (tokensIndex < 0) return { arg: '', meta: parts }
  const arg = parts[tokensIndex]!.replace(/\s*\(−\S+\)$/u, '')
  const meta = parts.filter((part, index) => index !== tokensIndex && !part.endsWith(' msgs'))
  return { arg, meta }
}

function eventHeadline(glyph: string, name: string, arg: string): OutputLine {
  return { id: genId('tool'), kind: 'tool', text: arg ? `${glyph} ${name}  ${arg}` : `${glyph} ${name}` }
}

function eventStatus(mark: string, meta: string[]): OutputLine {
  return { id: genId('tool'), kind: 'tool', text: meta.length > 0 ? `  ${mark} · ${meta.join(' · ')}` : `  ${mark}` }
}

/** The context gauge row without the saving the headline already states. */
function eventContextRow(line: string): OutputLine {
  const body = line.replace(/^\s*context\s*/u, '').replace(/\s*\(−\S+\)(\s*·\s*jev prune)?\s*$/u, '').trim()
  return { id: genId('tool-res'), kind: 'tool_result', text: `  ${body}` }
}

export function buildEventCard(text: string): OutputLine[] {
  if (text.startsWith('[JEV]')) {
    // Judge prune: the header and the context line are the card; per-call
    // verdicts stay in the verbose log where they can be studied.
    const rawLines = text.split('\n')
    const applied = /^\[JEV\]\s+✂/u.test(rawLines[0] ?? '')
    const head = (rawLines[0] ?? '').replace(/^\[JEV\]\s+[✂·]?\s*·?\s*/u, '').trim()
    const { arg, meta } = splitEventSummary(head)
    const lines: OutputLine[] = [
      eventHeadline(applied ? '✂' : '⚖', applied ? 'jev prune' : 'jev judge', arg),
      eventStatus(applied ? '✓' : '·', meta),
    ]
    const context = rawLines.slice(1).find(line => /^\s*context\s/u.test(line))
    if (context) lines.push(eventContextRow(context))
    return stampToolCard(lines, 'success')
  }
  if (text.startsWith('[COMPACT]')) {
    const rawLines = text.split('\n')
    const head = (rawLines[0] ?? '').replace(/^\[COMPACT\]\s+✓\s*·?\s*/u, '').trim()
    const { arg, meta } = splitEventSummary(head)
    const lines: OutputLine[] = [eventHeadline('✦', 'compact', arg), eventStatus('✓', meta)]
    for (const line of rawLines.slice(1)) {
      if (/^\s*context\s/u.test(line)) {
        lines.push(eventContextRow(line))
        continue
      }
      const body = line.replace(/^\s*(summary|fallback)\s*/u, '').trim()
      if (body) lines.push({ id: genId('tool-res'), kind: 'tool_result', text: `  ${body}` })
    }
    return stampToolCard(lines, 'success')
  }
  return buildLlmCard(text)
}

/**
 * A privacy stop as a tool-style card:
 *   ⊘ privacy  blocked request
 *     ✗ · nothing was sent to the model · PRIVATE_KEY
 *     <why> / <the command that undoes it>
 */
export function buildPrivacyCard(stop: PrivacyStop): OutputLine[] {
  const card = privacyCard(stop)
  const lines: OutputLine[] = [{ id: genId('tool'), kind: 'tool', text: `⊘ privacy  ${card.title}` }]
  for (const row of card.rows) {
    const kind = row.tone === 'status' ? 'tool' : row.tone === 'error' ? 'error' : 'tool_result'
    lines.push({ id: genId(row.tone === 'status' ? 'tool' : 'tool-res'), kind, text: `  ${row.text}` })
  }
  return stampToolCard(lines, 'error')
}

export function buildError(message: string): OutputLine[] {
  return [{ id: genId('err'), kind: 'error', text: `Error: ${message}` }]
}

export function buildSystem(text: string): OutputLine[] {
  return [{ id: genId('sys'), kind: 'system', text }]
}

// ---------------------------------------------------------------------------
// Convert UIMessages to OutputLines (for resume)
// ---------------------------------------------------------------------------

function buildCompactionLines(compaction: UICompaction, expanded: boolean): OutputLine[] {
  const messagesEvicted = Math.max(0, compaction.messagesBefore - compaction.messagesAfter)
  const details = formatCompactionCompleted({
    reason: compaction.reason,
    result: {
      type: 'compacted',
      before_message_count: compaction.messagesBefore,
      after_message_count: compaction.messagesAfter,
      before_tokens: compaction.tokensBefore,
      after_tokens: compaction.tokensAfter,
      messages_evicted: messagesEvicted,
      current_run_reclaimed: 0,
      method: compaction.method,
      remote_blob_bytes: compaction.remoteBlobBytes,
      fallback_reason: compaction.fallbackReason,
    },
  })
  const lines = buildEventCard(details)
  if (!compaction.summary.trim()) return lines
  if (expanded) return [...lines, ...buildAssistantLines(compaction.summary)]
  return [
    ...lines,
    toolHintLine('  ... summary hidden (ctrl+o to expand)'),
  ]
}

/** The `    error     <msg>` tail an LLM event card carries, if any. */
export function errorTailOf(text: string): string | null {
  const m = text.match(/\n\s*error\s+([\s\S]+)$/u)
  return m ? m[1]!.trim() : null
}

/**
 * Drop an event's error tail when the card above already printed that sentence.
 *
 * A failed attempt and the retry that follows it carry the same provider
 * message, so the pair said one thing twice. The retry line keeps the part only
 * it knows — the countdown and the attempt counter.
 */
export function withoutRedundantErrorTail(text: string, known: string | null): string {
  if (!known) return text
  const tail = errorTailOf(text)
  if (tail === null || tail !== known) return text
  return text.replace(/\n\s*error\s+[\s\S]+$/u, '')
}

export function messagesToOutputLines(messages: UIMessage[], expanded: boolean = false): OutputLine[] {
  const lines: OutputLine[] = []
  for (const msg of messages) {
    if (msg.compaction) {
      lines.push(...buildCompactionLines(msg.compaction, expanded))
      continue
    }
    if (msg.role === 'system') {
      lines.push({ id: genId('system'), kind: 'system', text: msg.text })
      continue
    }
    if (msg.role === 'user') {
      const userLines = buildUserMessage(msg.text, msg.timestamp)
      // Replay uses zero for unavailable timestamps. Never display epoch time
      // (08:00 AM in UTC+8) as though the user sent their message then.
      if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) {
        for (const line of userLines) delete line.timestamp
      }
      lines.push(...userLines)
      continue
    }

    // Replay the same always-visible event cards as the live stream — which
    // means collapsing a retry storm the same way. The live path drops the
    // repeats before they reach scrollback; a stored transcript still holds
    // every attempt, so resuming a session would bring the wall of duplicate
    // 529s back. Rendering is the only thing filtered here: the events stay in
    // the transcript, so no stored data changes meaning.
    if (msg.verboseEvents) {
      let retryCardShown = false
      let lastErrorShown: string | null = null
      for (const evt of msg.verboseEvents) {
        const isRetry = evt.kind === 'llm_retry'
        const isFailedCall = evt.kind === 'llm_completed' && /^\[LLM\]\s+✗/u.test(evt.text)
        if (isRetry || isFailedCall) {
          if (retryCardShown) continue
          if (isRetry) retryCardShown = true
        } else {
          // Anything else — a successful call, a compaction — ends the storm,
          // so a later independent failure is announced rather than swallowed.
          retryCardShown = false
          lastErrorShown = null
        }
        if (!isVisibleEvent(evt.text)) continue
        const text = withoutRedundantErrorTail(evt.text, lastErrorShown)
        lines.push(...buildEventCard(text))
        lastErrorShown = errorTailOf(evt.text) ?? lastErrorShown
      }
    }

    if (msg.content) {
      for (const block of [...msg.content].sort((a, b) => a.contentIndex - b.contentIndex)) {
        if (block.type === 'thinking') {
          lines.push(...buildThinkingLines(block.text, { expanded }))
        }
        else if (block.type === 'text') lines.push(...buildAssistantLines(block.text))
        else lines.push(...buildToolCard(block.toolCall))
      }
    } else if (msg.text.trim()) {
      // Legacy UI messages created before ordered assistant content existed.
      lines.push(...buildAssistantLines(msg.text))
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Code-block-aware split (inspired by qwen-code's markdownUtilities)
// ---------------------------------------------------------------------------

/**
 * Check if a character index falls inside an unclosed fenced code block.
 */
function isInsideCodeBlock(content: string, index: number): boolean {
  let fenceCount = 0
  let pos = 0
  while (pos < content.length) {
    const next = content.indexOf('```', pos)
    if (next === -1 || next >= index) break
    fenceCount++
    pos = next + 3
  }
  return fenceCount % 2 === 1
}

/**
 * Find the last safe split point in `content` — a position where we can
 * cut without breaking a code block.  Prefers `\n\n` (paragraph boundary),
 * falls back to `\n`.  Returns `content.length` when no safe split exists.
 */
export function findSafeSplitPoint(content: string): number {
  // If the tail is inside an unclosed code block, don't split at all.
  if (isInsideCodeBlock(content, content.length)) return content.length

  // Prefer paragraph boundary (\n\n) not inside a code block.
  let search = content.length
  while (search >= 0) {
    const idx = content.lastIndexOf('\n\n', search)
    if (idx === -1) break
    const splitAt = idx + 2
    if (!isInsideCodeBlock(content, splitAt)) return splitAt
    search = idx - 1
  }

  // Fall back to last single newline not inside a code block.
  const nlPos = content.lastIndexOf('\n')
  if (nlPos > 0 && !isInsideCodeBlock(content, nlPos + 1)) return nlPos + 1

  return content.length
}

// ---------------------------------------------------------------------------
// AssistantStreamBuffer — accumulates streaming tokens, emits lines
// ---------------------------------------------------------------------------

export class AssistantStreamBuffer {
  private buffer = ''
  private started = false

  /** Push a token. Returns OutputLines to append (may be empty). */
  push(token: string): OutputLine[] {
    if (!token) return []
    this.buffer += token

    if (!this.started) {
      this.buffer = this.buffer.replace(/^[\n\r]+/, '')
      if (this.buffer.length === 0) return []
      this.started = true
    }

    return this.flushSafe()
  }

  /** Flush remaining buffer. Returns OutputLines to append. */
  finish(): OutputLine[] {
    if (!this.started) return []
    const result: OutputLine[] = []
    if (this.buffer.trim().length > 0) {
      result.push(...buildAssistantLines(this.buffer))
    }
    this.buffer = ''
    this.started = false
    return result
  }

  /** The current incomplete text (for display in dynamic zone). */
  get pendingText(): string {
    return this.started ? this.buffer : ''
  }

  get isStarted(): boolean {
    return this.started
  }

  /**
   * Flush completed content using code-block-aware splitting.
   * Only the portion before the safe split point is rendered and emitted;
   * the rest stays in the buffer for the dynamic zone.
   */
  private flushSafe(): OutputLine[] {
    if (!this.buffer.includes('\n')) return []

    const splitAt = findSafeSplitPoint(this.buffer)
    if (splitAt === this.buffer.length || splitAt === 0) return []

    const completeText = this.buffer.slice(0, splitAt)
    this.buffer = this.buffer.slice(splitAt)

    return buildAssistantLines(completeText)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAskUserTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/_/g, '')
  return normalized === 'askuser'
}

function isScheduleWakeupTool(name: string): boolean {
  return name.toLowerCase().replace(/_/g, '') === 'schedulewakeup'
}

function buildLoopCard(call: UIToolCall, now: number): OutputLine[] {
  const args = call.args
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  const stop = args.stop === true
  const quiet = args.noop === true
  const line = (text: string): OutputLine => ({ id: genId('loop'), kind: 'tool', text })

  if (call.status === 'queued' || call.status === 'running') {
    return stampToolCard([line(stop ? '⏹ loop · stopping…' : '◌ loop · scheduling next wakeup…')], 'pending')
  }
  if (call.status === 'error') {
    const lines = [line('✗ loop · wakeup not scheduled')]
    const detail = typeof call.result === 'string' ? call.result.trim() : ''
    if (detail) lines.push(line(`  ${detail}`))
    return stampToolCard(lines, 'error')
  }

  const head = stop
    ? '⏹ loop · stopping'
    : `◌ loop${quiet ? ' · quiet' : ''} · ${loopNextWakeup(args, call.startedAt ?? now)}`
  const lines = [line(head)]
  if (reason) lines.push(line(`  ${reason}`))
  return stampToolCard(lines, 'success')
}

function loopNextWakeup(args: Record<string, unknown>, from: number): string {
  const requested = typeof args.delay_seconds === 'number' ? args.delay_seconds : NaN
  if (!Number.isFinite(requested)) return 'next wakeup scheduled'
  const seconds = Math.min(3600, Math.max(60, Math.round(requested)))
  return `next wakeup in ${formatElapsed(seconds * 1000)} (${formatWallClock(from + seconds * 1000)})`
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function parseJsonResult(content: string): unknown | undefined {
  const trimmed = content.trim()
  if (!trimmed) return undefined
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function asDetails(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function detailNumber(details: Record<string, unknown>, key: string): number | undefined {
  const value = details[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function detailString(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Status parts for a settled `task_output` / `task_stop` card.
 *
 * `● · running` alone was unreadable with several tasks in flight: it named
 * neither the task, its runtime, nor whether the poll actually returned
 * anything. The outcome leads, because that is what the next step depends on.
 */
function taskToolStatusParts(details: Record<string, unknown>): string[] {
  const status = detailString(details, 'status')
  const retrieval = detailString(details, 'retrieval_status')
  const exitCode = detailNumber(details, 'exit_code')
  const elapsedMs = detailNumber(details, 'elapsed_ms')
  const quietMs = detailNumber(details, 'quiet_ms')
  const lines = detailNumber(details, 'total_lines')
  const parts: string[] = []

  // Outcome first. A still-running task says so plainly rather than reporting
  // the poll as a success.
  switch (status) {
    case 'completed':
      parts.push(exitCode !== undefined ? `completed · exit ${exitCode}` : 'completed')
      break
    case 'failed':
      parts.push(exitCode !== undefined ? `failed · exit ${exitCode}` : 'failed')
      break
    case 'killed':
      // "cancelled" rather than "stopped" when it was the user's decision: the
      // work is void, not merely halted.
      parts.push(details.stopped_by_user === true ? 'cancelled by user' : 'stopped')
      break
    // `running` is `RunningBackground`; `running_foreground` is a shell still
    // being waited on. Both used to render as a bare "still running", which hid
    // the distinction that matters most to a user reading the card: whether the
    // work is now detached and safe to leave, or still holding a wait. The bash
    // card has always named the background; this one now agrees with it.
    case 'running':
      parts.push(runningInBackgroundLabel(retrieval, quietMs))
      break
    case 'running_foreground':
      // No "in background" here: this task really is still in the foreground.
      // The `timeout` clause is legacy for the same reason as above: replayed
      // transcripts still carry it, nothing new writes it.
      parts.push(retrieval === 'timeout' ? 'still running · wait timed out' : 'still running')
      break
    default:
      if (status) parts.push(status)
  }

  if (elapsedMs !== undefined) parts.push(formatElapsed(elapsedMs))
  if (lines !== undefined && lines > 0) parts.push(plural(lines, 'line'))
  return parts
}

/**
 * How a backgrounded task reads on a `task_output` card.
 *
 * "running in background" rather than a bare "still running", matching the bash
 * card and Claude Code: the useful fact is that the work is detached and the
 * turn is free, not merely that it has not finished.
 *
 * Only a hit deadline or a stall earns an extra clause. `released` and
 * `not_ready` both mean the same thing to someone reading the card — the task
 * is detached and this poll returned no result — and "running in background ·
 * stopped waiting" said that twice.
 */
function runningInBackgroundLabel(retrieval: string | undefined, quietMs?: number): string {
  // `timeout` is a legacy value: waits are no longer cut short by a bound, so
  // nothing writes it any more. Tool-result details are persisted per
  // transcript, so sessions recorded before that change still replay through
  // here and must not render a bare, unexplained "running in background".
  if (retrieval === 'timeout') return 'running in background · wait timed out'
  // A stall is the runtime giving up on the task, not on the wait: the card
  // has to say why the model got the turn back with nothing to show.
  if (retrieval === 'stalled') {
    return quietMs !== undefined && quietMs > 0
      ? `running in background · stalled, quiet ${formatElapsed(quietMs)}`
      : 'running in background · stalled'
  }
  return 'running in background'
}

function resultLineCount(content: string): number {
  const normalized = content.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '')
  return normalized ? normalized.split('\n').length : 0
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function readLineSummary(content: string): string | undefined {
  const firstLine = content.replace(/\r\n|\r/g, '\n').split('\n', 1)[0] ?? ''
  const full = /^\[(\d+) lines?\]$/.exec(firstLine)
  if (full) return plural(Number(full[1]), 'line')
  const range = /^\[Lines \d+-\d+ of (\d+)\]$/.exec(firstLine)
  return range ? plural(Number(range[1]), 'line') : undefined
}

function resultProtocolLines(content: string): string[] {
  return content.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '').split('\n')
}

function isIncompleteResultLine(line: string): boolean {
  return /^\.\.\. \((?:capped|search timed out|truncated)\b/.test(line)
}

function grepResultSummary(args: Record<string, unknown>, result: string): string | undefined {
  const lines = resultProtocolLines(result)
  const filesOnly = args.files_with_matches === true
  const noMatches = lines.length === 1 && /^\(no matches(?:;|\))/.test(lines[0] ?? '')
  if (noMatches) {
    const summary = filesOnly ? '0 files' : '0 matches'
    return `${summary}${lines[0]!.includes(';') ? ' shown' : ''}`
  }

  const incomplete = lines.some(isIncompleteResultLine)
  const contentLines = lines.filter(line => !isIncompleteResultLine(line))
  if (filesOnly) {
    if (contentLines.some(line => line === '--' || line.length === 0)) return undefined
    const count = contentLines.length
    return `${plural(count, 'file')}${incomplete ? ' shown' : ''}`
  }

  let matches = 0
  for (const line of contentLines) {
    if (line === '--') continue
    if (/^.+:\d+: /.test(line)) {
      matches++
      continue
    }
    if (/^.+-\d+- /.test(line)) continue
    return undefined
  }
  return `${plural(matches, 'match', 'matches')}${incomplete ? ' shown' : ''}`
}

function globResultSummary(args: Record<string, unknown>, result: string): string | undefined {
  const lines = resultProtocolLines(result)
  const type = typeof args.type === 'string' ? args.type : 'f'
  const noun = type === 'd' ? 'directory' : type === 'any' ? 'path' : 'file'
  const noMatches = lines.length === 1 && /^\(no matches(?:;|\))/.test(lines[0] ?? '')
  if (noMatches) {
    const summary = plural(0, noun, type === 'd' ? 'directories' : `${noun}s`)
    return `${summary}${lines[0]!.includes(';') ? ' shown' : ''}`
  }

  const incomplete = lines.some(isIncompleteResultLine)
  const contentLines = lines.filter(line => !isIncompleteResultLine(line))
  if (contentLines.some(line => line.length === 0)) return undefined
  const count = contentLines.length
  const summary = plural(count, noun, type === 'd' ? 'directories' : `${noun}s`)
  return `${summary}${incomplete ? ' shown' : ''}`
}

/**
 * Headline for a command that is in the background, naming *why*.
 *
 * "started" only fits the case where backgrounding was the plan. A command that
 * ran for its whole deadline, or that was moved aside so the user could talk,
 * did not merely start -- reading it that way hides both the wait that already
 * happened and the fact that the user's own keypress caused it.
 *
 * Unknown reasons fall back to the neutral wording: this string is written by
 * the engine, so an older or newer one must not render as an empty status.
 */
function backgroundedSummary(details: Record<string, unknown>): string {
  switch (detailString(details, 'background_reason')) {
    case 'timeout_elapsed':
      return 'still running · moved to background at its deadline'
    case 'yield_elapsed':
      return 'still running · moved to background'
    case 'user_requested':
      return 'still running · backgrounded by you'
    case 'message_delivery':
      return 'still running · backgrounded to read your message'
    default:
      return 'started · running in background'
  }
}

function toolResultSummary(
  name: string,
  args: Record<string, unknown>,
  result: string | undefined,
  details: Record<string, unknown>,
  isError = false,
): string {
  const normalizedName = name.toLowerCase()
  const bytes = detailNumber(details, 'bytes')
  const lines = result ? resultLineCount(result) : 0

  if (normalizedName === 'bash') {
    if (details.backgrounded === true) return backgroundedSummary(details)
    const exitCode = detailNumber(details, 'exit_code')
    if (exitCode !== undefined) return `exit ${exitCode}`
  }

  // Failures: status line stays short ("failed · exit N · 12ms"). The full
  // error body is auto-expanded below, so do not echo it again here.
  if (isError) {
    if (normalizedName === 'web_fetch' || normalizedName === 'webfetch') {
      const status = detailNumber(details, 'status')
      if (status !== undefined) return `HTTP ${status}`
    }
    if (normalizedName === 'edit' || normalizedName === 'file_edit'
      || normalizedName === 'write' || normalizedName === 'file_write'
      || normalizedName === 'read' || normalizedName === 'read_code') {
      const { display } = toolPathArg(args)
      if (!display || display.startsWith('path=')) return 'invalid path'
    }
    return ''
  }

  if (normalizedName === 'read' || normalizedName === 'read_code') {
    if (bytes !== undefined) return humanBytes(bytes)
    if (result) return readLineSummary(result) ?? plural(lines, 'line')
  }

  if (normalizedName === 'write' || normalizedName === 'file_write') {
    if (bytes !== undefined) return `${details.created === true ? 'created' : 'wrote'} ${humanBytes(bytes)}`
  }

  if (normalizedName === 'edit' || normalizedName === 'file_edit') {
    const replacements = detailNumber(details, 'replacement_count')
    const added = detailNumber(details, 'added_lines')
    const removed = detailNumber(details, 'removed_lines')
    const parts: string[] = []
    if (replacements !== undefined) parts.push(plural(replacements, 'replacement'))
    if (added !== undefined || removed !== undefined) parts.push(`+${added ?? 0} −${removed ?? 0}`)
    if (parts.length > 0) return parts.join(' · ')
  }

  if (normalizedName === 'search') {
    const hits = detailNumber(details, 'hits')
    if (hits !== undefined) return plural(hits, 'hit')
  }

  if (normalizedName === 'grep' && result) {
    const summary = grepResultSummary(args, result)
    if (summary) return summary
  }

  if (normalizedName === 'glob' && result) {
    const summary = globResultSummary(args, result)
    if (summary) return summary
  }

  if (normalizedName === 'web_fetch' || normalizedName === 'webfetch') {
    const status = detailNumber(details, 'status')
    if (status !== undefined) return `HTTP ${status}${lines > 1 ? ` · ${plural(lines, 'line')}` : ''}`
  }

  if (lines > 1) {
    return result
      ? `${plural(lines, 'line')} · ${humanBytes(Buffer.byteLength(result, 'utf-8'))}`
      : plural(lines, 'line')
  }
  return result ? humanBytes(Buffer.byteLength(result, 'utf-8')) : ''
}

function formatToolResultContent(content: string): string {
  const parsed = parseJsonResult(content)
  if (parsed === undefined) return content
  return JSON.stringify(parsed, null, 2)
}

/** Reason-style fields the model fills to justify a call. Rendered separately
 *  as ↳ lines and excluded from the generic arg list. */
function isReasonKey(key: string): boolean {
  return key === 'reason' || key.startsWith('reason_to_')
}

/** Human label for a reason field key. */
function reasonLabel(key: string): string {
  switch (key) {
    case 'reason':
      return 'reason'
    case 'reason_to_increase_timeout':
      return 'why longer timeout'
    case 'reason_to_use_instead_of_read_file_tool':
      return 'why not read'
    case 'reason_to_use_instead_of_edit_file_tool':
      return 'why not edit'
    case 'reason_to_use_instead_of_glob_files_tool':
      return 'why not glob'
    default:
      return key.replace(/^reason_to_/, 'why ').replace(/_/g, ' ')
  }
}

/** Build ↳ lines for any reason fields present, skipping empty or 'N/A'. */
function formatReasonLines(args: Record<string, unknown>): string[] {
  if (!args || typeof args !== 'object') return []
  const lines: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (!isReasonKey(k)) continue
    if (typeof v !== 'string') continue
    const val = v.trim()
    if (val === '' || val === 'N/A') continue
    lines.push(`↳ ${reasonLabel(k)}: ${truncate(val, 120)}`)
  }
  return lines
}
