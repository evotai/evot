import type { PrivacyLive, PrivacyLiveNotice } from '../../native/contracts/privacy.js'

/** A record worth a card now, and how many of its values this session had
 * not seen masked before. */
export interface PrivacyHappening { notice: PrivacyLiveNotice; fresh: number }

/** What privacy did during this process, as it happens, for the transcript.
 *
 * Every model request masks the whole history again, so a card per record
 * would repeat itself each turn. A record earns a card only when it masks a
 * value this session has not had masked before (a new placeholder tag).
 * Blocked records surface as error cards where they stopped; the feed keeps
 * the latest one so that card can say where the values sat. */
export class PrivacyFeed {
  private cursor = 0
  private readonly seen = new Map<string, Set<string>>()
  private readonly blocked = new Map<string, PrivacyLiveNotice>()

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
      if (notice.session && session && notice.session !== session) continue
      const key = notice.session ?? session ?? ''
      if (notice.blocked) { this.blocked.set(key, notice); continue }
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

  /** The record behind the block that just stopped `session`'s request, if
   * this process made it. Polls first so a block raised a moment ago counts. */
  lastBlocked(session: string | null): PrivacyLiveNotice | undefined {
    this.poll(session)
    return this.blocked.get(session ?? '')
  }

  /** A new or switched session starts with nothing seen. */
  forget(session: string | null): void {
    this.seen.delete(session ?? '')
    this.blocked.delete(session ?? '')
  }

  /** A resumed session has had its history masked before: the tags its
   * records already hold are seen, so the first request does not report them
   * all as new. Tags are placeholders, never values. */
  seed(session: string | null, tags: Iterable<string>): void {
    const key = session ?? ''
    let seen = this.seen.get(key)
    if (!seen) { seen = new Set(); this.seen.set(key, seen) }
    for (const tag of tags) seen.add(tag)
  }
}
