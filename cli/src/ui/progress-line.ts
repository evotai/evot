/**
 * A committed line that is rewritten in place while work is in flight.
 *
 * Phase updates are current state, not history: stacking `downloading…`,
 * `extracting…`, `installing…` as separate rows buries the result that follows
 * them. This commits once, then rewrites that same line by id, and finally
 * replaces it with the outcome — so a whole operation costs one row of
 * scrollback.
 *
 * Distinct from the status slots in `app/status-line.ts`, which collapse
 * repeated commits of a known id. Here the id is unique per operation, so two
 * concurrent operations never overwrite each other's line.
 */

export interface ProgressLinePort {
  /** Commit the line for the first time. */
  commit: (id: string, text: string) => void
  /** Rewrite the committed line. False when it is gone (normal after `/clear`). */
  replace: (id: string, text: string) => boolean
}

export interface ProgressLine {
  /** Show the current phase. */
  update: (text: string) => void
  /** Replace the line with the final result. */
  finish: (text: string) => void
}

export function createProgressLine(id: string, port: ProgressLinePort): ProgressLine {
  let committed = false
  const paint = (text: string): void => {
    // A cleared transcript drops the line; committing again is the honest
    // recovery, and it keeps the outcome visible rather than silently lost.
    if (committed && port.replace(id, text)) return
    committed = true
    port.commit(id, text)
  }
  return { update: paint, finish: paint }
}
