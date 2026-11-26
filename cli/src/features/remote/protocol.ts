import type { CommandInventory } from '../composer/command-arguments.js'
import type { SlashHint } from '../composer/slash-completion.js'
import type { NoticeSpan } from '../../ui/notice-layout.js'

/** Display data from the selected TUI, never the underlying tool/agent DTOs. */
/** One row of a Write/Edit patch, laid out as the TUI's unified diff on a narrow pane.
 * `word` marks the changed tokens of a single-line edit. Older phones ignore it. */
export interface RemoteDiffRow {
  kind: 'add' | 'remove' | 'context' | 'ellipsis' | 'header'
  num?: string
  code: { text: string; word?: true }[]
}
export type RemoteBlock =
  /** `html`: a text block as the TUI's Markdown lays it out (markdown/render/html.ts). Older windows omit it. */
  | { kind: 'text' | 'thinking'; text: string; html?: string }
  | { kind: 'tool'; text: string; state: 'pending' | 'success' | 'error'; diff?: RemoteDiffRow[] }
export interface RemoteMessage {
  /** Echo of the submitting tab's photo draftId, not an image URL or a retrieval token. */
  photoId?: string
  role: 'user' | 'assistant' | 'footer' | 'notice'
  text: string
  blocks?: RemoteBlock[]
  /** Optional presentation; earlier phones use `text`, `styled` and `link`. */
  command?: { styled?: true; link?: string; spans?: NoticeSpan[] }
}
export interface RemoteQuestion {
  header: string
  question: string
  options: { label: string; description?: string }[]
}
export interface RemoteModels {
  active: string
  /** `/model n` follows the TUI's catalog order, not the phone picker's display order. */
  next?: string
  effort: string
  pending: { spec: string; effort?: string } | null
  /** Compare-and-set token: a stale phone must not overwrite a newer TUI pick. */
  revision: string
  options: { spec: string; label: string; group: string; levels: string[]; warning: string }[]
}
/** Where the followed window runs. Fixed for the life of that TUI process. */
export interface RemotePlace {
  /** Folder name and a home-relative path; never the machine's absolute layout beyond that. */
  name: string
  path: string
  host: string
  branch: string | null
}
/** Only display metadata leaves the host, never a skill directory or prompt. */
export interface RemoteCommand {
  name: string
  description: string
  usage?: string
  arguments?: readonly string[]
  /** Shortest unambiguous TUI prefix for this spelling. */
  prefix: string
  /** When present, run the phone-native equivalent rather than a terminal overlay. */
  shortcut?: 'sessions' | 'new' | 'model' | 'help'
}
export interface RemoteSlashHints {
  catalog: readonly SlashHint[]
  forked: boolean
  inventory: CommandInventory
}
export interface RemoteSnapshot {
  /** Legacy runnable catalog, also describes phone-native shortcuts. */
  commands?: readonly RemoteCommand[]
  /** The followed window's TUI hints. May include commands that only run locally. */
  slashHints?: RemoteSlashHints
  models: RemoteModels
  sessionId: string | null
  /** Older windows omit it. */
  place?: RemotePlace
  /** The TUI's next-prompt suggestion (Tab/→ there); a phone taps it into its own draft. */
  suggestion?: string
  /** Display-only feedback for the empty composer, never an insertable candidate. Older windows omit it. */
  suggestionHint?: string
  /** Same metadata title as /sessions; older windows omit it. */
  title?: string
  generation: number
  status: string
  messageOffset?: number
  messages: readonly RemoteMessage[]
  live: string
  liveBlocks?: RemoteBlock[]
  statusDetail?: string
  active?: boolean
  input: 'send' | 'steer' | null
  expanded?: boolean
  background?: RemoteBackground
  /** TUI queue order and state. Only the submitting page can supply the original preview.
   * No terminal input, expanded text, attachments or private task arguments. */
  promptQueue?: { state: 'now' | 'after' | 'paused'; draftId?: string }[]
  /** Still-pending phone drafts (steering and follow-up), oldest first; no prompt contents. */
  pendingDrafts?: string[]
  /** Steer-only projection for phones predating follow-up support. */
  pendingSteers?: string[]
  /** Only actions supported by this window in its current state. Older windows omit these. */
  composerKeys?: { queue: boolean; cycleEffort: boolean; suggest: boolean }
  /** Identifies exactly the set of background shells offered for stopping. */
  stopBackgroundTarget?: string
  canStop: boolean
  ask: { id: string; questions: RemoteQuestion[] } | null
}
export interface RemoteBackground {
  chip: string
  subtitle?: string
  tasks: { id: string; title: string; detail?: string; status?: string; activity?: string }[]
  output?: { id: string; text: string }
}
/** A photo from the phone, already scaled down there; the engine resizes further if needed. */
export interface RemoteImage { mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string }
export const REMOTE_IMAGE_LIMITS = { count: 4, base64Each: 6 * 1024 * 1024, base64Total: 14 * 1024 * 1024 }
export type RemoteAction = { generation: number } & (
  | { kind: 'send' | 'steer' | 'queue'; text: string; images?: RemoteImage[]; draftId?: string }
  | { kind: 'pull-draft' | 'pull-steer'; draftId: string }
  | { kind: 'cycle-effort'; revision: string }
  | { kind: 'suggest' }
  | { kind: 'stop'; askId?: string }
  | { kind: 'stop-background'; target: string }
  | { kind: 'tool-view'; expanded: boolean }
  | { kind: 'select-model'; spec: string; effort?: string; revision: string }
  | { kind: 'answer'; id: string; answers: string[] }
  | { kind: 'cancel-ask' | 'interrupt-ask'; id: string }
)
export interface RemoteHost {
  snapshot(backgroundView?: string): RemoteSnapshot
  /** Synchronous admission: never await completion of the run in an HTTP request. */
  act(action: RemoteAction): void
}
export class RemoteConflict extends Error {}

