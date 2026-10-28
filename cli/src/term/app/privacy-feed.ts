import type { PrivacyLive, PrivacyLiveNotice } from '../../native/contracts/privacy.js'

/** A record worth a card now, and how many of its values this session had
 * not seen masked before. */
export interface PrivacyHappening { notice: PrivacyLiveNotice; fresh: number }

/** What privacy did during this process, as it happens, for the transcript.
 *
 * Every model request masks the whole history again, so a card per record
 * would repeat itself each turn. A record earns a card only when it masks a
 * value this session has not had masked before (a new placeholder tag).
 * Blocked records already surface as error cards where they stopped; they
 * are skipped here. */
export class PrivacyFeed {
  private cursor = 0
  private readonly seen = new Map<string, Set<string>>()

  constructor(private readonly live: (after: number) => PrivacyLive) {}

  /** New happenings for `session` since the last poll, oldest first. */
  poll(session: string | null): PrivacyHappening[] {
    let batch: PrivacyLive
    try {
      batch = this.live(this.cursor)
    } catch {
      return []
    }
    this.cursor = Math.max(this.cursor, batch.cursor)
    const out: PrivacyHappening[] = []
    for (const notice of batch.notices) {
      if (notice.blocked) continue
      if (notice.session && session && notice.session !== session) continue
      const key = notice.session ?? session ?? ''
      let tags = this.seen.get(key)
      if (!tags) { tags = new Set(); this.seen.set(key, tags) }
      let fresh = 0
      for (const tag of notice.tags) {
        if (tags.has(tag)) continue
        tags.add(tag)
        fresh++
      }
      if (fresh === 0) continue
      out.push({ notice, fresh })
    }
    return out
  }

  /** A new or switched session starts with nothing seen. */
  forget(session: string | null): void {
    this.seen.delete(session ?? '')
  }
}
