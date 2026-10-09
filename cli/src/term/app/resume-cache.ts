import type { SessionMeta, SessionWithText, TranscriptItem } from '../../native/index.js'
import { enrichSessionRecognition, type SessionRecognition } from './session-recognition.js'
import { isInteractiveSession } from './resume.js'

export interface ResumeSessionClient {
  listSessions(limit: number): Promise<SessionMeta[]>
  listSessionsWithText(limit: number): Promise<SessionWithText[]>
  sessionWithText(sessionId: string): Promise<SessionWithText | null>
  loadTranscript?(sessionId: string): Promise<TranscriptItem[]>
}

/**
 * Focused sessions whose text is retained. Each row carries a bounded
 * transcript excerpt, so browsing a long list would otherwise accumulate them
 * for the life of the session. Oldest focus is evicted first.
 */
const FOCUSED_TEXT_LIMIT = 32

/** Rows in the bounded first paint, before the full catalog arrives. */
export const RESUME_PREVIEW_ROWS = 20

/** Owns metadata/text snapshots and rejects late results after invalidation.
 * No terminal, editor, selector or rendering dependencies. */
export class ResumeSessionCache {
  private rows: SessionMeta[] | null = null
  private textRows: SessionWithText[] | null = null
  /** By-id view of `textRows`, so the list formatter avoids a scan per row. */
  private textIndex: Map<string, SessionWithText> | null = null
  private full = false
  private generation = 0
  private textGeneration = 0
  private disposed = false
  private previewLoad: Promise<SessionMeta[]> | null = null
  private fullLoad: Promise<SessionMeta[]> | null = null
  private textLoad: Promise<SessionWithText[]> | null = null
  /** Text loaded one row at a time, for the focused preview. */
  private readonly focusedText = new Map<string, SessionRecognition>()
  private readonly focusedLoads = new Map<string, Promise<SessionWithText | null>>()

  constructor(private readonly client: ResumeSessionClient, private readonly onLoaded: (rows: SessionMeta[]) => void = () => {}) {}

  get metadata(): SessionMeta[] | null { return this.rows }
  get withText(): SessionWithText[] | null { return this.textRows }
  get complete(): boolean { return this.full }

  /**
   * Bumped whenever known text changes, so memoized rows can be reused while it
   * holds still. Formatted rows depend on this text, not only on the metadata.
   */
  get textVersion(): number { return this.textGeneration }

  /**
   * Text known for one session, from either load path.
   *
   * The list formatter reads this, so a row renders the same whether its text
   * arrived with the whole catalog or from focusing that single row.
   */
  sessionText(sessionId: string): SessionRecognition | undefined {
    if (this.textRows !== null && this.textIndex === null) {
      this.textIndex = new Map(this.textRows.map(row => [row.session_id, row]))
    }
    return this.focusedText.get(sessionId) ?? this.textIndex?.get(sessionId)
  }

  replace(rows: SessionMeta[], complete = false): void {
    if (this.disposed) return
    this.invalidate()
    this.rows = rows
    this.full = complete
  }

  remove(id: string, fallback: SessionMeta[] = []): void {
    if (this.disposed) return
    const rows = (this.rows ?? fallback).filter(row => row.session_id !== id)
    const text = this.textRows?.filter(row => row.session_id !== id) ?? null
    const complete = this.full
    this.replace(rows, complete)
    this.textRows = text
    this.textIndex = null
    this.textGeneration++
  }

  /**
   * Rewrite one row's metadata in place (its cloud block after an unshare).
   * The transcript is as it was, so the catalog and text snapshots stay; only
   * memoized rows are told to re-render.
   */
  update(id: string, change: Partial<SessionMeta>): void {
    if (this.disposed) return
    const swap = <T extends SessionMeta>(rows: T[] | null): T[] | null =>
      rows?.map(row => row.session_id === id ? { ...row, ...change } : row) ?? null
    this.rows = swap(this.rows)
    this.textRows = swap(this.textRows)
    this.textIndex = null
    this.textGeneration++
    if (this.rows) this.onLoaded(this.rows)
  }

  rename(session: SessionMeta): void {
    if (this.disposed) return
    const rows = (this.rows ?? []).map(row => row.session_id === session.session_id ? session : row)
    if (!rows.some(row => row.session_id === session.session_id)) rows.push(session)
    const complete = this.full
    // Drop every text snapshot/in-flight load; stale search text contains the old name.
    this.replace(rows, complete)
    this.onLoaded(rows)
  }

  invalidate(): void {
    this.generation++
    this.textGeneration++
    this.rows = null
    this.textRows = null
    this.textIndex = null
    this.full = false
    this.previewLoad = null
    this.fullLoad = null
    this.textLoad = null
    this.focusedText.clear()
    this.focusedLoads.clear()
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
  }

