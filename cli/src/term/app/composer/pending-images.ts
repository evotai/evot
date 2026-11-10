/**
 * Pending clipboard image loads.
 *
 * A pasted image shows its `[Image #N]` ref as soon as the clipboard probe
 * confirms one exists, while the bytes are still being extracted. That keeps the
 * composer responsive but opens a window where a submit could read the ref
 * before its data landed, silently sending the placeholder as plain text.
 *
 * This tracker owns that window: it knows which loads are still in flight, and
 * parks a submit until the ones the draft actually references have finished.
 */

import { parsePasteRefs } from '../../input/paste_refs.js'

/** Image ref ids in a draft, in appearance order. */
export function draftImageIds(text: string): number[] {
  return parsePasteRefs(text)
    .filter(ref => ref.type === 'image')
    .map(ref => ref.id)
}

export class PendingImages {
  private readonly loads = new Map<number, Promise<void>>()
  private parked = false

  /** True while a submit waits on in-flight loads. */
  get awaiting(): boolean {
    return this.parked
  }

  get size(): number {
    return this.loads.size
  }

  has(id: number): boolean {
    return this.loads.has(id)
  }

  /** Register an in-flight load, self-removing once it settles. */
  track(id: number, load: Promise<void>): Promise<void> {
    const tracked = load.finally(() => {
      this.loads.delete(id)
    })
    this.loads.set(id, tracked)
    return tracked
  }

  /**
   * Loads blocking this draft. Refs the user already deleted are excluded: their
   * bytes are discarded anyway, so waiting on them would stall for nothing.
   */
  blocking(text: string): Promise<void>[] {
    if (this.loads.size === 0) return []
    const ids = new Set(draftImageIds(text))
    const waits: Promise<void>[] = []
    for (const [id, load] of this.loads) {
      if (ids.has(id)) waits.push(load)
    }
    return waits
  }

  /**
   * Run `submit` once the draft's images have their bytes. Returns 'parked' when
   * the submit was deferred, 'ran' when it went through synchronously, and
   * 'ignored' for a repeat press while already parked.
   */
  gate(
    text: string,
    submit: () => void,
    onPark?: () => void,
  ): 'ran' | 'parked' | 'ignored' {
    // A second Enter while parked must not queue a duplicate submit.
    if (this.parked) return 'ignored'
    const waits = this.blocking(text)
    if (waits.length === 0) {
      submit()
      return 'ran'
    }
    this.parked = true
    onPark?.()
    void Promise.all(waits).then(() => {
      this.parked = false
      submit()
    })
    return 'parked'
  }
}
