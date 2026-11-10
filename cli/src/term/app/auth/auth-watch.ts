/**
 * Cross-process cloud auth awareness: every evot shares ~/.evotai, so one tab's
 * /login or key recovery must not leave the others on stale files.
 *
 * Reloading is idempotent, so detection is just a content digest — no need to
 * classify what changed.
 */

import { createHash } from 'crypto'
import { readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const WATCHED = ['auth.json', 'models.cache.json'] as const
const DEBOUNCE_MS = 120
const RETRY_MS = 5_000

export function stateRootDir(): string {
  return join(homedir(), '.evotai')
}

/** Digest of the shared auth files; a missing file is just another value. */
export function readAuthStamp(root = stateRootDir()): string {
  const digest = createHash('sha256')
  for (const name of WATCHED) {
    try {
      digest.update(readFileSync(join(root, name)))
    } catch {
      digest.update('\u0000absent')
    }
    digest.update('\u0001')
  }
  return digest.digest('hex')
}

/**
 * Fires `onChange` when the shared auth files actually change.
 *
 * Watches the directory, not the files: state is published by temp file plus
 * atomic rename, so a file-level watch goes deaf after the first write replaces
 * the inode.
 */
export class AuthWatcher {
  private root: string
  private stamp: string
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private onChange: () => void

  constructor(onChange: () => void, root = stateRootDir()) {
    this.onChange = onChange
    this.root = root
    this.stamp = readAuthStamp(root)
    this.start()
  }

  getStamp(): string {
    return this.stamp
  }

  /** Re-read and report movement. Callers use this to absorb their own writes. */
  sync(): boolean {
    const next = readAuthStamp(this.root)
    const changed = next !== this.stamp
    this.stamp = next
    return changed
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer('debounceTimer')
    this.clearTimer('retryTimer')
    this.closeWatcher()
  }

  private start(): void {
    if (this.disposed) return
    this.closeWatcher()
    try {
      // No filename filter: state is published as `.auth.json.tmp` then renamed,
      // and macOS reports only the temp name. The digest is the real filter.
      const watcher = watch(this.root, () => this.schedule())
      watcher.on('error', () => this.retry())
      this.watcher = watcher
      // FSEvents registration is async: a write landing in that gap emits no
      // event, so reconcile once after starting.
      this.schedule()
    } catch {
      this.retry()
    }
  }

  private schedule(): void {
    if (this.disposed || this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.disposed) return
      if (this.sync()) this.onChange()
    }, DEBOUNCE_MS)
  }

  private retry(): void {
    if (this.disposed || this.retryTimer) return
    this.closeWatcher()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, RETRY_MS)
    this.retryTimer.unref?.()
  }

  private closeWatcher(): void {
    if (!this.watcher) return
    try { this.watcher.close() } catch { /* already gone */ }
    this.watcher = null
  }

  private clearTimer(field: 'debounceTimer' | 'retryTimer'): void {
    const timer = this[field]
    if (timer) {
      clearTimeout(timer)
      this[field] = null
    }
  }
}
