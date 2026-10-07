import type { Hint } from './design/key-hints.js'

/** Prefix marking a preview body entry as a section label rather than content. */
export const PREVIEW_SECTION_PREFIX = '# '
/** Prefix marking a preview body entry as something that went wrong; the pane
 *  draws it in the alert colour instead of the section's normal contrast. */
export const PREVIEW_ALERT_PREFIX = '! '

export interface SelectorItem {
  /** In-flight domain action; disables action hints without parsing display copy. */
  pendingAction?: boolean
  renameTitle?: string
  label: string
  detail?: string
  /** Browse-row status, kept visible independently of title truncation. */
  status?: { text: string; tone?: 'muted' | 'success' | 'attention' | 'active' }
  /** Compact provenance label, independent of search match snippets. */
  badge?: string
  /** Skill package row; children stay searchable while collapsed. */
  expanded?: boolean
  /** Optional subordinate activity line, not a side-pane preview. */
  activity?: string
  /** Renders as a non-focusable group divider (e.g. a provider name). */
  header?: boolean
  /** Marks the active choice without mixing status into detail text. */
  selected?: boolean
  /** Marks the account's saved default (the row new sessions start on). */
  pinned?: boolean
  /** Opaque identifier (e.g. full session id) — not displayed. */
  id?: string
  /** Stable identity when `id` can change underneath a refresh (e.g. the
   * model id of a `provider:model` row whose provider group was renamed). */
  identity?: string
  /** Extra text searched but not displayed (e.g. full session id, cwd). */
  searchText?: string
  /** The row is a cloud session: deleting it removes the server copy too. */
  cloud?: boolean
  /** Hidden from the unfiltered list but included when its searchable text
   * matches a query. Resume uses this for sessions from another cwd. */
  searchOnly?: boolean
  /** When false, up/down navigation skips this item. Defaults to true. */
  focusable?: boolean
  /** Associates an item with a non-focusable group header. Filtering keeps the
   *  header whenever at least one item in the group matches. */
  group?: string
  /** Prefix retained when full-text filtering replaces detail with a snippet. */
  contextPrefix?: string
  /** Lines shown in the side pane while this row is focused. Entries before the
   *  first blank are the pinned header (first line is the heading); the rest is
   *  the body. Body entries starting with [`PREVIEW_SECTION_PREFIX`] label a
   *  section: the first section is pinned, the second is the trimmable list,
   *  later ones are optional. Rows without a preview render the list at full
   *  width. */
  preview?: string[]
  /** Footer hints shown while this row is focused, overriding the selector's.
   *  Rows advertise their own gestures so a key that would do nothing on this
   *  row is never offered. */
  hints?: Hint[]
  /** Row count for a `header` item. Present headers render as a bold label with
   *  a dim count (`Shells (2)`); absent, they render as a `── label ──` rule. */
  headerCount?: number
  /** Adjustable tier this row carries alongside its identity (model effort).
   *  Absent means the row has no such axis, so ←/→ are never offered on it. */
  effort?: SelectorEffort
}

/**
 * An ordered tier ladder attached to a row, adjusted in place with ←/→.
 *
 * `levels` are wire names in ascending order, exactly as the source published
 * them: the ladder is per-row, so a row whose model stops at `high` can never be
 * pushed to `max` by a gesture. `index` is the chosen tier, always a valid
 * position in `levels`.
 */
export interface SelectorEffort {
  levels: string[]
  index: number
}

/** The chosen tier's wire name, or undefined when the row has no ladder. */
export function selectorEffortLevel(item: SelectorItem | undefined): string | undefined {
  const effort = item?.effort
  return effort?.levels[effort.index]
}

/**
 * Move the focused row's tier by `delta`, clamped to the ladder's ends.
 *
 * Clamped rather than wrapping: ←/→ are a nudge along a scale a user can see,
 * and wrapping from `max` straight to `off` would commit the opposite of the
 * intent on one keypress. Returns the same state when there is no ladder or the
 * end is already reached, so a caller can treat "unchanged" as "not handled".
 *
 * The row is updated in both the visible list and the unfiltered pool, so a
 * tier survives typing, clearing a query, and async catalog refreshes.
 */
