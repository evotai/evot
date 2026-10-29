import { relativeTime } from '../../render/format.js'
import type { SessionMeta, SessionWithText } from '../../native/index.js'
import { PREVIEW_SECTION_PREFIX, type SelectorItem } from '../selector.js'
import { recognitionSections, type SessionRecognition } from './session-recognition.js'
import { orderAsForkTree } from './fork-tree.js'
import { shareAccess } from '../../session/cloud-sessions.js'
import { COMPACT_SUMMARY_PREFIX } from '../../session/user-input.js'

export const RESUME_SELECTOR_TITLE = 'Sessions'

/**
 * Stem of the synthetic user message compaction injects ahead of a summary.
 * Shorter than the 40-character head budget used by session titles, so it also
 * matches titles an earlier release derived from that message before the
 * backend stopped doing so.
 */
export { COMPACT_SUMMARY_PREFIX } from '../../session/user-input.js'

/**
 * Display title for a session. Sessions compacted by an earlier release carry a
 * title built from the compaction summary boilerplate, which renders the resume
 * list as a wall of identical rows. Those read as `(compacted)` until the next
 * save recomputes them from real user turns.
 */
export function sanitizeSessionTitle(title?: string | null): string {
  if (title && title.startsWith(COMPACT_SUMMARY_PREFIX)) return '(compacted)'
  return title || '(untitled)'
}

export type SessionPrefixResolution =
  | { kind: 'matched'; session: SessionMeta }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: SessionMeta[] }

export function shortenSessionCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return cwd
  if (cwd === home) return '~'
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

function sessionHeader(label: string, group: string, searchOnly = false): SelectorItem {
  return { label, header: true, focusable: false, group, searchOnly }
}

function groupedSessionItems<T extends SessionMeta>(
  sessions: T[],
  currentCwd: string,
  format: (session: T, otherCwd: boolean, edge: string) => SelectorItem,
  showOtherCwds = false,
): SelectorItem[] {
  // Forks nest under their parent within each group; the tree is per cwd
  // because a fork always keeps its parent's workspace.
  const current = orderAsForkTree(sessions.filter(session => session.cwd === currentCwd))
  const other = orderAsForkTree(sessions.filter(session => session.cwd !== currentCwd))
  const items: SelectorItem[] = []

  if (current.length > 0) {
    items.push(sessionHeader(`Current cwd · ${shortenSessionCwd(currentCwd)}`, 'current-cwd'))
    items.push(...current.map(row => ({ ...format(row.session, false, row.edge), group: 'current-cwd' })))
  }
  if (other.length > 0) {
    // Resume defaults to the project the user is in. Cross-project history
    // remains in the search pool, but never expands the initial picker into a
    // noisy global recents list — including when this cwd has no history yet.
    // The shared list is the exception: it is short, and a shared session is
    // as likely to come from another project or machine as from this one.
    const searchOnly = !showOtherCwds
    items.push(sessionHeader('Other cwd', 'other-cwd', searchOnly))
    items.push(...other.map(row => ({
      ...format(row.session, true, row.edge),
      group: 'other-cwd',
      ...(searchOnly ? { searchOnly: true } : {}),
    })))
  }
  return items
}

