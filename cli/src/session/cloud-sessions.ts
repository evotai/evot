/**
 * Cloud session sync on the CLI side: which sessions are on the cloud, how
 * they relate to the server copy, and the background push after each run.
 *
 * Persistence, auth and transport stay native; this module decides what to
 * show and when to call. No terminal or renderer dependencies.
 */
import type { CloudPushResult, RemoteSession, SessionMeta } from '../native/index.js'
import { parsePrivacyStop, type PrivacyStop } from '../privacy/notice.js'

/** Who can read a cloud session, as `/share` names it. */
export type ShareAccess = 'private' | 'team' | 'public'

/** Access a synced cloud block grants: public wins, team rides on private. */
export function shareAccess(cloud: { visibility: 'private' | 'public'; team?: boolean }): ShareAccess {
  return cloud.visibility === 'public' ? 'public' : cloud.team ? 'team' : 'private'
}

export type CloudState = 'local' | 'synced' | 'push_pending' | 'pull_pending' | 'diverged' | 'remote_only'

/** Mirrors `evot::sync::cloud_state`: metadata only, so the list stays cheap. */
export function cloudState(local: SessionMeta | undefined, remote: RemoteSession | undefined): CloudState {
  if (!local) return remote ? 'remote_only' : 'local'
  const cloud = local.cloud
  if (!cloud) return 'local'
  const pushPending = local.updated_at > cloud.synced_at
  const pullPending = remote !== undefined && remote.seq > cloud.synced_seq
  if (pushPending && pullPending) return 'diverged'
  if (pushPending) return 'push_pending'
  if (pullPending) return 'pull_pending'
  return 'synced'
}

/** Row-leading marker. `☁` private, `👥` team, `🌐` public; the suffix says what is pending. */
export function cloudBadge(state: CloudState, visibility: 'private' | 'public' | undefined, team = false): string {
  if (state === 'local') return ''
  const base = visibility === 'public' ? '🌐' : team ? '👥' : '☁'
  switch (state) {
    case 'synced': return base
    case 'push_pending': return `${base}↑`
    case 'pull_pending': case 'remote_only': return `${base}⇣`
    case 'diverged': return `${base}!`
  }
}

/** Pending-state suffix shared by the badge and the list label. */
const PENDING: Record<Exclude<CloudState, 'local'>, string> = {
  synced: '', push_pending: '↑', pull_pending: '⇣', remote_only: '⇣', diverged: '!',
}

/** Width of the list's access column: the longest label plus its suffix. */
export const CLOUD_LABEL_WIDTH = 'private ⇣'.length

/**
 * The access column of the sessions list, spelled out: who can read the
 * session is the thing a user scans `/share` for, and a glyph (☁ renders as a
 * speck in many terminals, 👥 reads as "people", not "my team") leaves them
 * guessing. The suffix says what is pending, as on the badge.
 */
export function cloudLabel(state: CloudState, visibility: 'private' | 'public' | undefined, team = false): string {
  if (state === 'local') return ''
  const word = shareAccess({ visibility: visibility ?? 'private', team })
  const pending = PENDING[state]
  return pending ? `${word} ${pending}` : word
}

/** A remote-only row rendered from the server's metadata. The synthetic
 *  `cloud` block reads as "nothing synced yet, nothing changed here", so
 *  `cloudState` says pull and only pull. */
export function remoteAsLocal(remote: RemoteSession): SessionMeta {
  return {
    ...remote.meta,
    session_id: remote.session_id,
    cloud: {
      visibility: remote.visibility,
      synced_seq: 0,
      synced_at: remote.meta.updated_at,
      origin_host: remote.origin_host ?? '',
      public_url: remote.public_url ?? null,
      ...(remote.team ? { team: true, team_url: remote.team_url ?? null, team_name: remote.team_name ?? null } : {}),
    },
  }
}

/** Local rows first (their order kept), then remote-only rows by recency. */
export function mergeRemoteSessions(local: SessionMeta[], remote: RemoteSession[]): SessionMeta[] {
  if (remote.length === 0) return local
  const known = new Set(local.map(session => session.session_id))
  const extra = remote
    .filter(row => !known.has(row.session_id))
    .sort((a, b) => (b.meta.updated_at ?? '').localeCompare(a.meta.updated_at ?? ''))
    .map(remoteAsLocal)
  return extra.length === 0 ? local : [...local, ...extra]
}

export interface CloudSessionSyncDeps {
  push(sessionId: string, force: boolean): Promise<CloudPushResult>
  list(): Promise<RemoteSession[]>
  /** Called with a short line for the status area; `error` when a push failed. */
  notify(text: string, level: 'info' | 'error'): void
  /** Repaint an open list when the periodic refresh changes its remote rows. */
  indexUpdated?(): void
  /** Privacy blocked a push. Told once per session and set of kinds, since
   * every later run retries the same history and is blocked the same way. */
  privacyStopped?(sessionId: string, stop: PrivacyStop): void
}

