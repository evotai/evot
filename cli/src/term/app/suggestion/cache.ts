const MAX_ENTRIES = 8
const TTL_MS = 30_000

/** In-memory, exact-input cache only. No persistence, guesses, or background
 * requests; cursor, conversation, task state and command data are in the key. */
export class SuggestionCache {
  private readonly entries = new Map<string, { candidates: string[]; expires: number }>()
  hits = 0
  misses = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  get(key: string): string[] | undefined {
    const entry = this.entries.get(key)
    if (!entry || entry.expires <= this.now()) {
      this.entries.delete(key)
      this.misses++
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return [...entry.candidates]
  }

  put(key: string, candidates: readonly string[]): void {
    if (!candidates.length) return
    this.entries.delete(key)
    this.entries.set(key, { candidates: [...candidates], expires: this.now() + TTL_MS })
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