export function selectorAdjustEffort(state: SelectorState, delta: number): SelectorState {
  const focused = state.items[state.focusIndex]
  const effort = focused?.effort
  if (!focused || focused.header || !effort || effort.levels.length === 0) return state

  const index = Math.min(Math.max(effort.index + delta, 0), effort.levels.length - 1)
  if (index === effort.index) return state

  const key = focused.id ?? focused.label
  const retier = (items: SelectorItem[]) => items.map(item =>
    (item.id ?? item.label) === key && item.effort
      ? { ...item, effort: { ...item.effort, index } }
      : item)
  return { ...state, items: retier(state.items), allItems: retier(state.allItems) }
}

export interface SelectorRenameState {
  sessionId: string
  text: string
  cursor: number
  saving?: boolean
  error?: string
}

export interface SelectorState {
  /** Fixed-height scrollable details, independent of list navigation. */
  previewPane?: { offset: number; focused?: boolean; confirmDeleteKey?: string }
  rename?: SelectorRenameState
  /** Opaque host-owned identity. Generic navigation preserves but never interprets it. */
  owner?: symbol
  /** Session source scope, retained across navigation and async refreshes. */
  sessionScope?: 'all' | 'cloud'
  items: SelectorItem[]
  allItems: SelectorItem[]
  focusIndex: number
  /** First visible row. Moves only when focus walks past a window edge, so
   *  the list slides one row at a time instead of recentering (droid-style). */
  scrollOffset: number
  title: string
  /** Keep shortcut hints lowercase on session browsing/editing surfaces. */
  lowercaseHints?: boolean
  /** Optional secondary context displayed below the title. */
  subtitle?: string
  /** Model selection and live background output use dedicated editor-replacement
   * presentations instead of the generic titled selector. */
  presentation?: 'model' | 'skill' | 'background-list' | 'background-output' | 'browser'
  /** Ephemeral state for an output detail: undefined offset follows the tail. */
  outputView?: {
    scrollOffset?: number
    returnToPrompt?: boolean
  }
  /** Wraps up/down navigation between the first and last focusable items. */
  circularNavigation?: boolean
  /** Session id armed for deletion, awaiting a confirming second keypress.
   *  Keyed by id rather than index so an async list refresh or reorder cannot
   *  redirect the confirmation onto a different session. */
  pendingDeleteId?: string
  /** Footer hints for this selector. When set, they replace the generic
   *  move/select/filter/close line; a focused row's own `hints` win over these. */
  hints?: Hint[]
  /** Suppresses the filter line and type-to-search. Lists that reserve bare
   *  letters for actions opt out, so typing can never build a hidden query
   *  against a list with no visible filter. */
  noFilter?: boolean
  /** The list, rather than the filter input, owns keyboard focus. Command
   *  previews set this when an arrow promotes them into an active selector. */
  listFocused?: boolean
  /** Body text shown in place of the list when there are no rows. Replaces the
   *  generic "No matching items", which would describe a filter some lists
   *  do not have. */
  emptyMessage?: string
  /** What the filter searches, for its placeholder: "type to search <this>".
   *  Absent: the session list's wording. */
  searchHint?: string
  query: string
}

/** Rows visible at once in the selector window. Shared by movement logic and
 *  the renderer so scroll behavior and display stay in sync. */
export const SELECTOR_VIEWPORT = 10

/** Slide the window minimally so `focus` is visible: no jumps, no recentering. */
function ensureVisible(offset: number, focus: number, total: number): number {
  const maxOffset = Math.max(0, total - SELECTOR_VIEWPORT)
  let next = Math.min(Math.max(offset, 0), maxOffset)
  if (focus < next) next = focus
  else if (focus >= next + SELECTOR_VIEWPORT) next = focus - SELECTOR_VIEWPORT + 1
  return Math.min(next, maxOffset)
}

/** Find the first focusable index in items, defaulting to 0. */
function firstFocusable(items: SelectorItem[]): number {
  const idx = items.findIndex(i => i.focusable !== false)
  return idx >= 0 ? idx : 0
}

function lastFocusable(items: SelectorItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.focusable !== false) return i
  }
  return 0
}

function defaultVisibleItems(items: SelectorItem[]): SelectorItem[] {
  if (!items.some(item => item.searchOnly)) return items
  return pruneEmptyGroups(items.filter(item => !item.searchOnly))
}