  preview(): Promise<SessionMeta[]> {
    if (this.disposed) return Promise.resolve([])
    if (this.rows !== null && (this.full || this.rows.length > 0)) {
      const interactive = this.rows.filter(isInteractiveSession)
      if (this.full || interactive.length === RESUME_PREVIEW_ROWS || this.rows.length < RESUME_PREVIEW_ROWS) {
        return Promise.resolve(interactive.slice(0, RESUME_PREVIEW_ROWS))
      }
    }
    if (this.previewLoad) return this.previewLoad
    const generation = this.generation
    const load = this.client.listSessions(RESUME_PREVIEW_ROWS).then(async preview => {
      if (generation !== this.generation) return (this.rows ?? []).filter(isInteractiveSession).slice(0, RESUME_PREVIEW_ROWS)
      // The storage limit counts all sessions, including task runs. If they
      // fill the first page, fetch the catalog so the resume picker still has
      // 20 human sessions instead of a blank or misleading first screen.
      const rows = preview.length === RESUME_PREVIEW_ROWS
        && preview.filter(isInteractiveSession).length < RESUME_PREVIEW_ROWS
        ? await this.client.listSessions(0) : preview
      if (generation !== this.generation) return (this.rows ?? []).filter(isInteractiveSession).slice(0, RESUME_PREVIEW_ROWS)
      if (!this.full) {
        this.rows = rows
        this.full = rows !== preview
        this.onLoaded(rows)
        return rows.filter(isInteractiveSession).slice(0, RESUME_PREVIEW_ROWS)
      }
      return (this.rows ?? rows).filter(isInteractiveSession).slice(0, RESUME_PREVIEW_ROWS)
    })
    this.previewLoad = load
    void load.finally(() => { if (this.previewLoad === load) this.previewLoad = null }).catch(() => {})
    return load
  }

  all(): Promise<SessionMeta[]> {
    if (this.disposed) return Promise.resolve([])
    if (this.full && this.rows !== null) return Promise.resolve(this.rows)
    if (this.fullLoad) return this.fullLoad
    const generation = this.generation
    const load = this.client.listSessions(0).then(rows => {
      if (generation !== this.generation) return this.rows ?? []
      // Full-text rows include all metadata. A slower plain listing must not
      // downgrade the richer snapshot already published in this generation.
      if (this.textRows !== null) return this.textRows
      this.rows = rows
      this.full = true
      this.onLoaded(rows)
      return rows
    })
    this.fullLoad = load
    void load.finally(() => { if (this.fullLoad === load) this.fullLoad = null }).catch(() => {})
    return load
  }

  /** Every session's text. Only a typed filter needs this much. */
  text(): Promise<SessionWithText[]> {
    if (this.disposed) return Promise.resolve([])
    if (this.textRows !== null) return Promise.resolve(this.textRows)
    if (this.textLoad) return this.textLoad
    const generation = this.generation
    const load = this.client.listSessionsWithText(0).then(rows => {
      if (generation !== this.generation) return this.textRows ?? []
      this.textRows = rows
      this.textIndex = null
      this.textGeneration++
      this.rows = rows
      this.full = true
      this.onLoaded(rows)
      return rows
    })
    this.textLoad = load
    void load.finally(() => { if (this.textLoad === load) this.textLoad = null }).catch(() => {})
    return load
  }

  /**
   * One session's text, for the focused preview row.
   *
   * Coalesced per session and dropped on invalidation. Resolves to null when
   * the session is gone or the read failed; the row then keeps its metadata
   * preview rather than showing an error in a recognition aid.
   */
  loadSessionText(sessionId: string): Promise<SessionWithText | null> {
    if (this.disposed) return Promise.resolve(null)
    const known = this.sessionText(sessionId)
    if (known && (!this.client.loadTranscript || known.recognition)) return Promise.resolve(known)
    const inFlight = this.focusedLoads.get(sessionId)
    if (inFlight) return inFlight
    const generation = this.generation
    const load = (known ? Promise.resolve(known) : this.client.sessionWithText(sessionId)).then(async row => {
      if (generation !== this.generation || row === null) return null
      if (this.client.loadTranscript) {
        try {
          const transcript = await this.client.loadTranscript(sessionId)
          row = enrichSessionRecognition(row, transcript)
        } catch {
          // Keep the existing search excerpt; another focus can retry enrichment.
        }
      }
      if (generation !== this.generation || row === null) return null
      this.focusedText.set(sessionId, row)
      this.textGeneration++
      if (this.focusedText.size > FOCUSED_TEXT_LIMIT) {
        const oldest = this.focusedText.keys().next()
        if (!oldest.done) this.focusedText.delete(oldest.value)
      }
      return row
    }, () => null)
    this.focusedLoads.set(sessionId, load)
    void load.finally(() => {
      if (this.focusedLoads.get(sessionId) === load) this.focusedLoads.delete(sessionId)
    }).catch(() => {})
    return load
  }
}
