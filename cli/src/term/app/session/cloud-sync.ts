export interface CloudSyncDeps<T> {
  authenticated(): Promise<boolean>
  syncNotices(): Promise<T>
  syncModels(): Promise<unknown>
  noticesUpdated(notices: T): void
  modelsUpdated(): void
  now?: () => number
}

export interface CloudSyncResult {
  noticesSynced: boolean
  modelsSynced: boolean
}

/** Single-flight cloud refresh. Remote requests may finish after disposal, but
 * no further requests or host callbacks are allowed to start afterward. */
export class CloudSync<T> {
  private inflight: Promise<CloudSyncResult | null> | null = null
  private lastSyncedAt = 0
  private disposed = false
  private readonly now: () => number

  constructor(private readonly deps: CloudSyncDeps<T>, private readonly intervalMs = 15_000) {
    this.now = deps.now ?? Date.now
  }

  run(force = false): Promise<CloudSyncResult | null> {
    if (this.disposed) return Promise.resolve(null)
    if (this.inflight) return this.inflight
    if (!force && this.now() - this.lastSyncedAt < this.intervalMs) return Promise.resolve(null)
    const task = this.refresh().finally(() => { this.inflight = null })
    this.inflight = task
    return task
  }

  dispose(): void {
    this.disposed = true
  }

  private async refresh(): Promise<CloudSyncResult | null> {
    if (!await this.deps.authenticated() || this.disposed) return null
    let noticesSynced = false
    let modelsSynced = false
    try {
      const notices = await this.deps.syncNotices()
      if (this.disposed) return null
      noticesSynced = true
      this.deps.noticesUpdated(notices)
    } catch {
      // Independent refresh: notice failures must not prevent model recovery.
    }
    if (this.disposed) return null
    try {
      await this.deps.syncModels()
      if (this.disposed) return null
      modelsSynced = true
      this.deps.modelsUpdated()
    } catch {
      // Keep successfully refreshed public notices even when auth has expired.
    }
    if (this.disposed) return null
    this.lastSyncedAt = this.now()
    return { noticesSynced, modelsSynced }
  }
}

/** Announces each cloud model id at most once per session. A model that
 * flaps in and out of the catalog (for example when another client keeps
 * rewriting the shared models cache) must not re-trigger the notice. */
export class ModelAnnouncer {
  private readonly seen = new Set<string>()

  /** Marks every id as already announced without reporting it. */
  seed(ids: Iterable<string>): void {
    for (const id of ids) this.seen.add(id)
  }

  /** Returns ids never seen before and records them. */
  fresh<M extends { model: string }>(models: readonly M[]): M[] {
    const added: M[] = []
    for (const m of models) {
      if (this.seen.has(m.model)) continue
      this.seen.add(m.model)
      added.push(m)
    }
    return added
  }
}