export function createSelectorState(title: string, items: SelectorItem[], allItems?: SelectorItem[], initialQuery?: string): SelectorState {
  const all = allItems ?? items
  if (initialQuery) {
    return applyFilter({ items: defaultVisibleItems(items), allItems: all, focusIndex: 0, scrollOffset: 0, title, query: '' }, initialQuery)
  }
  const visible = defaultVisibleItems(items)
  const focusIndex = firstFocusable(visible)
  return { items: visible, allItems: all, focusIndex, scrollOffset: ensureVisible(0, focusIndex, visible.length), title, query: '' }
}

/**
 * Transfer keyboard focus from the filter input to the list.
 *
 * Preserve the preview's highlighted row as the starting point for navigation.
 * Callers apply the same key's movement after this focus transfer, so the first
 * arrow moves immediately from the active model rather than only blurring the
 * input. Only a focusIndex that is no longer selectable (an async refresh
 * dropped or reordered rows) falls back to the first selectable row.
 */
export function selectorFocusList(state: SelectorState): SelectorState {
  const current = state.items[state.focusIndex]
  const focusIndex = current && current.focusable !== false
    ? state.focusIndex
    : firstFocusable(state.items)
  return {
    ...state,
    listFocused: true,
    focusIndex,
    scrollOffset: ensureVisible(state.scrollOffset, focusIndex, state.items.length),
  }
}

/** Move focus to the first item matching `predicate`, keeping it visible. */
export function selectorFocusOn(state: SelectorState, predicate: (item: SelectorItem) => boolean): SelectorState {
  const idx = state.items.findIndex(i => i.focusable !== false && predicate(i))
  if (idx < 0) return state
  return { ...state, focusIndex: idx, scrollOffset: ensureVisible(state.scrollOffset, idx, state.items.length) }
}

export function selectorUp(state: SelectorState): SelectorState {
  let next = state.focusIndex - 1
  while (next >= 0 && state.items[next]?.focusable === false) next--
  if (next < 0) {
    if (!state.circularNavigation || state.items.length === 0) return state
    next = lastFocusable(state.items)
    if (state.items[next]?.focusable === false) return state
    return {
      ...state,
      focusIndex: next,
      scrollOffset: ensureVisible(Math.max(0, state.items.length - SELECTOR_VIEWPORT), next, state.items.length),
    }
  }
  // When only headers remain above, slide the window to the very top so the
  // leading group divider scrolls into view with its first model.
  const anyFocusableAbove = state.items.slice(0, next).some(i => i.focusable !== false)
  const target = anyFocusableAbove ? next : 0
  return { ...state, focusIndex: next, scrollOffset: ensureVisible(state.scrollOffset, target, state.items.length) }
}

export function selectorDown(state: SelectorState): SelectorState {
  let next = state.focusIndex + 1
  while (next < state.items.length && state.items[next]?.focusable === false) next++
  if (next >= state.items.length) {
    if (!state.circularNavigation || state.items.length === 0) return state
    next = firstFocusable(state.items)
    if (state.items[next]?.focusable === false) return state
    // Include a leading group header when wrapping back to its first model.
    const target = state.items.slice(0, next).some(i => i.focusable !== false) ? next : 0
    return { ...state, focusIndex: next, scrollOffset: ensureVisible(0, target, state.items.length) }
  }
  return { ...state, focusIndex: next, scrollOffset: ensureVisible(state.scrollOffset, next, state.items.length) }
}

export function selectorSelect(state: SelectorState): SelectorItem | null {
  return state.items[state.focusIndex] ?? null
}

export function selectorType(state: SelectorState, char: string): SelectorState {
  const query = state.query + char
  return applyFilter({ ...state, listFocused: false }, query)
}

export function selectorBackspace(state: SelectorState): SelectorState {
  if (state.query.length === 0) return state
  const query = state.query.slice(0, -1)
  return applyFilter({ ...state, listFocused: false }, query)
}

