/** Usable cells inside a centred terminal modal (two columns and one row of margin on each side). */
export function overlaySize(columns: number, rows: number): { width: number; height: number } {
  return { width: Math.max(1, columns - 4), height: Math.max(1, rows - 2) }
}