/** Debounce after a run settles, so a rename right after does not double-push. */
const PUSH_DELAY_MS = 800

/**
 * Background pushes are single-flight per session and never block the prompt.
 * The remote index is cached; the periodic cloud tick refreshes it.
 */
export class CloudSessionSync {
  private remote = new Map<string, RemoteSession>()
  private inflight = new Map<string, Promise<CloudPushResult | null>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private indexLoad: Promise<void> | null = null
  private privacyTold = new Map<string, string>()
  private disposed = false

  constructor(private readonly deps: CloudSessionSyncDeps, private readonly delayMs = PUSH_DELAY_MS) {}

  remoteFor(sessionId: string): RemoteSession | undefined { return this.remote.get(sessionId) }
  get remoteSessions(): RemoteSession[] { return [...this.remote.values()] }

  stateFor(local: SessionMeta | undefined, sessionId = local?.session_id): CloudState {
    return cloudState(local, sessionId ? this.remote.get(sessionId) : undefined)
  }

  /** Refresh the owner's remote index. Empty when signed out; errors are swallowed. */
  refreshIndex(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.indexLoad) return this.indexLoad
    const load = this.deps.list().then(rows => {
      if (this.disposed) return
      this.remote = new Map(rows.map(row => [row.session_id, row]))
      this.deps.indexUpdated?.()
    }, () => {}).finally(() => { if (this.indexLoad === load) this.indexLoad = null })
    this.indexLoad = load
    return load
  }

  /** Forget a remote row locally (after unshare/delete) without a round trip. */
  forget(sessionId: string): void { this.remote.delete(sessionId) }

  /** Record a server acknowledgement so the list reflects it before the next refresh. */
  acknowledge(sessionId: string, result: CloudPushResult): void {
    if (result.kind !== 'synced') return
    const existing = this.remote.get(sessionId)
    if (existing) {
      const { cloud } = result
      this.remote.set(sessionId, {
        ...existing, seq: cloud.synced_seq, visibility: cloud.visibility, public_url: cloud.public_url ?? null,
        team: cloud.team ?? false, team_url: cloud.team_url ?? null, team_name: cloud.team_name ?? null,
      })
    }
  }

  /** After a run settles: push soon, silently, once. Local-only sessions are a no-op. */
  schedulePush(sessionId: string): void {
    if (this.disposed) return
    const pending = this.timers.get(sessionId)
    if (pending) clearTimeout(pending)
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId)
      void this.pushNow(sessionId)
    }, this.delayMs))
  }

  /** Immediate single-flight push; resolves null when a push for this session is already running. */
  pushNow(sessionId: string, force = false): Promise<CloudPushResult | null> {
    if (this.disposed) return Promise.resolve(null)
    const running = this.inflight.get(sessionId)
    if (running) return running
    const attempt = this.deps.push(sessionId, force).then(result => {
      this.privacyTold.delete(sessionId)
      this.acknowledge(sessionId, result)
      if (result.kind === 'diverged') {
        this.deps.notify(`${cloudBadge('diverged', undefined)} changed on another machine · open it from /sessions to choose a side`, 'error')
      }
      return result as CloudPushResult | null
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const stop = parsePrivacyStop(message)
      if (stop && this.deps.privacyStopped) {
        const key = stop.kind === 'blocked' ? stop.kinds.join(',') : stop.reason
        if (this.privacyTold.get(sessionId) !== key) this.deps.privacyStopped(sessionId, stop)
        this.privacyTold.set(sessionId, key)
      } else {
        this.deps.notify(`☁ sync failed, will retry after the next run · ${message}`, 'error')
      }
      return null
    }).finally(() => { if (this.inflight.get(sessionId) === attempt) this.inflight.delete(sessionId) })
    this.inflight.set(sessionId, attempt)
    return attempt
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/** One-line confirmation after `/share …`, shared by the command and the selector. */
export function describeShareResult(result: CloudPushResult, visibility: ShareAccess): string {
  switch (result.kind) {
    case 'synced': {
      const url = result.cloud.public_url
      if (visibility === 'public' && url) return `🌐 Public · ${url}  (live: the page follows this session)`
      const teamUrl = result.cloud.team_url
      if (visibility === 'team' && teamUrl) {
        const name = result.cloud.team_name ? ` ${result.cloud.team_name}` : ''
        return `👥 Team${name} · ${teamUrl}  (members sign in to read it; live: the page follows this session)`
      }
      return `☁ Shared to cloud · resume this session from any machine (${result.cloud.synced_seq} entries)`
    }
    case 'diverged':
      return `☁! This session changed on another machine (cloud at ${result.remote_seq}, local at ${result.local_seq}). /share cloud takes the cloud copy · /share local overwrites it with this one`
    case 'not_shared':
      return 'This session is not on the cloud. /share private to start syncing it.'
  }
}
