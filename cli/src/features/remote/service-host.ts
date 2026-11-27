import type { HostElection } from './host-election.js'

interface Services {
  eligible(): boolean
  preflight(): Promise<void>
  gone(id: string): Promise<boolean>
  /** Idempotently ensure Console first, then Remote iff enabled. */
  start(current: () => boolean): Promise<string>
  /** Drain this process only. On refusal neither service may be given away. */
  stop(): Promise<void>
  notice(text: string): void
}

/** One single-flight reconciler per TUI. No HTTP, agent run, or slow drain inside
 * an election transaction. All completions are fenced by their original ballot. */
export class ServiceHost {
  private physical = false
  private serving = false
  private disposed = false
  private requested: number | null = null
  private waitUntil = 0
  private retry = 0
  private check = 0
  private pending?: Promise<void>
  private closing?: Promise<void>
  constructor(private election: HostElection, private services: Services, private explicit: boolean) {}
  get owner() { return this.serving }
  /** /remote on is an invitation, never a takeover. It can fill an empty slot
   * (including from tmux) or wake this owner without waiting for maintenance. */
  invite() {
    if (this.disposed) return false
    const b = this.election.request(false)
    this.check = 0
    return b.target === this.election.id
  }
  tick() {
    return this.pending ??= this.step().finally(() => { this.pending = undefined })
  }
  private async step() {
    if (this.disposed) return
    const e = this.election, s = this.services
    if (this.explicit) {
      this.explicit = false
      try {
        await s.preflight()
        if (this.disposed) return
        const b = e.request(true)
        this.requested = b.epoch; this.waitUntil = Date.now() + 15_000
        s.notice(b.previous ? `Taking over services from ${b.previous.slice(0,8)}…` : 'Starting service host…')
      } catch (err) { s.notice(`Host takeover refused: ${message(err)}`); this.retry = Date.now() + 15000; return }
    }
    let b = e.ballot()
    if (!b.target && s.eligible() && Date.now() >= this.retry) b = e.request(false)
    if (this.requested !== null && b.epoch !== this.requested) {
      s.notice(b.error ? `Host takeover failed: ${b.error}` : 'Host request superseded.')
      this.requested = null
    }
    if (b.target !== e.id) {
      if (this.physical) {
        try { await this.release() }
        catch (err) { if (!this.disposed && b.previous === e.id) e.reject(b,message(err)); return }
        if (b.target && !this.disposed) s.notice(`Released services for ${b.target.slice(0,8)}.`)
      }
      if (b.target && Date.now() >= Math.max(this.check,b.target === b.previous ? b.reserved : 0)) {
        this.check = Date.now() + 5000
        if (await s.gone(b.target) && !this.disposed) e.reject(b)
      }
      return
    }
    if (!this.physical && !e.acquire()) {
      if (this.requested === b.epoch && Date.now() >= this.waitUntil) {
        this.retry = Date.now() + 15000
        e.reject(b,'Previous host did not release its services in time.')
      }
      return
    }
    this.physical = true
    const current = () => !this.disposed && e.ballot().epoch === b.epoch
    if (this.serving && b.previous === e.id && Date.now() < this.check) return
    try {
      const label = await s.start(current)
      if (!current() || !e.ready(b.epoch)) return // next tick drains; never publish stale success
      this.serving = true; this.check = Date.now() + 5000
      if (this.requested !== null) s.notice(`Hosting ${label} in this window.`)
      this.requested = null
    } catch (err) {
      if (this.disposed) return
      const reason = message(err)
      // Fence rollback before draining, but hold the physical lease until both stop.
      if (e.reject(b,reason)) {
        if (this.requested !== null || this.serving) s.notice(`Could not host services: ${reason}`)
        this.requested = null
      }
      this.retry = Date.now() + 15000
      await this.release()
    }
  }
  private async release() {
    await this.services.stop()
    this.serving = this.physical = false
    this.check = 0
    this.election.release()
  }
  dispose(restarting: boolean) {
    return this.closing ??= this.finish(restarting).catch(err => { this.closing = undefined; throw err })
  }
  private async finish(restarting: boolean) {
    if (!this.disposed) {
      this.disposed = true
      if (restarting && this.serving) this.election.reserve(Date.now()); else this.election.leave()
    }
    // The process is about to exit/exec. Do not unlock in the gap before a
    // pending native start/drain returns and cleanup has closed the listeners.
    await this.pending?.catch(() => {})
    if (this.physical) await this.release()
    this.election.close()
  }
}
const message = (err: unknown) => err instanceof Error ? err.message : String(err)
