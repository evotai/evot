/**
 * Generic external session-hook bridge.
 *
 * evot emits versioned NDJSON lifecycle events to the executable configured as
 * `session_hook` (evot.toml) or EVOT_SESSION_HOOK (env file, process env). The
 * executable owns integration-specific behavior; evot deliberately does not
 * know which service consumes these events.
 *
 * Two rules keep a third-party adapter from ever affecting evot:
 * - every write is best-effort; a dead or wedged adapter is dropped, not retried
 * - shutdown never waits for the adapter process to exit. Adapters are expected
 *   to be long-lived, so waiting on them would hang evot forever.
 */

/** Upper bound on how long shutdown waits for queued writes to drain. */
const FLUSH_TIMEOUT_MS = 250

export type SessionHookState = 'working' | 'blocked' | 'idle'

export interface SessionHookEvent {
  version: 1
  event:
    | 'session_started'
    | 'state_changed'
    | 'run_started'
    | 'run_finished'
    | 'run_failed'
    | 'session_ended'
  session_id?: string
  run_id?: string
  state?: SessionHookState
  message?: string
  reason?: string
  cwd?: string
  source?: string
}

/**
 * The slice of a spawned process this module is allowed to touch. `exited` is
 * deliberately absent: awaiting it would block shutdown on a persistent adapter.
 */
interface HookProcess {
  stdin: {
    write(data: string): unknown
    end?(): unknown
  }
}

export interface SessionHookOptions {
  /** From `ConfigInfo.sessionHook`: config already resolved TOML < env file <
   * process env, so this module never reads the environment itself. */
  command?: string
  cwd?: string
  spawn?: (command: string, cwd?: string) => HookProcess
}

function defaultSpawn(command: string, cwd?: string): HookProcess {
  return Bun.spawn([command], {
    cwd,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    // New session, so the adapter cannot reach evot's controlling terminal and
    // take the foreground — that stops evot with SIGTTIN, which the shell
    // reports as `suspended (tty input)`. Costs the SIGHUP an adapter would
    // otherwise get when the terminal closes; shutdown already relies on stdin
    // EOF, and an adapter ignoring that would have outlived `/exit` regardless.
    detached: true,
  }) as unknown as HookProcess
}

function normalize(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** Bun's FileSink returns a byte count normally, but a Promise under backpressure. */
function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as Promise<unknown> | undefined)?.then === 'function'
}

function ignore(): void {}

/** Resolve with `work`, or after `ms`, whichever comes first. Never rejects. */
function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    work.then(ignore, ignore).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * A best-effort, long-lived writer for one external integration process.
 *
 * The hook owns run lifecycle state so callers never track "did I already
 * settle this run?" themselves: `runFinished`, `runFailed`, and `settleRun`
 * are all no-ops once the open run has been settled.
 */
export class SessionHook {
  private readonly command: string | null
  private readonly cwd: string | undefined
  private readonly spawn: (command: string, cwd?: string) => HookProcess
  private proc: HookProcess | null = null
  private closed = false
  private started = false
  private sessionId: string | undefined
  private runOpen = false
  private runId: string | undefined
  /** Tail of the write chain; null while every write has completed synchronously. */
  private tail: Promise<void> | null = null
  private closing: Promise<void> | null = null

  constructor(options: SessionHookOptions = {}) {
    this.command = normalize(options.command) ?? null
    this.cwd = options.cwd
    this.spawn = options.spawn ?? defaultSpawn
  }

  get enabled(): boolean {
    return this.command !== null
  }

  /** Announce the running evot process before a persisted session exists. */
  startProcess(cwd: string): void {
    if (this.closed || this.started) return
    this.started = true
    this.send('session_started', { cwd, source: 'evot' })
  }

  startSession(sessionId: string, cwd: string): void {
    const next = normalize(sessionId)
    if (this.closed || !next || next === this.sessionId) return
    if (this.sessionId) this.send('session_ended', { reason: 'session_changed' })
    this.clearRun()
    this.started = true
    this.sessionId = next
    this.send('session_started', { cwd, source: 'evot' })
  }

