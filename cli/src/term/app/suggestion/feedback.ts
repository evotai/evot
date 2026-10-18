const FRAME_INTERVAL_MS = 100

/** Owns only animation timing, never request state or rendering. */
export class SuggestionTicker {
  private timer: ReturnType<typeof setInterval> | null = null
  frame = 0

  constructor(private readonly host: { pending(): boolean; changed(): void }) {}

  sync(): void {
    if (!this.host.pending()) { this.dispose(); return }
    if (this.timer) return
    this.frame = 0
    this.timer = setInterval(() => {
      if (!this.host.pending()) { this.dispose(); return }
      this.frame++
      this.host.changed()
    }, FRAME_INTERVAL_MS)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
