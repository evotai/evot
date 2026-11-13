/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Ported from pi-tui:
 *   ~/github/pi/packages/tui/src/undo-stack.ts
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
  private stack: S[] = []

  /** Push a deep clone of the given state onto the stack. */
  push(state: S): void {
    this.stack.push(structuredClone(state))
  }

  /** Pop and return the most recent snapshot, or undefined if empty. */
  pop(): S | undefined {
    return this.stack.pop()
  }

  /** Remove all snapshots. */
  clear(): void {
    this.stack.length = 0
  }

  snapshot(): S[] {
    return structuredClone(this.stack)
  }

  restore(states: S[]): void {
    this.stack = structuredClone(states)
  }

  get length(): number {
    return this.stack.length
  }
}
