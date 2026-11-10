import { nextToPlay, type Playable } from './playback.js'
import { line, plain, type StyledSpan, type ViewBlock } from './types.js'
import { renderMarkdown } from '../../render/markdown.js'
import { sliceVisibleAnsi, splitAnsiIntoCells, truncateAnsiToWidth, visibleGraphemeCount, visibleWidth } from '../../ui/wrap.js'
import { getTheme } from '../../ui/theme/index.js'

export interface AdContent {
  id: string
  kind: 'notice' | 'ad'
  priority?: number
  title: string
  body: string
}

/** Visual phase of the slot, driven by elapsed time. */
export type AdSlotPhase = 'entering' | 'steady' | 'erasing' | 'gone'

export interface AdSlotState {
  notices: AdContent[]
  ads: AdContent[]
  /** False until the first trigger; the slot stays hidden before that. */
  triggered: boolean
  currentId: string | null
  /** Epoch ms when the current content started showing. */
  shownAt: number
  /** Epoch ms when rotation is due. */
  rotationDueAt: number
  /**
   * Next content queued. While set, the current line erases away, holds blank
   * for AD_GAP_MS, then this item types itself in.
   */
  queuedId: string | null
  /** Granted (premium) model: the only thing it changes is that no ads play. */
  premium: boolean
  /**
   * Keys of items that have started playing. Recorded the moment an item
   * goes on screen, so quitting early still counts as seen. A notice's key
   * is its copy, an ad's key is its id: editing a notice plays it again, a
   * replay of unchanged copy never happens within a session. Resets on the
   * next launch, so each launch announces once.
   */
  played: Set<string>
}

export function campaignFingerprint(
  campaign: { id: string; kind: string; priority?: number; title: string; body: string },
): string {
  return `${campaign.id}\0${campaign.kind}\0${campaign.priority ?? 0}\0${campaign.title}\0${campaign.body}`
}

export interface AdSlotOptions {
  premium?: boolean
  /** Keys of items already played. See `AdSlotState.played`. */
  played?: Iterable<string>
}

// ---- timing (ms) -----------------------------------------------------------

/** How long one piece of content stays before rotating out. */
export const AD_STEADY_MS = 45_000
/** Enter animation length. */
export const AD_ENTER_MS = 400

export function createAdSlotState(
  notices: AdContent[],
  options: AdSlotOptions = {},
): AdSlotState {
  const premium = options.premium ?? false
  // Played items stay in the catalog: `nextToPlay` skips them, and the one
  // on screen must still resolve by id after a refresh or it would vanish.
  return {
    notices: notices.filter(n => n.kind === 'notice'),
    ads: premium ? [] : notices.filter(n => n.kind === 'ad'),
    triggered: false,
    currentId: null,
    shownAt: 0,
    rotationDueAt: 0,
    queuedId: null,
    premium,
    played: new Set(options.played ?? []),
  }
}

/** Notices key on their copy, so an edit is a new item; ads key on their id. */
function itemKey(content: AdContent): string {
  return content.kind === 'notice' ? campaignFingerprint(content) : content.id
}

function byId(state: AdSlotState, id: string | null): AdContent | null {
  if (!id) return null
  return state.notices.find(n => n.id === id) ?? state.ads.find(a => a.id === id) ?? null
}

/** Every item the slot can play, notices and ads alike, in one list. */
function playlist(state: AdSlotState): Playable[] {
  return [...state.notices, ...state.ads].map(item => ({ ...item, key: itemKey(item) }))
}

/** The next item to play, or null when everything has played. */
function nextItem(state: AdSlotState, exceptId?: string): AdContent | null {
  const next = nextToPlay(playlist(state), state.played, exceptId)
  return next ? byId(state, next.id) : null
}

/** Put `content` on screen. Going on screen is what counts as played. */
function pin(state: AdSlotState, content: AdContent, now: number): void {
  state.currentId = content.id
  state.shownAt = now
  state.rotationDueAt = now + AD_STEADY_MS
  state.played.add(itemKey(content))
}

/**
 * Frame hook driving the whole lifecycle:
 *   entering → steady → erasing → (gap) → next item entering → … → quiet
 * Hidden until the first trigger. Each item plays once, then the slot goes
 * quiet — nothing loops. A higher-priority item still waiting jumps the queue
 * through the same erase transition, so content never hard-cuts.
 */
