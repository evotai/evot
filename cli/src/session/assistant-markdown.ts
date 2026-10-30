/**
 * Shared helpers for locating the most recent assistant markdown source
 * from committed OutputLines. Used by /clip copy and /log shot.
 */

export interface AssistantMarkdownLine {
  kind: string
  id?: string
  rawMarkdown?: string
  /** Already-painted terminal text (ANSI). Present on live history lines. */
  text?: string
  isContinuationSpacer?: boolean
  zoneStart?: boolean
  zoneEnd?: boolean
}

export interface LastAssistantMarkdown {
  id?: string
  rawMarkdown: string
}

export interface LastAssistantTurn extends LastAssistantMarkdown {
  /** Number of streamed raw-markdown chunks joined into this turn. */
  chunkCount: number
}

/**
 * Last assistant turn as the TUI actually painted it: every assistant
 * OutputLine after the most recent user message (including continuation
 * spacers), in order. Prefer this over re-rendering joined rawMarkdown
 * when you need 1:1 wrap/layout fidelity with the screen.
 */
export interface LastAssistantPaintedTurn {
  lines: AssistantMarkdownLine[]
  /** Joined raw markdown (for metadata / offline re-render fallback). */
  rawMarkdown: string
  id?: string
  chunkCount: number
}

/**
 * Walk history newest-first and return the raw markdown of the last
 * assistant *chunk*. Returns null when none exists.
 *
 * Prefer {@link findLastAssistantTurn} when you need the full streamed
 * answer (multiple flush chunks joined).
 */
export function findLastAssistantMarkdown(
  lines: readonly AssistantMarkdownLine[],
): LastAssistantMarkdown | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.kind === 'assistant' && line.rawMarkdown && line.rawMarkdown.trim()) {
      return {
        id: line.id,
        rawMarkdown: line.rawMarkdown,
      }
    }
  }
  return null
}

/**
 * Reconstruct the last assistant *turn* as the user saw it: every distinct
 * rawMarkdown chunk committed after the most recent user message, joined in
 * order.
 *
 * Streaming flushes each paragraph as its own OutputLine group, each carrying
 * only that chunk's raw markdown. Taking the last chunk alone drops the rest
 * of the answer — this joins them back.
 */
export function findLastAssistantTurn(
  lines: readonly AssistantMarkdownLine[],
): LastAssistantTurn | null {
  if (!lines || lines.length === 0) return null

  let lastUser = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.kind === 'user') {
      lastUser = i
      break
    }
  }

  const chunks: string[] = []
  let lastRaw: string | undefined
  let firstId: string | undefined

  for (let i = lastUser + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.kind !== 'assistant') continue
    const raw = line.rawMarkdown
    if (!raw || !raw.trim()) continue
    if (raw === lastRaw) continue
    chunks.push(raw)
    lastRaw = raw
    if (!firstId) firstId = line.id
  }

  if (chunks.length === 0) return null
  return {
    id: firstId,
    rawMarkdown: joinMarkdownChunks(chunks),
    chunkCount: chunks.length,
  }
}

/**
 * Collect the last turn's assistant OutputLines exactly as committed to the
 * TUI history. These already embed markdown wrap/table layout from paint time;
 * re-running renderMarkdown on joined rawMarkdown can reflow them differently.
 */
export function findLastAssistantPaintedTurn(
  lines: readonly AssistantMarkdownLine[],
): LastAssistantPaintedTurn | null {
  if (!lines || lines.length === 0) return null

  let lastUser = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.kind === 'user') {
      lastUser = i
      break
    }
  }

  const painted: AssistantMarkdownLine[] = []
  const chunks: string[] = []
  let lastRaw: string | undefined
  let firstId: string | undefined

  for (let i = lastUser + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.kind !== 'assistant') continue
    painted.push(line)
    const raw = line.rawMarkdown
    if (raw && raw.trim() && raw !== lastRaw) {
      chunks.push(raw)
      lastRaw = raw
      if (!firstId) firstId = line.id
    } else if (!firstId && line.id) {
      firstId = line.id
    }
  }

  // Need either painted text or raw chunks to be useful.
  const hasText = painted.some(l => typeof l.text === 'string')
  if (!hasText && chunks.length === 0) return null
  if (painted.length === 0) return null

  return {
    lines: painted,
    rawMarkdown: joinMarkdownChunks(chunks),
    id: firstId,
    chunkCount: Math.max(chunks.length, 1),
  }
}

/** Join streamed raw-markdown flushes without gluing the last line of one
 *  chunk to the first line of the next when a trailing newline was stripped. */
export function joinMarkdownChunks(chunks: readonly string[]): string {
  if (chunks.length === 0) return ''
  if (chunks.length === 1) return chunks[0] ?? ''
  let out = ''
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] ?? ''
    if (i === 0) {
      out = c
      continue
    }
    if (out.length > 0 && !out.endsWith('\n')) out += '\n'
    out += c
  }
  return out
}