export function normalizeResumeQuery(value: string): string {
  const query = value.trim()
  const quotePairs = [["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”']] as const
  for (const [open, close] of quotePairs) {
    if (query.startsWith(open) && query.endsWith(close)) {
      return query.slice(open.length, -close.length).trim()
    }
  }
  return query
}

export function isSessionIdPrefix(value: string): boolean {
  return /^[0-9a-f]{1,36}$/i.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function resolveSessionByPrefix(sessions: SessionMeta[], prefix: string): SessionPrefixResolution {
  const matches = sessions.filter(s => s.session_id === prefix || s.session_id.startsWith(prefix))
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous', matches }
  return { kind: 'matched', session: matches[0]! }
}

/** Latest user turns shown after `Started with`. The rest stay behind `⋮`. */
const PREVIEW_LATEST_SHOWN = 3

/** Paths named in the `Changed` section before the rest become `+N`. */
const PREVIEW_CHANGED_PATHS_SHOWN = 3

/** How the pane reads a session: the same block in both lists, ordered for
 *  the list it is in. */
export interface SessionPreviewOptions {
  /** Name the workspace in the facts line: the session is from another cwd. */
  showCwd?: boolean
  /** This REPL is in the session. */
  open?: boolean
  /** The `/share` list: who can read the session leads, since that is what
   *  the list is for. Elsewhere the share block trails the transcript. */
  cloudFirst?: boolean
}

/** The page a shared session is read at; empty for a private sync. */
export function sessionShareLink(session: SessionMeta): string {
  const cloud = session.cloud
  if (!cloud) return ''
  const access = shareAccess(cloud)
  return (access === 'public' ? cloud.public_url : access === 'team' ? cloud.team_url : null) ?? ''
}

/**
 * Where a cloud session can be read, and how to take it down. The link is
 * what `/share` is opened to find, and it appeared only once, in the line
 * printed when the share was made; the pane keeps it reachable. Empty for a
 * session that is not on the cloud.
 */
export function sessionCloudSection(session: SessionMeta): string[] {
  const cloud = session.cloud
  if (!cloud) return []
  const access = shareAccess(cloud)
  const link = sessionShareLink(session)
  const lines = access === 'public' ? [
    `${PREVIEW_SECTION_PREFIX}Public link · anyone with it can read`,
    link || 'link pending · /share public again to get it',
  ] : access === 'team' ? [
    `${PREVIEW_SECTION_PREFIX}Team link${cloud.team_name ? ` · ${cloud.team_name}` : ''} · members sign in to read`,
    link || 'link pending · /share team again to get it',
  ] : [
    `${PREVIEW_SECTION_PREFIX}Cloud · private`,
    'Only you · resume it from any machine you are signed in on',
  ]
  lines.push(`Stop sharing  u in this list · /share off ${session.session_id.slice(0, 8)}`)
  return lines
}

/**
 * Side-pane content for one session, organised by what identifies it fastest:
 * the title and identity line, what it set out to do (`Started with`), where
 * it left off (`Latest`), and what it actually touched (`Changed`). Sections
 * are labelled entries so the pane can trim them by priority rather than by
 * position when space is short.
 *
 * `text` is absent until that session's transcript has been read, so the pane
 * starts as the identity block and fills in once it lands. Every field comes
 * from the engine's own extraction, so a row reads the same whether its text
 * arrived with the whole catalog or from focusing this one row.
 *
 * `source` already appears in the row and `cwd` in the group heading, so
 * neither is repeated here; a session from another cwd is the exception, since
 * its path is the thing that distinguishes it.
 */
export function sessionPreviewLines(
  session: SessionMeta,
  text?: SessionRecognition,
  options: SessionPreviewOptions = {},
): string[] {
  const { showCwd = false, open = false, cloudFirst = false } = options
  const facts = [shortModel(session), `${session.turns || 0} turns`, sessionSpan(session)]
  if (open) facts.unshift('this session')
  if (session.source === 'automation') facts.unshift('task run')
  if (showCwd) facts.push(shortenSessionCwd(session.cwd))
  const header = [sanitizeSessionTitle(session.custom_title ?? session.title), facts.filter(Boolean).join(' · ')]
  const cloud = sessionCloudSection(session)
  // In the /share list the link leads; elsewhere the transcript does and the
  // share block follows it, where a scroll still reaches it.
  const lines = cloudFirst && cloud.length ? [...header, '', ...cloud] : header
  const trailing = !cloudFirst && cloud.length ? ['', ...cloud] : []
  if (!text) return [...lines, ...trailing]
  if (text.recognition) {
    // Generated titles often repeat the first instruction. Keep the title
    // compact so the first screen shows where this session actually left off.
    const title = Array.from(lines[0] ?? '')
    if (title.length > 100) lines[0] = `${title.slice(0, 100).join('')}…`
    lines.push('', ...recognitionSections(text))
    const paths = text.changed_paths ?? []
    if (paths.length) lines.push('', '# Files referenced by edits', ...paths)
    lines.push(...trailing, '', '# Session', `ID  ${session.session_id}`,
      `Source  ${session.source === 'automation' ? 'task run' : session.source || 'unknown'}`,
      `Workspace  ${shortenSessionCwd(session.cwd)}`)
    return lines
  }

  const prompts = text.user_prompts
  const first = text.first_prompt ?? prompts[0]
  // The opening turn is its own section; `Latest` is every turn after it so a
  // one-turn session does not say the same thing twice.
  const latest = first !== undefined && prompts[0] === first ? prompts.slice(1) : prompts
  const latestShown = latest.slice(-PREVIEW_LATEST_SHOWN)
  const sections: string[][] = []
  if (first) sections.push([`${PREVIEW_SECTION_PREFIX}Started with`, `› ${first}`])
  if (latestShown.length > 0) {
    sections.push([
      `${PREVIEW_SECTION_PREFIX}Latest`,
      ...(latest.length > latestShown.length ? ['  ⋮'] : []),
      ...latestShown.map(prompt => `› ${prompt}`),
    ])
  }
  const changed = text.changed_paths ?? []
  if (changed.length > 0) {
    const shown = changed.slice(0, PREVIEW_CHANGED_PATHS_SHOWN)
    const more = changed.length - shown.length
    const names = shown.map(path => path.split('/').pop() || path)
    sections.push([
      `${PREVIEW_SECTION_PREFIX}Changed ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`,
      `  ${names.join(' · ')}${more > 0 ? ` · +${more}` : ''}`,
    ])
  }
  if (sections.length > 0) lines.push('', ...sections.flatMap((section, index) => index === 0 ? section : ['', ...section]))
  lines.push(...trailing)
  return lines
}

/**
 * `2d ago → 1h ago` for a session that ran across time, or just the last
 * activity when it was a single sitting: the span is what separates a long
 * task from a quick question.
 */
function sessionSpan(session: SessionMeta): string {
  const updated = relativeTime(session.updated_at)
  const created = relativeTime(session.created_at)
  return created && created !== updated ? `${created} → ${updated}` : updated
}

/**
 * Model without its provider prefix. The pane has one line for identity and a
 * bare model name is what distinguishes sessions; `anthropic:` in front of
 * every Claude row spends columns without adding a distinction.
 */
function shortModel(session: SessionMeta): string {
  return session.model || session.provider || ''
}

function commonPrefixLength(left: string, right: string): number {
  const end = Math.min(left.length, right.length)
  let index = 0
  while (index < end && left[index] === right[index]) index++
  return index
}

/**
 * UUIDv7 ids created close together often share their first eight characters.
 * Keep the familiar short label when it is unique, and extend only colliding
 * labels far enough to make every visible row distinguishable and resumable.
 */
function sessionIdLabels(sessions: SessionMeta[]): Map<string, string> {
  const sorted = sessions.map(session => session.session_id).sort()
  const labels = new Map<string, string>()
  for (let index = 0; index < sorted.length; index++) {
    const id = sorted[index]!
    const previous = sorted[index - 1] ?? ''
    const next = sorted[index + 1] ?? ''
    const uniqueLength = Math.max(
      8,
      commonPrefixLength(id, previous) + 1,
      commonPrefixLength(id, next) + 1,
    )
    labels.set(id, id.slice(0, uniqueLength))
  }
  return labels
}

/** Task runs are durable sessions, but they belong under /task rather than
 * the default resume picker. Direct lookup by id remains available. */
export function isInteractiveSession(session: SessionMeta): boolean {
  return session.source !== 'automation'
}

/** Source label when an automation session is deliberately opened by id. */
export function sessionSourceBadge(source: string | undefined): string {
  switch (source || '') {
    case 'automation': return 'task'
    case '': return ''
    default: return source ?? ''
  }
}

const SESSION_HINTS = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'details' },
  { keys: 'enter', action: 'resume' },
  { keys: '/', action: 'search' },
  { keys: 'e', action: 'rename' },
  { keys: 'd', action: 'delete' },
  { keys: 'escape', action: 'close' },
]

/** A cloud row offers the lighter take-down beside delete: the cloud copy
 *  goes, this machine keeps the session. */
const CLOUD_SESSION_HINTS = SESSION_HINTS.flatMap(hint =>
  hint.keys === 'd' ? [{ keys: 'u', action: 'unshare' }, hint] : [hint])

/** One-line rows have no details pane, so `tab` offers nothing. */
const LINE_SESSION_HINTS = SESSION_HINTS.filter(hint => hint.keys !== 'tab')
const LINE_CLOUD_SESSION_HINTS = CLOUD_SESSION_HINTS.filter(hint => hint.keys !== 'tab')

/** How the list shapes its rows beyond ordering. */
export interface SessionListOptions {
  /** List other projects up front instead of hiding them behind search. The
   *  shared list does: a shared session is as likely to come from elsewhere. */
  showOtherCwds?: boolean
  /** The `/share` list: every pane leads with where the session is shared.
   *  It keeps the details pane, since the link lives there. */
  cloudFirst?: boolean
}

const AGE_RELATIVE_DAYS = 7

/**
 * Recent activity reads best as an age (`3h ago`); past a week a date is
 * easier to place. The year shows only when it is not this one.
 */
export function sessionAge(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  const mins = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`
  if (mins < AGE_RELATIVE_DAYS * 24 * 60) return `${Math.floor(mins / (24 * 60))}d ago`
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}-${day}`
}

/**
 * One-line row: full session id and the line that identifies the session,
 * the name the user chose or else the automatic title.
 */
function formatSessionLine(
  s: SessionMeta,
  text: SessionWithText | undefined,
  open: boolean,
  edge: string,
  cloud: string,
  showSource: boolean,
): SelectorItem {
  const badge = sessionSourceBadge(s.source)
  const host = s.cloud?.origin_host && cloud.includes('⇣') ? ` (${s.cloud.origin_host})` : ''
  const chosen = s.custom_title?.trim()
  const label = (chosen || sanitizeSessionTitle(s.title)).replace(/\s+/g, ' ')
  const marks = [`${cloud}${host}`, showSource ? badge : ''].filter(Boolean).join(' · ')
  return {
    label: `${edge}${label}`,
    id: s.session_id,
    renameTitle: s.custom_title ?? s.title ?? '',
    hints: cloud ? LINE_CLOUD_SESSION_HINTS : LINE_SESSION_HINTS,
    // When it last moved, at the end of the row; the open session says so instead.
    status: open ? { text: '● open', tone: 'active' as const } : { text: sessionAge(s.updated_at), tone: 'muted' as const },
    ...(marks ? { badge: marks } : {}),
    ...(cloud ? { cloud: true } : {}),
    searchText: `${s.session_id} ${s.custom_title ?? ''} ${s.title ?? ''} ${badge} ${text?.search_text
      ?? `${s.cwd} ${s.source} ${s.provider ?? ''} ${s.model}`}`,
  }
}

function formatSessionItem(
  s: SessionMeta,
  label: string,
  otherCwd: boolean,
  showSource: boolean,
  text: SessionWithText | undefined,
  open: boolean,
  edge = '',
  cloud = '',
  cloudFirst = false,
): SelectorItem {
  // The source column only earns its space when it tells rows apart.
  const badge = sessionSourceBadge(s.source)
  const source = showSource ? badge : ''
  const title = sanitizeSessionTitle(s.custom_title ?? s.title)
  const turns = `${s.turns || 0} turns`
  // The session this REPL is in says so where the others show their age.
  const time = open ? '● open' : relativeTime(s.updated_at)
  const host = s.cloud?.origin_host && cloud.includes('⇣') ? ` (${s.cloud.origin_host})` : ''
  const cwd = otherCwd ? `  ${shortenSessionCwd(s.cwd)}` : ''
  // The link is what a shared row is scanned for, so it sits on the row and
  // not only in the pane. Last, so a narrow list cuts it before the identity.
  const link = cloud ? sessionShareLink(s) : ''
  // Identity stays in subdued metadata; titles are what people recognize.
  return {
    label: `${edge}${title}`,
    status: { text: time, tone: open ? 'active' : 'muted' },
    id: s.session_id,
    renameTitle: s.custom_title ?? s.title ?? '',
    hints: cloud ? CLOUD_SESSION_HINTS : SESSION_HINTS,
    detail: [turns, `${cloud}${host}`, source, `${label}${cwd}`, link].filter(Boolean).join(' · '),
    ...(cloud ? { cloud: true } : {}),
    // Transcript text is searchable once loaded; until then a row still matches
    // on the metadata the list already displays.
    searchText: `${s.custom_title ?? ''} ${s.title ?? ''} ${badge} ${link} ${text?.search_text
      ?? `${s.session_id} ${s.cwd} ${s.source} ${s.provider ?? ''} ${s.model}`}`,
    contextPrefix: otherCwd ? `${shortenSessionCwd(s.cwd)} · ` : undefined,
    preview: sessionPreviewLines(s, text, { showCwd: otherCwd, open, cloudFirst }),
  }
}

/** True when rows differ by source, so the column carries information. */
function mixedSources(sessions: SessionMeta[]): boolean {
  return new Set(sessions.map(session => session.source || '')).size > 1
}

type SessionRowFormatter = (session: SessionMeta, otherCwd: boolean, edge: string) => SelectorItem

/**
 * Shared per-row rendering for every session list. Precomputes the list-wide
 * facts (id label width, mixed sources, cloud badges) once so the list shapes
 * below only decide ordering and grouping. The `/share` list keeps its
 * details pane; every other list draws one line per session.
 */
function sessionRowFormatter(
  sessions: SessionMeta[],
  sessionText: (sessionId: string) => SessionWithText | undefined,
  openSessionId: string | null | undefined,
  cloudBadge: (session: SessionMeta) => string,
  options: SessionListOptions = {},
): SessionRowFormatter {
  const showSource = mixedSources(sessions)
  const badges = new Map(sessions.map(session => [session.session_id, cloudBadge(session)]))
  if (!options.cloudFirst) {
    return (session, _otherCwd, edge) => formatSessionLine(
      session,
      sessionText(session.session_id),
      session.session_id === openSessionId,
      edge,
      badges.get(session.session_id) ?? '',
      showSource,
    )
  }
  const labels = sessionIdLabels(sessions)
  return (session, otherCwd, edge) => formatSessionItem(
    session,
    labels.get(session.session_id) ?? session.session_id,
    otherCwd,
    showSource,
    sessionText(session.session_id),
    session.session_id === openSessionId,
    edge,
    badges.get(session.session_id) ?? '',
    true,
  )
}

/**
 * The resume list. `sessionText` supplies whatever text has been loaded, so
 * one formatter covers the metadata-only first paint and the fully loaded
 * catalog behind a typed filter.
 */
export function formatSessionItems(
  sessions: SessionMeta[],
  currentCwd: string,
  sessionText: (sessionId: string) => SessionWithText | undefined = () => undefined,
  openSessionId?: string | null,
  cloudBadge: (session: SessionMeta) => string = () => '',
  options: SessionListOptions = {},
): SelectorItem[] {
  const row = sessionRowFormatter(sessions, sessionText, openSessionId, cloudBadge, options)
  return groupedSessionItems(sessions, currentCwd, row, options.showOtherCwds)
}

/**
 * Search results in ranked order. No cwd grouping and no search-only hiding:
 * a semantic hit from another workspace is the whole point of the query.
 * Each row shows the summary the search model wrote for it, which describes
 * the session better than its stored title or a chosen name.
 */
export function formatRankedSessionItems(
  sessions: SessionMeta[],
  sessionText: (sessionId: string) => SessionWithText | undefined = () => undefined,
  openSessionId?: string | null,
  cloudBadge: (session: SessionMeta) => string = () => '',
  summaries: ReadonlyMap<string, string> = new Map(),
): SelectorItem[] {
  const row = sessionRowFormatter(sessions, sessionText, openSessionId, cloudBadge)
  return sessions.map(session => {
    const item = row(session, false, '')
    const summary = summaries.get(session.session_id)
    if (!summary) return item
    return { ...item, label: summary, searchText: `${summary} ${item.searchText ?? ''}` }
  })
}

/**
 * Re-render one row against newly loaded text, preserving its identity.
 *
 * Patching the single row keeps the other rows' object identity, which the
 * selector's lowercased-search cache is keyed on: rebuilding the whole list
 * would throw that away on every focus move. One-line rows have no pane, so
 * only their searchable text changes.
 */
export function applySessionText(
  item: SelectorItem,
  text: SessionWithText,
  currentCwd: string,
  openSessionId?: string | null,
  cloudFirst = false,
): SelectorItem {
  if (!item.preview) {
    return { ...item, searchText: `${text.session_id} ${item.label} ${text.custom_title ?? ''} ${text.title ?? ''} ${text.search_text}` }
  }
  return {
    ...item,
    searchText: `${text.custom_title ?? ''} ${text.title ?? ''} ${text.search_text}`,
    preview: sessionPreviewLines(text, text, { showCwd: text.cwd !== currentCwd, open: text.session_id === openSessionId, cloudFirst }),
  }
}