export function tickAdSlot(state: AdSlotState, now: number): { content: AdContent | null; phase: AdSlotPhase; progress: number } {
  if (!state.triggered) return { content: null, phase: 'gone', progress: 0 }

  const content = byId(state, state.currentId)
  if (!content) {
    const next = nextItem(state)
    if (!next) return { content: null, phase: 'gone', progress: 0 }
    pin(state, next, now)
    return enterFrame(state, next, now)
  }

  // Erase-then-type transition when something is queued: the current text is
  // wiped one character at a time, holds blank for AD_GAP_MS, then the next
  // item types itself in.
  const queued = byId(state, state.queuedId)
  if (queued) {
    const elapsed = now - state.shownAt
    const eraseDoneAt = Math.max(1, visibleGraphemeCount(tickerText(content))) * ERASE_STEP_MS
    if (elapsed < eraseDoneAt) {
      return { content, phase: 'erasing', progress: 1 - elapsed / eraseDoneAt }
    }
    if (elapsed < eraseDoneAt + AD_GAP_MS) {
      // Blank beat between items so they don't run together.
      return { content, phase: 'erasing', progress: 0 }
    }
    state.queuedId = null
    pin(state, queued, now)
    return enterFrame(state, queued, now)
  }

  const settled = now - state.shownAt > AD_ENTER_MS * 3
  const rotationDue = now >= state.rotationDueAt
  // A higher-priority item still waiting plays next, but only once the
  // current line has settled so a just-typed line isn't yanked away.
  const pending = nextItem(state, content.id)
  const preempt = pending !== null && (pending.priority ?? 0) > (content.priority ?? 0) && settled
  if (rotationDue || preempt) {
    const followUp = nextItem(state)
    if (!followUp) {
      state.currentId = null
      state.queuedId = null
      return { content: null, phase: 'gone', progress: 0 }
    }
    // Start the erase on this frame; the transition completes on later ones.
    queueTransition(state, followUp.id, now)
    return { content, phase: 'erasing', progress: 1 }
  }

  const age = now - state.shownAt
  if (age <= AD_ENTER_MS) return { content, phase: 'entering', progress: age / AD_ENTER_MS }
  return { content, phase: 'steady', progress: Math.min(1, age / AD_STEADY_MS) }
}

/**
 * Called after tickAdSlot. Animate only while text changes; otherwise sleep
 * until rotation/preemption. Hidden slots have no timer and resume on the next
 * state-driven frame (overlay close, task completion, resize or catalog sync).
 */
export function nextAdSlotRenderDelay(
  state: AdSlotState,
  tick: ReturnType<typeof tickAdSlot>,
  now: number,
  visible: boolean,
): number | null {
  if (!visible || !tick.content || tick.phase === 'gone') return null
  const total = visibleGraphemeCount(tickerText(tick.content))
  const age = now - state.shownAt
  if (tick.phase === 'erasing') {
    const eraseEnd = Math.max(1, total) * ERASE_STEP_MS
    return age < eraseEnd ? Math.min(80, eraseEnd - age) : Math.max(1, eraseEnd + AD_GAP_MS - age)
  }
  let delay = Math.max(1, state.rotationDueAt - now)
  if (age < total * TYPE_STEP_MS) delay = Math.min(delay, 80, total * TYPE_STEP_MS - age)
  if (nextItem(state, tick.content.id)) {
    delay = Math.min(delay, Math.max(1, AD_ENTER_MS * 3 + 1 - age))
  }
  return delay
}

function enterFrame(state: AdSlotState, content: AdContent, now: number) {
  const age = now - state.shownAt
  if (age >= AD_ENTER_MS) return { content, phase: 'steady' as const, progress: age / AD_STEADY_MS }
  return { content, phase: 'entering' as const, progress: age / AD_ENTER_MS }
}

/** Queue a transition: erase the current line, then type the next content. */
function queueTransition(state: AdSlotState, nextId: string, now: number): void {
  state.queuedId = nextId
  state.shownAt = now   // reuse shownAt as the phase clock
}

/**
 * Publicly queue `id` as the next content. Used when a fresh campaign arrives
 * mid-session: whatever shows now erases away, then the new item types in.
 * No-op when the slot is not showing anything or `id` is already current.
 */
export function queueAdSlotTransition(state: AdSlotState, id: string, now = Date.now()): boolean {
  if (state.currentId === null || state.currentId === id) return false
  if (byId(state, id) === null) return false
  queueTransition(state, id, now)
  return true
}

/**
 * Event trigger: reveal the slot and start (or resume) the rotation. Called
 * after login and on task completion. Returns the content that will show.
 */
export function triggerAdSlot(state: AdSlotState, now: number): AdContent | null {
  // Something on screen keeps its clock. Turn ends and syncs re-trigger the
  // slot constantly; restarting or replacing the current item here would
  // retype it every time, or cut it short. Jumping the queue is the frame
  // hook's call, by priority.
  const resume = byId(state, state.currentId)
  if (resume) return resume
  // Otherwise start the next unplayed item. Nothing left means stay quiet:
  // there is no fallback to something that already played.
  const content = nextItem(state)
  if (!content) return null
  state.triggered = true
  state.queuedId = null
  pin(state, content, now)
  return content
}

// ---- typewriter (markdown body, types out then holds) ----------------------

/** How often one character is revealed, in ms. */
export const TYPE_STEP_MS = 35
/** How fast the eraser removes characters, in ms per character. */
export const ERASE_STEP_MS = 45
/** Blank pause between erasing one item and typing the next. */
export const AD_GAP_MS = 900

/** Title plus markdown body. Parsed as markdown, then flattened to one ticker
 *  line so the slot never grows past a single row. */
