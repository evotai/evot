import type { SessionWithText, TranscriptItem } from '../../native/index.js'
import { replayUserInput } from '../../session/user-input.js'

/** UI-only enrichment, never serialized into the native/search wire contract. */
export interface SessionRecognition extends SessionWithText {
  recognition?: {
    /** First user turn, unclipped: the echo test compares against it. */
    opening?: string
    /** Newest-first user-visible turns, excerpted for the pane. */
    recent: { role: 'user' | 'assistant'; text: string }[]
  }
}

const RECENT_LIMIT = 6
const EXCERPT_CHARS = 2400
/** What the pane shows of each turn. Telling sessions apart needs the first
 *  sentences of the first and last request, not whole replies. */
const REQUEST_CHARS = 320
const ANSWER_CHARS = 480

function excerpt(text: string): string {
  const chars = Array.from(text.trim())
  return chars.length > EXCERPT_CHARS
    ? `${chars.slice(0, EXCERPT_CHARS).join('')}\n[Excerpt — resume session to read more]`
    : chars.join('')
}

/** First `cap` characters on one paragraph; the pane is for recognising a
 *  session, resume is for reading it. */
function glimpse(text: string, cap: number): string[] {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim()
  const chars = Array.from(flat)
  return [chars.length > cap ? `${chars.slice(0, cap).join('').trimEnd()}…` : flat]
}

function visibleText(item: TranscriptItem, clip = true): { role: 'user' | 'assistant'; text: string } | undefined {
  if (item.type === 'user' && typeof item.text === 'string') {
    if (item.text.startsWith('The conversation history before this')) return undefined
    const text = replayUserInput(item).filter(part => part.kind === 'user').map(part => part.text).join('\n').trim()
    return text ? { role: 'user', text: clip ? excerpt(text) : text } : undefined
  }
  if (item.type !== 'assistant') return undefined
  const blocks = Array.isArray(item.content) ? item.content : item.content_blocks
  if (!Array.isArray(blocks)) return undefined
  // Only user-visible answer text. Thinking, tool inputs/results and system
  // messages are not a summary and must not leak into the recognition pane.
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('').trim()
  return text ? { role: 'assistant', text: excerpt(text) } : undefined
}

export function enrichSessionRecognition(session: SessionWithText, transcript: TranscriptItem[]): SessionRecognition {
  let opening: string | undefined
  for (const item of transcript) {
    if (item.type !== 'user') continue
    const entry = visibleText(item, false)
    if (entry) {
      opening = entry.text
      break
    }
  }
  const recent: NonNullable<SessionRecognition['recognition']>['recent'] = []
  for (let index = transcript.length - 1; index >= 0 && recent.length < RECENT_LIMIT; index--) {
    const entry = visibleText(transcript[index]!)
    if (entry) recent.push(entry)
  }
  return { ...session, recognition: { opening, recent } }
}

/**
 * Recognition order: what the session was asked first, where it left off,
 * then a glimpse of the last answer. The two requests are what tells one
 * session from another; a long reply pushed them below the fold. Each turn
 * appears once — a single-turn session shows its only request rather than the
 * same sentence twice under two headings.
 */
export function recognitionSections(session: SessionRecognition): string[] {
  const detail = session.recognition
  if (!detail) return []
  const latestUser = detail.recent.find(entry => entry.role === 'user')
  const answer = detail.recent.find(entry => entry.role === 'assistant')
  const request = latestUser ?? (detail.opening ? { role: 'user' as const, text: detail.opening } : undefined)
  // In a one-turn session the opening *is* the latest request, and in a long one
  // the request is a clipped prefix of it. Prefix-inclusion settles both without
  // tracking whether either side was cut.
  const openingPrefix = detail.opening ? Array.from(detail.opening).slice(0, EXCERPT_CHARS).join('') : ''
  const openingIsRequest = Boolean(openingPrefix) && Boolean(request?.text.includes(openingPrefix))

  const lines: string[] = []
  if (detail.opening) lines.push('# Started with', `› ${glimpse(detail.opening, REQUEST_CHARS)[0]}`, '')
  if (request && !openingIsRequest) lines.push('# Latest request', `› ${glimpse(request.text, REQUEST_CHARS)[0]}`, '')
  if (answer) lines.push('# Latest response', ...glimpse(answer.text, ANSWER_CHARS), '')
  if (lines.length === 0) lines.push('# Conversation', 'No user requests or assistant responses yet.')
  return lines
}
