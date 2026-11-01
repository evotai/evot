import { buildAssistantLines, buildThinkingLines, buildToolCard, type OutputLine } from './output.js'
import type { UIAssistantBlock } from '../term/app/types.js'

/**
 * Per-block render cache for the live (still-streaming) assistant message.
 *
 * The frame builder re-renders the whole live message on every paint — spinner
 * ticks, keystrokes, and stream deltas alike — and the Markdown pipeline
 * (lex → ANSI → wrap) dominates that cost as the message grows. The reducer
 * updates blocks immutably (a delta replaces only the block it touches), so
 * object identity is an exact dirty check: only blocks whose content actually
 * changed re-run the pipeline; finished thinking blocks and settled tool cards
 * are reused by reference.
 *
 * Values are keyed by render options and terminal width because rendering
 * wraps at width. Cached OutputLine objects are shared across frames and with
 * the commit path; they are treated as immutable everywhere.
 */
const blockLineCache = new WeakMap<UIAssistantBlock, { key: string; lines: OutputLine[] }>()

function renderColumns(): number {
  const columns = process.stdout.columns
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80
}

function renderBlockCached(
  block: UIAssistantBlock,
  expanded: boolean,
  streaming: boolean,
): OutputLine[] {
  const key = `${expanded ? 1 : 0}|${streaming ? 1 : 0}|${renderColumns()}`
  const hit = blockLineCache.get(block)
  if (hit && hit.key === key) return hit.lines

  // `expanded` is the one ctrl+o view toggle: it opens tool cards and lifts
  // the fold on long reasoning alike.
  const lines = block.type === 'thinking'
    ? buildThinkingLines(block.text, { streaming, expanded })
    : block.type === 'text'
      ? buildAssistantLines(block.text, { streaming })
      : buildToolCard(block.toolCall, expanded)
  blockLineCache.set(block, { key, lines })
  return lines
}

export function assistantMessageToOutputLines(
  content: UIAssistantBlock[],
  expandedTools = false,
  options: { streaming?: boolean } = {},
): OutputLine[] {
  return assistantContentToOutputLines(content, expandedTools, options)
}

/** Convert ordered assistant blocks to committed terminal output. */
export function assistantContentToOutputLines(
  content: UIAssistantBlock[],
  expandedTools = false,
  options: { streaming?: boolean } = {},
): OutputLine[] {
  const ordered = [...content].sort((a, b) => a.contentIndex - b.contentIndex)
  // Only the block still receiving deltas is streaming. Finished reasoning
  // keeps the same compact tail window. Timing belongs only in the final run
  // footer, not in a separate live status row or a committed thinking card.
  const streaming = options.streaming ?? false
  // Empty/whitespace deltas do not finish the visible thinking window.
  const last = ordered.findLastIndex(block => block.type === 'tool_call' || block.text.trim().length > 0)
  return ordered.flatMap((block, index) =>
    renderBlockCached(
      block,
      expandedTools,
      streaming && index === last,
    ),
  )
}