function sourceMarkdown(content: AdContent): string {
  const title = content.title.trim()
  const body = content.body.trim()
  if (title && body) return `${title}\n\n${body}`
  return title || body
}

const renderedCache = new Map<string, string>()

function renderedMarkdown(content: AdContent): string {
  const source = sourceMarkdown(content)
  if (!source) return ''
  const hit = renderedCache.get(source)
  if (hit !== undefined) return hit
  let rendered: string
  try {
    rendered = renderMarkdown(source, { blockSpacing: 'compact' })
  } catch {
    rendered = source
  }
  if (renderedCache.size > 64) {
    const first = renderedCache.keys().next().value
    if (first !== undefined) renderedCache.delete(first)
  }
  renderedCache.set(source, rendered)
  return rendered
}

function flattenToOneLine(rendered: string): string {
  return rendered
    .split(/\r\n|\r|\n/)
    .map(row => row.trimEnd())
    .filter(row => visibleWidth(row) > 0)
    .join('   \u00b7   ')
}

function tickerText(content: AdContent): string {
  return flattenToOneLine(renderedMarkdown(content))
}

function campaignWidth(content: AdContent): number {
  return visibleWidth(tickerText(content))
}

/** Characters visible at `now`, given when typing started. */
export function typedLength(shownAt: number, now: number): number {
  return Math.max(0, Math.floor((now - shownAt) / TYPE_STEP_MS))
}

function revealMarkdown(rendered: string, keep: number): string {
  const total = visibleGraphemeCount(rendered)
  if (keep <= 0) return ''
  if (keep >= total) return rendered
  return sliceVisibleAnsi(rendered, keep)
}

/**
 * Dark tints for the slot's dithered fill, derived from the theme's selection
 * hex so the band tracks light/dark without new theme fields. The spread is
 * deliberately narrow: enough texture to mark the slot as its own surface,
 * not enough to compete with the copy sitting on it.
 */
function bandTints(): string[] {
  const base = getTheme().selectionBgHex
  const r = Number.parseInt(base.slice(1, 3), 16)
  const g = Number.parseInt(base.slice(3, 5), 16)
  const b = Number.parseInt(base.slice(5, 7), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return [base]
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  const shift = (f: number) => `#${hex(r * f)}${hex(g * f)}${hex(b * f)}`
  return [shift(0.78), shift(0.88), shift(1), shift(0.92)]
}

/**
 * Deterministic per-column noise in [0,1).
 *
 * Hashed rather than random on purpose: the TUI repaints on every spinner tick
 * and keystroke, so a random field would crawl and flicker. The same column
 * always lands on the same tint, making the band hold still.
 */
function columnNoise(column: number): number {
  let x = Math.imul(column + 1, 2654435761)
  x ^= x >>> 15
  x = Math.imul(x, 2246822507)
  x ^= x >>> 13
  return (x >>> 0) / 4294967296
}

/**
 * Lay the ticker over a dithered band of `width` columns.
 *
 * Splitting into one span per column is what makes the fill possible: `bg`
 * wraps each cell last, so it survives the foreground colours markdown already
 * baked into the text, and trailing blanks get the same treatment as the copy.
 */
function bandSpans(rendered: string, width: number): StyledSpan[] {
  const tints = bandTints()
  const cells = splitAnsiIntoCells(rendered)
  const spans: StyledSpan[] = []
  for (let column = 0; column < width; column++) {
    const cell = cells[column]
    // Filler entries for the second half of a wide glyph carry no text; they
    // must not become a padded space or the row would drift a column.
    if (cell === '') continue
    const tint = tints[Math.floor(columnNoise(column) * tints.length)]
    spans.push({ text: cell ?? ' ', bg: tint })
  }
  return spans
}

/**
 * The slot: a single markdown ticker on a dithered band. Typed in character by
 * character, then held until rotation. Never wraps — overflow is truncated.
 */
export function buildAdSlotBlocks(
  state: AdSlotState,
  tick: { content: AdContent | null; phase: AdSlotPhase; progress: number },
  columns: number,
  now: number = Date.now(),
): ViewBlock[] {
  const { content, phase } = tick
  if (!content || phase === 'gone' || columns < 30) return []

  const innerWidth = Math.max(20, Math.min(
    [...state.notices, ...state.ads].reduce((max, campaign) => Math.max(max, campaignWidth(campaign)), 0) + 3,
    columns - 6,
  ))
  const rule = { text: '  ' + '─'.repeat(innerWidth), hex: getTheme().brandHex }

  const rendered = tickerText(content)
  const total = visibleGraphemeCount(rendered)
  let keep: number
  if (phase === 'erasing') {
    keep = Math.max(0, total - Math.floor((now - state.shownAt) / ERASE_STEP_MS))
  } else {
    keep = typedLength(state.shownAt, now)
  }
  const shown = truncateAnsiToWidth(revealMarkdown(rendered, keep), innerWidth - 1)

  return [{
    lines: [
      line(rule),
      line(plain('  '), ...bandSpans(shown, innerWidth)),
      line(rule),
    ],
    marginTop: 1,
  }]
}
