import type { ComposerSnapshot } from '../composer/snapshot.js'
import type { PromptQueueKind } from '../queue/queue-manage.js'

/**
 * What a safe `/restart` hands to the next evot image. Written by the old
 * binary, read by the new one, so it is a published format: fields are only
 * added, never reinterpreted, and the version is checked before anything else.
 */
export const RESTART_CHECKPOINT_VERSION = 1

export interface SavedImage { id: number; base64: string; mediaType: string; filePath?: string }
export interface SavedDraft {
  text: string
  cursorLine: number
  cursorCol: number
  chunks: [number, string][]
  images: [number, SavedImage][]
}
export interface SavedPrompt {
  queue: PromptQueueKind
  text: string
  expandedText: string
  contentJson?: string
  phoneDraftId?: string
  paused: boolean
  draft: SavedDraft
}
/** How this window took part in Remote, so the next image rejoins the same way. */
export interface RemoteHandoff {
  terminal: string
  /** Set for a window a phone opened; it keeps that identity and its idle exit. */
  phoneScope: string | null
  share: 'inherit' | 'off' | string
  /** This window ran the profile gateway: the next image starts it again. */
  gateway: boolean
}
export interface RestartCheckpoint {
  version: typeof RESTART_CHECKPOINT_VERSION
  session: string | null
  remote: RemoteHandoff | null
  draft: SavedDraft | null
  queue: SavedPrompt[]
}

export function savedDraft(snapshot: ComposerSnapshot): SavedDraft {
  return {
    text: snapshot.text, cursorLine: snapshot.cursorLine, cursorCol: snapshot.cursorCol,
    chunks: snapshot.chunks.map(([id, text]) => [id, text]),
    images: snapshot.images.map(([id, image]) => [id, { id: image.id, base64: image.base64, mediaType: image.mediaType,
      ...(image.filePath !== undefined ? { filePath: image.filePath } : {}) }]),
  }
}

/** Undo and history positions belong to the old process; a restored draft starts fresh. */
export function composerSnapshot(draft: SavedDraft): ComposerSnapshot {
  return { ...draft, undo: [], history: { index: 0, savedInput: '', length: 0 } }
}

const SCOPE = /^[0-9a-f]{24}$/
const TERMINAL = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const optionalText = (value: unknown) => value === undefined || typeof value === 'string'

function decodeDraft(value: unknown): SavedDraft | null {
  const row = record(value)
  if (!row || typeof row.text !== 'string' || !count(row.cursorLine) || !count(row.cursorCol)
    || !Array.isArray(row.chunks) || !Array.isArray(row.images)) return null
  const chunks: [number, string][] = []
  for (const chunk of row.chunks) {
    if (!Array.isArray(chunk) || !count(chunk[0]) || typeof chunk[1] !== 'string') return null
    chunks.push([chunk[0], chunk[1]])
  }
  const images: [number, SavedImage][] = []
  for (const entry of row.images) {
    const image = Array.isArray(entry) ? record(entry[1]) : null
    if (!image || !count(entry[0]) || !count(image.id) || typeof image.base64 !== 'string'
      || typeof image.mediaType !== 'string' || !optionalText(image.filePath)) return null
    images.push([entry[0], { id: image.id as number, base64: image.base64, mediaType: image.mediaType,
      ...(typeof image.filePath === 'string' ? { filePath: image.filePath } : {}) }])
  }
  return { text: row.text, cursorLine: row.cursorLine as number, cursorCol: row.cursorCol as number, chunks, images }
}

function decodePrompt(value: unknown): SavedPrompt | null {
  const row = record(value)
  const draft = row && decodeDraft(row.draft)
  if (!row || !draft || (row.queue !== 'steering' && row.queue !== 'follow_up') || typeof row.text !== 'string'
    || typeof row.expandedText !== 'string' || typeof row.paused !== 'boolean'
    || !optionalText(row.contentJson) || !optionalText(row.phoneDraftId)) return null
  return {
    queue: row.queue, text: row.text, expandedText: row.expandedText, paused: row.paused, draft,
    ...(typeof row.contentJson === 'string' ? { contentJson: row.contentJson } : {}),
    ...(typeof row.phoneDraftId === 'string' ? { phoneDraftId: row.phoneDraftId } : {}),
  }
}

function decodeRemote(value: unknown): RemoteHandoff | null {
  const row = record(value)
  if (!row || typeof row.terminal !== 'string' || !TERMINAL.test(row.terminal) || typeof row.gateway !== 'boolean') return null
  if (row.phoneScope !== null && !(typeof row.phoneScope === 'string' && SCOPE.test(row.phoneScope))) return null
  if (row.share !== 'inherit' && row.share !== 'off' && !(typeof row.share === 'string' && SCOPE.test(row.share))) return null
  return { terminal: row.terminal, phoneScope: row.phoneScope as string | null, share: row.share, gateway: row.gateway }
}

/** Unknown fields are ignored; a missing or newer version is refused as a whole. */
export function decodeRestartCheckpoint(value: unknown): RestartCheckpoint {
  const row = record(value)
  if (!row) throw new Error('Restart checkpoint is not an object.')
  if (row.version !== RESTART_CHECKPOINT_VERSION)
    throw new Error(`Unsupported restart checkpoint version: ${JSON.stringify(row.version ?? null)}.`)
  if (row.session !== null && typeof row.session !== 'string') throw new Error('Restart checkpoint has an invalid session.')
  const remote = row.remote === null ? null : decodeRemote(row.remote)
  if (row.remote !== null && !remote) throw new Error('Restart checkpoint has an invalid Remote handoff.')
  const draft = row.draft === null ? null : decodeDraft(row.draft)
  if (row.draft !== null && !draft) throw new Error('Restart checkpoint has an invalid draft.')
  if (!Array.isArray(row.queue)) throw new Error('Restart checkpoint has an invalid queue.')
  const queue = row.queue.map(decodePrompt)
  if (queue.some(prompt => !prompt)) throw new Error('Restart checkpoint has an invalid queued message.')
  return { version: RESTART_CHECKPOINT_VERSION, session: row.session as string | null, remote, draft, queue: queue as SavedPrompt[] }
}
