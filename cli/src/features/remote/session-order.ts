import type { Phase } from './discovery.js'

interface Activity { phase?: Phase; updatedAt?: number; unshared?: boolean }
function tier({ phase, unshared }: Activity): number {
  return phase !== undefined && phase !== 'idle' ? 0 : phase === 'idle' || unshared ? 1 : 2
}

/** Work in progress first, then other open windows (shared or not), then saved history. */
export function compareActivity(a: Activity, b: Activity): number {
  return tier(a) - tier(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}