export function selectorExpandItems(state: SelectorState, allItems: SelectorItem[]): SelectorState {
  // Replacing the pool can reorder or drop rows, so any armed delete is
  // dropped: the confirming keypress must never land on a different session.
  const focused = state.items[state.focusIndex]
  const updated = { ...state, allItems, pendingDeleteId: undefined, subtitle: undefined }
  const visible = defaultVisibleItems(allItems)
  const next = state.query
    ? applyFilter(updated, state.query)
    : {
        ...updated,
        items: visible,
        focusIndex: firstFocusable(visible),
        scrollOffset: ensureVisible(updated.scrollOffset, firstFocusable(visible), visible.length),
      }
  if (!focused || focused.header) return next
  // Keep the row the user was looking at across an async catalog refresh.
  const exact = selectorFocusOn(next, item => focused.id ? item.id === focused.id : item.label === focused.label)
  if (exact !== next || !focused.identity) return exact
  // The exact row is gone, but the same thing may be listed under a new id
  // (a catalog regrouped its providers). Follow it rather than jumping to
  // the top, where Enter would pick something the user never looked at.
  return selectorFocusOn(next, item => item.identity === focused.identity)
}

/** Replace one row in both the visible list and the unfiltered pool. */
export function selectorReplaceItem(
  state: SelectorState,
  id: string,
  nextItem: SelectorItem,
): SelectorState {
  const replace = (items: SelectorItem[]) => items.map(item => item.id === id ? nextItem : item)
  return { ...state, items: replace(state.items), allItems: replace(state.allItems) }
}

export function selectorClearQuery(state: SelectorState): SelectorState {
  if (!state.query) return state
  return applyFilter(state, '')
}

export function selectorRemoveItem(state: SelectorState, index: number): SelectorState {
  const target = state.items[index]
  if (!target || target.header) return state
  const key = target.id ?? target.label
  const allItems = pruneEmptyGroups(state.allItems.filter(item => (item.id ?? item.label) !== key))
  // Removal consumes the armed delete; a later keypress must re-arm.
  const cleared = { ...state, pendingDeleteId: undefined }
  if (cleared.query) return applyFilter({ ...cleared, allItems }, cleared.query)

  const items = defaultVisibleItems(allItems)
  let focusIndex = Math.min(index, Math.max(0, items.length - 1))
  while (focusIndex < items.length && items[focusIndex]?.focusable === false) focusIndex++
  if (focusIndex >= items.length) focusIndex = lastFocusable(items)
  return { ...cleared, items, allItems, focusIndex, scrollOffset: ensureVisible(cleared.scrollOffset, focusIndex, items.length) }
}

function pruneEmptyGroups(items: SelectorItem[]): SelectorItem[] {
  const populatedGroups = new Set(items.flatMap(item => !item.header && item.group ? [item.group] : []))
  return items.filter(item => !item.header || !item.group || populatedGroups.has(item.group))
}

/**
 * Lowercased searchable text, cached per item.
 *
 * Resume rows carry whole transcripts in `searchText`. Lowercasing all of them
 * on every keystroke is what made typing in the filter feel sluggish once a
 * project had a large history, so the conversion is done once per item and
 * reused for later keystrokes. Keyed weakly, so cached strings are released
 * with the items themselves.
 */
const searchableTextCache = new WeakMap<SelectorItem, string>()

function searchableText(item: SelectorItem): string {
  const cached = searchableTextCache.get(item)
  if (cached !== undefined) return cached
  const text = item.searchText
    ? item.searchText.toLowerCase()
    : `${item.label} ${item.detail ?? ''}`.toLowerCase()
  searchableTextCache.set(item, text)
  return text
}

/** Characters converted per slice while warming. Sized so one slice stays well
 *  inside a frame even on a slow machine. */
const WARM_CHARS_PER_SLICE = 400_000

/**
 * Pre-populate the search cache in background slices.
 *
 * Warming is not required for correctness — `searchableText` fills the cache on
 * demand — but doing it lazily put the whole conversion on whichever keystroke
 * happened to be first, which read as a stall right after the list loaded.
 * Slices yield to the event loop between batches so no single task blocks input.
 *
 * Returns a cancel function; call it when the list is closed or replaced.
 */
export function warmSearchableText(items: SelectorItem[]): () => void {
  let index = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const runSlice = () => {
    timer = undefined
    let converted = 0
    while (index < items.length && converted < WARM_CHARS_PER_SLICE) {
      const item = items[index++]!
      if (item.header) continue
      if (searchableTextCache.has(item)) continue
      converted += item.searchText?.length ?? 0
      searchableText(item)
    }
    if (index < items.length) timer = setTimeout(runSlice, 0)
  }

  timer = setTimeout(runSlice, 0)
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    index = items.length
  }
}

function isSubsequence(text: string, query: string): boolean {
  let j = 0
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] === query[j]) j++
  }
  return j === query.length
}

