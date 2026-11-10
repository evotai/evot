/** A single disposable wakeup. Rendering supplies a delay; the scheduler owns
 * timers and prevents stale callbacks from repainting a newer/disposed host. */
export interface WakeupClock {
  schedule(callback: () => void, delayMs: number): () => void
}

const systemClock: WakeupClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

export class RenderWakeup {
  private cancel: (() => void) | null = null
  private generation = 0
  private disposed = false

  constructor(private readonly requestRender: () => void, private readonly clock: WakeupClock = systemClock) {}

  replace(delayMs: number | null): void {
    this.clear()
    if (this.disposed || delayMs === null) return
    const generation = this.generation
    this.cancel = this.clock.schedule(() => {
      if (this.disposed || generation !== this.generation) return
      this.cancel = null
      this.generation++
      this.requestRender()
    }, delayMs)
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }

  private clear(): void {
    this.generation++
    this.cancel?.()
    this.cancel = null
  }
}
