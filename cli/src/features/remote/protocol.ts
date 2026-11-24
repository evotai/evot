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
  role: 'user' | 'assistant' | 'footer' | 'notice'
  text: string
  blocks?: RemoteBlock[]
}
export interface RemoteQuestion {
  header: string
  question: string
  options: { label: string; description?: string }[]
}
export interface RemoteModels {
  active: string
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
export interface RemoteSnapshot {
  models: RemoteModels
  sessionId: string | null
  /** Older windows omit it. */
  place?: RemotePlace
  /** The TUI's next-prompt suggestion (Tab/→ there); a phone taps it into its own draft. */
  suggestion?: string
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
  | { kind: 'send' | 'steer'; text: string; images?: RemoteImage[] }
  | { kind: 'stop' }
  | { kind: 'tool-view'; expanded: boolean }
  | { kind: 'select-model'; spec: string; effort?: string; revision: string }
  | { kind: 'answer'; id: string; answers: string[] }
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
  if (kind === 'stop') return { kind, generation }
  if (kind === 'select-model' && plain(spec) && plain(revision) && (effort === undefined || plain(effort))) {
    return { kind, generation, spec, effort, revision }
  }
  if (kind === 'send' || kind === 'steer') {
    const images = parseImages((value as Record<string, unknown>).images)
    if (images === null) return null
    // A photo alone is a prompt too; text, when present, is still checked like any message.
    if (plain(text)) return { kind, generation, text: text.trim(), ...(images.length ? { images } : {}) }
    if (images.length && (text === undefined || text === '')) return { kind, generation, text: '', images }
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
