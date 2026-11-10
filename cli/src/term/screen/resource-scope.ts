/** Registers only resources that actually exist, including during partial
 * startup. Cleanup is idempotent and one failing disposer cannot strand others. */
export class ResourceScope {
  private callbacks: Array<() => void> = []
  private disposed = false

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  add(dispose: () => void): void {
    if (this.disposed) this.release(dispose)
    else this.callbacks.push(dispose)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const callbacks = this.callbacks
    this.callbacks = []
    for (const callback of callbacks.reverse()) this.release(callback)
  }

  private release(callback: () => void): void {
    try {
      callback()
    } catch (error) {
      try { this.onError(error) } catch {
        // Error reporting must not prevent the remaining resources releasing.
      }
    }
  }
}
