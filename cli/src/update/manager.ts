/**
 * UpdateManager — automatic update check scheduler with event emission.
 * Checks, then stages the download in the background; does not install.
 *
 * Events:
 *   'update-available' → ReleaseInfo   a newer release exists
 *   'update-status'    → UpdateStatus  background staging progress
 *
 * Failures are deliberately not emitted: an unreachable GitHub is not something
 * to nag the user about, and checkForUpdate already persists the reason so
 * `/update` can explain it after the fact. `failureCount` exposes the backoff
 * state for callers that care.
 */

import { EventEmitter } from 'events'
import type { ReleaseInfo } from './types.js'
import { checkForUpdate } from './check.js'
import { compareVersions } from './version.js'
import { readStaged, stageUpdate, pruneStaleStaging } from './stage.js'
import { installedVersionForThisProcess, isManagedInstall } from './state.js'

const INITIAL_DELAY = 3_000           // 3s after start
const PERIODIC_CHECK = 5 * 60_000     // poll cache every 5 min; network TTL is 10 min
const STAGED_STATUS_POLL = 60_000      // notice downloads completed by another evot process
const BACKOFF_RETRY = 60 * 60_000     // probe once an hour after backing off
/**
 * Consecutive failures before the scheduler pauses routine checks. GitHub
 * allows 60 unauthenticated requests/hour/IP, so a shared egress IP can be
 * throttled for reasons this process cannot fix. The pause is bounded: one
 * probe is allowed after BACKOFF_RETRY so a transient outage cannot disable
 * updates for the rest of a long-running session.
 */
const MAX_CONSECUTIVE_FAILURES = 5

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'downloading'; version: string }
  | { kind: 'staged'; version: string }

export class UpdateManager extends EventEmitter {
  private currentVersion: string
  private now: () => number
  private initialTimer: ReturnType<typeof setTimeout> | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private stagedStatusTimer: ReturnType<typeof setInterval> | null = null
  private lastNotifiedVersion: string | null = null
  private latestRelease: ReleaseInfo | null = null
  private consecutiveFailures = 0
  private retryAfter = 0
  private inFlight = false
  private stopped = false
  private status: UpdateStatus = { kind: 'idle' }
  private stagingAbort: AbortController | null = null
  private stage: typeof stageUpdate

  constructor(
    currentVersion: string,
    now: () => number = Date.now,
    stage: typeof stageUpdate = stageUpdate,
  ) {
    super()
    this.currentVersion = currentVersion
    this.now = now
    this.stage = stage
    // A previous session may have left a verified download behind. Surface it
    // immediately instead of waiting for the first check to re-discover it.
    // Only for a managed install: a source checkout will never apply it, so
    // offering a restart there would be a notice that can never resolve.
    const staged = isManagedInstall() ? readStaged() : null
    if (staged) {
      this.status = { kind: 'staged', version: staged.version }
      pruneStaleStaging()
    }
  }

  /** Start the scheduler: delayed first check + periodic checks. */
  start(): void {
    this.initialTimer = setTimeout(() => {
      void this.check()
    }, INITIAL_DELAY)

    this.periodicTimer = setInterval(() => {
      void this.check()
    }, PERIODIC_CHECK)

    // Staging is shared by every evot process. Polling this small local manifest
    // lets an already-open session notice a download completed by another one.
    this.stagedStatusTimer = setInterval(() => {
      this.syncStagedStatus()
    }, STAGED_STATUS_POLL)
  }

  /** Current background-download status, for persistent UI surfaces. */
  getStatus(): UpdateStatus {
    return this.status
  }