/** Split a free-text filter into whitespace-separated keywords. */
function queryTokens(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean)
}

/** True when every token is a substring of `text` (already lowercased). */
function matchesAllTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  return tokens.every(token => text.includes(token))
}

function extractContext(source: string, lower: string, query: string, width: number): string | null {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return null

  // Prefer a snippet around the first multi-token hit; fall back to the first
  // individual token so multi-keyword filters still surface useful context.
  let idx = -1
  let matchLen = 0
  if (tokens.length === 1) {
    idx = lower.indexOf(tokens[0]!)
    matchLen = tokens[0]!.length
  } else {
    const joined = tokens.join(' ')
    idx = lower.indexOf(joined)
    matchLen = joined.length
    if (idx === -1) {
      for (const token of tokens) {
        const tokenIdx = lower.indexOf(token)
        if (tokenIdx !== -1) {
          idx = tokenIdx
          matchLen = token.length
          break
        }
      }
    }
  }
  if (idx === -1) return null
  const half = Math.floor((width - matchLen) / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(source.length, idx + matchLen + half)
  let snippet = source.slice(start, end).replace(/\n/g, ' ')
  if (start > 0) snippet = '…' + snippet
  if (end < source.length) snippet = snippet + '…'
  return snippet
}

function fuzzyMatchScore(query: string, text: string): number | null {
  const normalizedQuery = query.toLowerCase()
  const normalizedText = text.toLowerCase()
  if (normalizedQuery.length === 0) return 0
  if (normalizedQuery.length > normalizedText.length) return null

  let queryIndex = 0
  let score = 0
  let lastMatchIndex = -1
  let consecutiveMatches = 0
  for (let index = 0; index < normalizedText.length && queryIndex < normalizedQuery.length; index++) {
    if (normalizedText[index] !== normalizedQuery[queryIndex]) continue
    const atWordBoundary = index === 0 || /[\s\-_./:]/.test(normalizedText[index - 1]!)
    if (lastMatchIndex === index - 1) {
      consecutiveMatches++
      score -= consecutiveMatches * 5
    } else {
      consecutiveMatches = 0
      if (lastMatchIndex >= 0) score += (index - lastMatchIndex - 1) * 2
    }
    if (atWordBoundary) score -= 10
    score += index * 0.1
    lastMatchIndex = index
    queryIndex++
  }

  if (queryIndex < normalizedQuery.length) return null
  if (normalizedQuery === normalizedText) score -= 100
  return score
}

function modelFuzzyScore(query: string, item: SelectorItem): number | null {
  const tokens = query.trim().split(/[\s/]+/).filter(Boolean)
  if (tokens.length === 0) return 0
  const text = item.searchText ?? `${item.label} ${item.detail ?? ''}`
  let total = 0
  for (const token of tokens) {
    const primary = fuzzyMatchScore(token, text)
    if (primary !== null) {
      total += primary
      continue
    }
    const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/i.exec(token)
    const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/i.exec(token)
    const swapped = alphaNumeric
      ? `${alphaNumeric.groups?.digits ?? ''}${alphaNumeric.groups?.letters ?? ''}`
      : numericAlpha
        ? `${numericAlpha.groups?.letters ?? ''}${numericAlpha.groups?.digits ?? ''}`
        : ''
    const swappedScore = swapped ? fuzzyMatchScore(swapped, text) : null
    if (swappedScore === null) return null
    total += swappedScore + 5
  }
  return total
}

function applyFilter(state: SelectorState, query: string): SelectorState {
  // Filtering reorders and hides rows, so an armed delete is always dropped.
  state = { ...state, pendingDeleteId: undefined }
  if (!query) {
    const items = defaultVisibleItems(state.allItems)
    const focusIndex = firstFocusable(items)
    return {
      ...state,
      query,
      items,
      focusIndex,
      scrollOffset: ensureVisible(0, focusIndex, items.length),
    }
  }

  if (state.presentation === 'model') {
    // Groups keep their configured order while filtering, so matches stay under
    // the heading they belong to.
    const groupOrder = new Map<string, number>()
    for (const item of state.allItems) {
      const group = item.group ?? ''
      if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size)
    }
    const matched = state.allItems
      .filter(item => !item.header)
      .map((item, index) => ({ item, index, score: modelFuzzyScore(query, item) }))
      .filter((entry): entry is { item: SelectorItem; index: number; score: number } => entry.score !== null)
      .sort((left, right) => {
        const leftGroup = groupOrder.get(left.item.group ?? '') ?? Number.MAX_SAFE_INTEGER
        const rightGroup = groupOrder.get(right.item.group ?? '') ?? Number.MAX_SAFE_INTEGER
        return leftGroup - rightGroup || left.score - right.score || left.index - right.index
      })
      .map(entry => entry.item)
    const filtered = insertGroupHeaders(state.allItems, matched)
    const focusIndex = firstFocusable(filtered)
    return { ...state, query, items: filtered, focusIndex, scrollOffset: ensureVisible(0, focusIndex, filtered.length) }
  }

  // Whitespace-separated keywords are AND-matched as independent substrings.
  // A single token still supports fuzzy subsequence matching for short labels
  // (e.g. model pickers without searchText).
  const tokens = queryTokens(query)
  const exact: SelectorItem[] = []
  const fuzzy: SelectorItem[] = []
  for (const item of state.allItems) {
    if (item.header) continue
    const text = searchableText(item)
    if (matchesAllTokens(text, tokens)) {
      exact.push(withContext(item, query))
    } else if (tokens.length === 1 && !item.searchText && isSubsequence(text, tokens[0]!)) {
      fuzzy.push(item)
    }
  }
  const matched = exact.concat(fuzzy)
  const filtered = restoreGroupHeaders(state.allItems, matched)
  const focusIndex = firstFocusable(filtered)
  return { ...state, query, items: filtered, focusIndex, scrollOffset: ensureVisible(0, focusIndex, filtered.length) }
}

