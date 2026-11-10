/** Data-only boundary between layout producers and terminal backends. */
export interface RenderOverlay {
  lines: string[]
}

export interface RenderFrame {
  lines: string[]
  /**
   * Leading rows that are append-only by index: a later frame may rewrite row
   * `i`'s text but must never insert or delete rows before it. Reshaping this
   * prefix requires an explicit `invalidateScrollback()`. Rows at or after this
   * index are the live region. Hidden live changes remain provisional until
   * committed, when stale scrollback is repaired once. Defaults to the whole frame.
   */
  committedRows?: number
  /** Preserve the trailing edge only after durable content naturally reaches
   * the viewport bottom; this never initially pins a short conversation. */
  bottomAnchor?: boolean
  /** Boundary between committed content and the repaintable live region.
   * Anchored shrinkage is absorbed here rather than above all history. */
  bottomAnchorStart?: number
  /** Transient selector/ask rows can borrow space but cannot establish an
   * anchor. Closing a window must not leave a blank hole behind. */
  transientRows?: number
  overlay?: RenderOverlay
}

/** Zero-width native cursor/IME position. Interpreted and stripped by the backend. */
export const CURSOR_MARKER = '\x1b_pi:c\x07'