  /**
   * Run a check. Background checks honour the on-disk TTL, so the periodic
   * timer costs a file read rather than a network round trip most of the time.
   */
  async check(opts?: { force?: boolean }): Promise<void> {
    if (this.stopped) return
    this.syncStagedStatus()
    if (this.inFlight) return

    const force = opts?.force ?? false
    const reachedFailureLimit = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
    if (reachedFailureLimit && !force && this.now() < this.retryAfter) return

    // A scheduled recovery probe must bypass a still-present disk cache or it
    // would report the cached answer as success without testing connectivity.
    const forceNetwork = force || reachedFailureLimit
    this.inFlight = true
    try {
      const result = await checkForUpdate(this.currentVersion, { force: forceNetwork })

      if (result.kind === 'error') {
        this.recordFailure()
        return
      }

      // A stale answer came from cache because the network attempt failed. The
      // user still gets a correct-as-of-last-check result, but the scheduler
      // must count it as a failure or it will never back off.
      if (result.stale) {
        this.recordFailure()
      } else {
        this.consecutiveFailures = 0
        this.retryAfter = 0
      }

      if (result.kind === 'available') {
        // Keep the newest target even if a later check returns stale data.
        if (!this.latestRelease || compareVersions(result.latest.version, this.latestRelease.version) > 0) {
          this.latestRelease = result.latest
        }
        if (this.latestRelease.version !== this.lastNotifiedVersion) {
          this.lastNotifiedVersion = this.latestRelease.version
          this.emit('update-available', this.latestRelease)
        }
        // Only notifications are deduplicated. Failed downloads retry on the
        // next scheduled check, independently of whether we already notified.
        this.maybeStage(this.latestRelease)
      }
    } catch {
      this.recordFailure()
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Kick off a background download unless disabled or already superseded.
   *
   * EVOT_AUTO_DOWNLOAD=0 opts out entirely — metered connections and shared
   * machines are the use cases. An existing staged version that already
   * matches or beats the candidate means there is nothing to do either.
   */
  private maybeStage(release: ReleaseInfo): void {
    if (process.env.EVOT_AUTO_DOWNLOAD === '0') return
    if (this.stopped || this.stagingAbort) return
    // A source checkout cannot apply what it downloads, so fetching 37 MB into
    // the user's shared staging directory would be pure waste. `/update` stays
    // available there because it is user-initiated.
    if (!isManagedInstall()) return
    // CalVer compare: string order sorts 2026.9.30 after 2026.10.1.
    if (this.status.kind === 'staged' && compareVersions(this.status.version, release.version) >= 0) return
    // Another evot already installed this release. Downloading it again would
    // re-fetch 37 MB to reach a state the disk is already in; this session only
    // needs a restart to pick it up.
    const installed = installedVersionForThisProcess()
    if (installed && compareVersions(installed, release.version) >= 0) {
      this.setStatus({ kind: 'staged', version: installed })
      return
    }

    this.setStatus({ kind: 'downloading', version: release.version })
    const controller = new AbortController()
    this.stagingAbort = controller

    this.stage(release, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          this.setStatus({ kind: 'staged', version: release.version })
        }
      })
      .catch(() => {
        // Silent by contract: the manual `/update` path reports failures with
        // full context, and a transient outage self-heals on the next check.
        // Fall back to shared state rather than plain idle: a newer version may
        // already be installed on disk, and dropping that notice would hide a
        // restart the user still needs.
        if (!controller.signal.aborted) {
          this.setStatus({ kind: 'idle' })
          this.syncStagedStatus()
        }
      })
      .finally(() => {
        if (this.stagingAbort !== controller) return
        this.stagingAbort = null
        // A check may have found a newer release while this download was busy.
        // Hand over immediately, but leave retries of the same failed version
        // to the scheduler so an outage cannot cause a tight download loop.
        if (this.latestRelease && compareVersions(this.latestRelease.version, release.version) > 0) {
          this.maybeStage(this.latestRelease)
        }
      })
  }

  /**
   * Refresh state produced by another evot process.
   *
   * Two shared sources, in order of finality: a completed install on disk, and
   * a verified download waiting in staging. Either means this session is behind
   * and a restart is what resolves it.
   */
  private syncStagedStatus(): void {
    // A source checkout never applies an update, so it must not advertise a
    // restart it cannot honour.
    if (!isManagedInstall()) return
    const installed = installedVersionForThisProcess()
    if (installed && compareVersions(this.currentVersion, installed) < 0) {
      this.adoptSharedVersion(installed)
      return
    }
    const staged = readStaged()
    if (!staged || compareVersions(this.currentVersion, staged.version) >= 0) return
    this.adoptSharedVersion(staged.version)
  }

  /** Surface a shared newer version without downgrading a further-ahead state. */
  private adoptSharedVersion(version: string): void {
    const activeVersion = this.status.kind === 'idle' ? null : this.status.version
    if (activeVersion && compareVersions(activeVersion, version) >= 0) return
    this.setStatus({ kind: 'staged', version })
  }

  private setStatus(status: UpdateStatus): void {
    const currentVersion = this.status.kind === 'idle' ? null : this.status.version
    const nextVersion = status.kind === 'idle' ? null : status.version
    if (this.status.kind === status.kind && currentVersion === nextVersion) return
    this.status = status
    this.emit('update-status', status)
  }

  private recordFailure(): void {
    this.consecutiveFailures++
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.retryAfter = this.now() + BACKOFF_RETRY
    }
  }

  /** Consecutive failed checks; resets to 0 on the next success. */
  get failureCount(): number {
    return this.consecutiveFailures
  }

  /** True while routine checks are paused before the next recovery probe. */
  get backedOff(): boolean {
    return this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && this.now() < this.retryAfter
  }

  /** Clean up timers and abort an in-flight background download. */
  cleanup(): void {
    this.stopped = true
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
    if (this.stagedStatusTimer) {
      clearInterval(this.stagedStatusTimer)
      this.stagedStatusTimer = null
    }
    this.stagingAbort?.abort()
    this.stagingAbort = null
  }
}
