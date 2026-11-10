/** Periodic host work, separate from agent-spawned shell processes and render
 * animation. Each job is single-flight, cancellable and owned by one scheduler. */
export interface BackgroundJob {
  name: string
  intervalMs: number
  run: (signal: AbortSignal) => void | Promise<void>
  onError?: (error: unknown) => void
  immediate?: boolean
  initialDelayMs?: number
}

export class BackgroundScheduler {
  #jobs = new Map<string, { trigger: () => Promise<void>; stop: () => void }>()
  #disposed = false

  register(job: BackgroundJob): () => void {
    if (this.#disposed) throw new Error('Background scheduler is disposed')
    if (this.#jobs.has(job.name)) throw new Error(`Background job already registered: ${job.name}`)
    if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) throw new Error('Invalid background interval')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let inflight: Promise<void> | undefined
    const schedule = (delay: number) => {
      if (controller.signal.aborted) return
      timer = setTimeout(() => { timer = undefined; void trigger() }, delay)
      timer.unref?.()
    }
    const trigger = (): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve()
      if (inflight) return inflight
      if (timer) clearTimeout(timer)
      timer = undefined
      inflight = Promise.resolve().then(() => {
        if (!controller.signal.aborted) return job.run(controller.signal)
      }).catch(error => {
        if (!controller.signal.aborted) {
          try { job.onError?.(error) } catch { /* Observers cannot break scheduling. */ }
        }
      }).finally(() => {
        inflight = undefined
        schedule(job.intervalMs)
      })
      return inflight
    }
    const stop = () => {
      controller.abort()
      if (timer) clearTimeout(timer)
      this.#jobs.delete(job.name)
    }
    this.#jobs.set(job.name, { trigger, stop })
    schedule(job.initialDelayMs ?? (job.immediate === false ? job.intervalMs : 0))
    return stop
  }

  trigger(name: string): Promise<void> {
    return this.#jobs.get(name)?.trigger() ?? Promise.resolve()
  }

  dispose(): void {
    this.#disposed = true
    for (const job of this.#jobs.values()) job.stop()
  }
}