/** Text eventually reaches a real terminal. Accept prose and newlines, not
 * terminal escapes, control strings, or an unbounded body. */
function plain(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 8192 && !!value.trim() && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value)
  )
}
export function parseRemoteAction(value: unknown): RemoteAction | null {
  if (!value || typeof value !== 'object') return null
  const { generation, kind, text, id, answers, spec, effort, revision } = value as Record<string, unknown>
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null
  if (kind === 'tool-view' && 'expanded' in value && typeof value.expanded === 'boolean')
    return { kind, generation, expanded: value.expanded }
  if ((kind === 'cancel-ask' || kind === 'interrupt-ask') && plain(id) && id.length <= 512) return { kind, generation, id }
  if (kind === 'stop') {
    if (!('askId' in value)) return { kind, generation }
    return plain(value.askId) ? { kind, generation, askId:value.askId } : null
  }
  const { draftId } = value as Record<string, unknown>
  if (draftId !== undefined && (typeof draftId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(draftId))) return null
  if ((kind === 'pull-draft' || kind === 'pull-steer') && draftId) return { kind, generation, draftId }
  if (kind === 'cycle-effort' && plain(revision)) return { kind, generation, revision }
  if (kind === 'suggest') return { kind, generation }
  if (kind === 'stop-background' && 'target' in value && typeof value.target === 'string' && /^[0-9a-f]{64}$/.test(value.target))
    return { kind, generation, target: value.target }
  if (kind === 'select-model' && plain(spec) && plain(revision) && (effort === undefined || plain(effort))) {
    return { kind, generation, spec, effort, revision }
  }
  if (kind === 'send' || kind === 'steer' || kind === 'queue') {
    const images = parseImages((value as Record<string, unknown>).images)
    if (images === null) return null
    // A photo alone is a prompt too; text, when present, is still checked like any message.
    const receipt = (kind !== 'send' || images.length > 0) && draftId ? { draftId } : {}
    if (plain(text)) return { kind, generation, text: text.trim(), ...(images.length ? { images } : {}), ...receipt }
    if (images.length && (text === undefined || text === '')) return { kind, generation, text: '', images, ...receipt }
    return null
  }
  if (
    kind === 'answer' &&
    typeof id === 'string' &&
    id &&
    id.length <= 512 &&
    Array.isArray(answers) &&
    answers.length >= 1 &&
    answers.length <= 4 &&
    answers.every(plain)
  )
    return { kind, generation, id, answers: answers.map((s) => s.trim()) }
  return null
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
/** One photo uploaded ahead of its message, checked as strictly as an inline one. */
export function parseRemoteImage(value: unknown): RemoteImage | null {
  return parseImages([value])?.[0] ?? null
}

/** `[]` when absent, `null` when present but not acceptable. */
function parseImages(value: unknown): RemoteImage[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > REMOTE_IMAGE_LIMITS.count) return null
  let total = 0
  const out: RemoteImage[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { mimeType, data } = item as Record<string, unknown>
    if (typeof mimeType !== 'string' || !IMAGE_TYPES.has(mimeType) || typeof data !== 'string' || !data
      || data.length > REMOTE_IMAGE_LIMITS.base64Each || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null
    total += data.length
    if (total > REMOTE_IMAGE_LIMITS.base64Total) return null
    out.push({ mimeType: mimeType as RemoteImage['mimeType'], data })
  }
  return out
}