function restoreGroupHeaders(allItems: SelectorItem[], matched: SelectorItem[]): SelectorItem[] {
  if (!matched.some(item => item.group)) return matched

  // Keyed lookup rather than a scan per row: `matched` holds thousands of rows
  // on a large history, and a nested find made restoring headers quadratic.
  const matchedByKey = new Map<string, SelectorItem>()
  for (const item of matched) matchedByKey.set(item.id ?? item.label, item)
  const matchedGroups = new Set(matched.flatMap(item => item.group ? [item.group] : []))
  return allItems.flatMap(item => {
    if (item.header) return item.group && matchedGroups.has(item.group) ? [item] : []
    if (item.expanded !== undefined && item.group && matchedGroups.has(item.group)) return [item]
    const hit = matchedByKey.get(item.id ?? item.label)
    return hit ? [hit] : []
  })
}

/** Insert group headings without reordering, so ranked matches keep their
 *  order. Groups are already contiguous when matches are sorted by group. */
function insertGroupHeaders(allItems: SelectorItem[], matched: SelectorItem[]): SelectorItem[] {
  if (!matched.some(item => item.group)) return matched

  const headers = new Map<string, SelectorItem>()
  for (const item of allItems) {
    if (item.header && item.group) headers.set(item.group, item)
  }

  const withHeaders: SelectorItem[] = []
  let current: string | undefined
  for (const item of matched) {
    if (item.group && item.group !== current) {
      current = item.group
      const header = headers.get(item.group)
      if (header) withHeaders.push(header)
    }
    withHeaders.push(item)
  }
  return withHeaders
}

/**
 * Attach the match snippet without building it up front.
 *
 * A filter can match thousands of rows while only about ten are ever drawn, so
 * cutting a snippet out of every matched transcript was pure waste on the
 * keystroke path. `detail` stays an ordinary readable property — computed on
 * first access and memoized — so callers and the renderer are unchanged.
 */
function withContext(item: SelectorItem, query: string): SelectorItem {
  if (!item.searchText) return item
  const clone: SelectorItem = { ...item }
  let resolved = false
  let value = item.detail
  Object.defineProperty(clone, 'detail', {
    enumerable: true,
    configurable: true,
    get(): string | undefined {
      if (!resolved) {
        resolved = true
        // The lowercased form was already built to match this row, so reuse it
        // rather than lowercasing a whole transcript again.
        const ctx = extractContext(item.searchText!, searchableText(item), query, 80)
        if (ctx) value = `${item.contextPrefix ?? ''}${ctx}`
      }
      return value
    },
    set(next: string | undefined) {
      resolved = true
      value = next
    },
  })
  return clone
}