  state(state: SessionHookState, message?: string): void {
    this.send('state_changed', {
      state,
      message: state === 'blocked' ? normalize(message) : undefined,
    })
  }

  runStarted(runId?: string): void {
    if (this.closed || !this.started) return
    this.runOpen = true
    this.runId = normalize(runId)
    this.send('run_started', { run_id: this.runId })
    this.state('working')
  }

  /** Settle the open run as successful. No-op once the run has been settled. */
  runFinished(runId?: string): void {
    if (!this.runOpen) return
    this.send('run_finished', { run_id: this.takeRun(runId) })
    this.state('idle')
  }

  /** Settle the open run as failed. No-op once the run has been settled. */
  runFailed(runId?: string, message?: string): void {
    if (!this.runOpen) return
    this.send('run_failed', { run_id: this.takeRun(runId), message: normalize(message) })
    this.state('idle')
  }

  /**
   * Return an abandoned run to idle without a verdict: interrupts and aborted
   * streams settle here so an adapter never stays stuck on working/blocked.
   */
  settleRun(): void {
    if (!this.runOpen) return
    this.clearRun()
    this.state('idle')
  }

  /** Mark the current session as ended while keeping the hook reusable. */
  endSession(reason = 'session_changed'): void {
    if (this.closed || !this.started) return
    this.clearRun()
    this.send('session_ended', { reason })
    this.started = false
    this.sessionId = undefined
  }

  /**
   * Emit `session_ended` and release the adapter's stdin. Waits only for queued
   * writes, and only briefly: a wedged adapter must not delay evot's exit.
   */
  close(reason = 'process_exit'): Promise<void> {
    if (this.closing) return this.closing
    this.endSession(reason)
    this.closed = true

    const proc = this.proc
    this.closing = atMost(this.tail ?? Promise.resolve(), FLUSH_TIMEOUT_MS).then(() => {
      if (!proc) return
      try {
        const result = proc.stdin.end?.()
        // Never awaited: under backpressure this rejects with EPIPE, and a
        // healthy adapter may outlive us. The pipe already owns the bytes.
        if (isThenable(result)) result.then(ignore, ignore)
      } catch {
        // A dead adapter must never affect evot shutdown.
      }
    })
    return this.closing
  }

  private clearRun(): void {
    this.runOpen = false
    this.runId = undefined
  }

  /** Close the open run and return the id to report. */
  private takeRun(runId?: string): string | undefined {
    const id = normalize(runId) ?? this.runId
    this.clearRun()
    return id
  }

  private send(
    event: SessionHookEvent['event'],
    fields: Partial<SessionHookEvent> = {},
  ): void {
    if (this.closed || !this.started) return
    this.write({ version: 1, event, session_id: this.sessionId, ...fields })
  }

  private write(event: SessionHookEvent): void {
    if (!this.command) return
    if (!this.proc) {
      try {
        this.proc = this.spawn(this.command, this.cwd)
      } catch {
        // Missing or non-executable adapter: stay silent for the whole session.
        return
      }
    }

    const proc = this.proc
    const line = `${JSON.stringify(event)}\n`
    // Write inline while the sink accepts it synchronously, so events still
    // reach the pipe when the process leaves via fastExit(). Only backpressure
    // pushes us onto the async tail, which close() then drains.
    const push = (): Promise<void> | null => {
      try {
        const result = proc.stdin.write(line)
        if (isThenable(result)) {
          return result.then(ignore, () => this.drop(proc))
        }
      } catch {
        this.drop(proc)
      }
      return null
    }

    if (this.tail) {
      this.tail = this.tail.then(async () => {
        await push()
      })
    } else {
      this.tail = push()
    }
  }

  /** Forget a broken adapter so later events do not keep retrying a dead pipe. */
  private drop(proc: HookProcess): void {
    if (this.proc === proc) this.proc = null
  }
}
