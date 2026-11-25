/**
 * Double-press confirmation scoped to an operation, not a terminal session.
 *
 * The first press arms a short window for one owner (a query stream, a manual
 * compaction). Only a second press for the same owner inside that window
 * confirms; a new owner or an expired window starts over.
 */
export class InterruptConfirmation {
  private owner: unknown = null
  private deadline = 0
  constructor(private readonly now = Date.now, private readonly windowMs = 5000) {}
  press(owner: unknown): boolean {
    if (this.pending(owner)) { this.clear(); return true }
    this.owner = owner
    this.deadline = this.now() + this.windowMs
    return false
  }
  /** Whether a first press for `owner` is still awaiting its confirmation. */
  pending(owner: unknown): boolean {
    return owner !== null && this.owner === owner && this.now() < this.deadline
  }
  clear(): void { this.owner = null; this.deadline = 0 }
}
