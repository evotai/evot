import type { Agent, CloudPushProgress, CloudPushResult, SessionMeta } from '../native/index.js'
import { resolveSessionByPrefix } from '../term/app/resume.js'
import { createHyperlink } from '../render/hyperlink.js'
import { describeShareResult, shareAccess } from '../session/cloud-sessions.js'
import type { ProgressBar, ProgressBarOptions } from '../term/progress-bar.js'

export interface ShareContext {
  agent: Pick<Agent, 'listSessions' | 'cloudShareSession' | 'cloudUnshareSession' | 'cloudPushSession' | 'cloudForkRemoteSession' | 'importSharedSession'>
  /** One in-place progress row for a long upload; absent in hosts without a terminal. */
  progressBar?(options: ProgressBarOptions): ProgressBar
  openShareList(): Promise<void>
  /** Legacy one-shot share links, kept so they can still be revoked. */
  openShareLinks?(): Promise<void>
  getSessionId(): string | null
  flushShareNotices?(): Promise<void>
  isBusy?(): boolean
  commitSystem(id: string, text: string): void
  requestRender(): void
  /** The list caches remote state; tell it what just happened. */
  cloudAcknowledged?(sessionId: string, result: CloudPushResult): void
  cloudForgotten?(sessionId: string): void
  /** `/share cloud` and `/share <url>` land in the fetched copy. */
  resumeSession?(session: SessionMeta): Promise<void>
}

const USAGE = 'Usage: /share [public | team | private | off | list] [session-id | url]'

/**
 * Run an upload behind one progress row. Without a bar factory (tests, hosts
 * with no terminal) the notice is shown once and the result follows it.
 */
async function withUploadProgress(
  ctx: ShareContext,
  show: (text: string) => void,
  label: string,
  upload: (onProgress: (progress: CloudPushProgress) => void) => Promise<CloudPushResult>,
): Promise<{ result: CloudPushResult; finish: (text: string) => void }> {
  const bar = ctx.progressBar?.({ label, unit: 'entries', pending: 'preparing…' })
  if (!bar) {
    show(label)
    ctx.requestRender()
    const result = await upload(() => {})
    return { result, finish: show }
  }
  try {
    const result = await upload(progress => bar.set(progress.uploaded_entries, progress.total_entries))
    return { result, finish: text => bar.finish(text) }
  } catch (error) {
    // The row must not stay at 40% forever; the error line follows it.
    bar.finish(`${label} — failed`)
    throw error
  }
}

/** A pasted share page, as opposed to a visibility word or a local id. */
export function isShareLink(arg: string): boolean {
  return /^(https?:\/\/)?[^\s/]+\/(?:share|team)\/[A-Za-z0-9_-]{22}(?:\/(?:content|session\.json))?(?:[?#][^\s]*)?$/.test(arg)
}
const WORDS = new Set(['public', 'team', 'private', 'off', 'list', 'links', 'cloud', 'local'])

/**
 * `/share` opens the cloud session list without changing the current session.
 * `private` enables private sync; `team` adds a read-only page for signed-in
 * members of the owner's group; `public` publishes one for anyone with the link.
 * Commands orchestrate only; persistence, auth and transport remain native.
 */
export async function runShareCommand(ctx: ShareContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const show = (text: string) => ctx.commitSystem('sys-share', text)
  if (parts.length === 1 && isShareLink(parts[0]!)) {
    // A public or team share becomes a local session; the original is
    // unchanged. The server checks team membership for team links.
    try {
      if (ctx.isBusy?.()) throw new Error('Wait for the current run to finish before importing.')
      show('Fetching the shared session…')
      ctx.requestRender()
      const fork = await ctx.agent.importSharedSession(parts[0]!)
      show(`☁ Shared session saved as ${fork.session_id.slice(0, 8)} · continue here; the original is untouched`)
      await ctx.resumeSession?.(fork)
    } catch (error) {
      ctx.commitSystem('sys-share-error', `Import failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  // A bare command is navigation, like /sessions. Keep the historical
  // /share <id> form for explicit targets, without changing their visibility.
  const word = parts.length === 0 ? 'list' : parts[0] && WORDS.has(parts[0]) ? parts.shift()! : 'keep'
  const target = parts.shift()
  try {
    if (parts.length > 0) throw new Error(USAGE)
    if (word === 'list') {
      if (target) throw new Error(USAGE)
      await ctx.openShareList()
      return
    }
    if (word === 'links') {
      await ctx.openShareLinks?.()
      return
    }
    if (ctx.isBusy?.()) throw new Error('Wait for the current run to finish before sharing.')
    let sid = ctx.getSessionId()
    if (target) {
      if (!/^[0-9a-f-]{1,36}$/i.test(target)) throw new Error(USAGE)
      const resolved = resolveSessionByPrefix(await ctx.agent.listSessions(0), target)
      if (resolved.kind !== 'matched') throw new Error(`Session ${resolved.kind === 'none' ? 'not found' : 'id is ambiguous'}: ${target}`)
      sid = resolved.session.session_id
    }
    if (!sid) throw new Error('No active session to share.')
    await ctx.flushShareNotices?.()

    if (word === 'off') {
      await ctx.agent.cloudUnshareSession(sid)
      ctx.cloudForgotten?.(sid)
      show('Removed from cloud · local copy kept')
      return
    }
    if (word === 'cloud') {
      // Divergence, cloud side: the server copy becomes a fresh local session
      // and the diverged local one stays as it is.
      show('Fetching the cloud copy…')
      ctx.requestRender()
      const fork = await ctx.agent.cloudForkRemoteSession(sid)
      show(`☁ Cloud copy saved as ${fork.session_id.slice(0, 8)} · the local version stays as it was`)
      await ctx.resumeSession?.(fork)
      return
    }
    if (word === 'local') {
      // Divergence, local side: overwrite the server copy wholesale.
      const { result, finish } = await withUploadProgress(ctx, show, 'Replacing the cloud copy',
        onProgress => ctx.agent.cloudPushSession(sid, true, onProgress))
      ctx.cloudAcknowledged?.(sid, result)
      finish(result.kind === 'synced' ? '☁ Cloud copy replaced with this session' : describeShareResult(result, 'private'))
      return
    }

    const requested = word as 'public' | 'team' | 'private' | 'keep'
    // Say what leaves the machine before it does: the page is public-by-link,
    // and turning it private later hides the page, not what was already read.
    if (requested === 'public') {
      ctx.commitSystem('sys-share-scope', '  transcript, system prompt and tool output go up — anyone with the link can read it')
    } else if (requested === 'team') {
      ctx.commitSystem('sys-share-scope', '  transcript, system prompt and tool output go up — members of your group who sign in can read it')
    }
    const label = requested === 'public' ? 'Publishing' : requested === 'team' ? 'Sharing with your team' : 'Syncing to the cloud'
    // A long session uploads in batches and can take minutes; one row shows
    // how far it has got, then becomes the result.
    const { result, finish } = await withUploadProgress(ctx, show, label,
      onProgress => ctx.agent.cloudShareSession(sid, requested, onProgress))
    ctx.cloudAcknowledged?.(sid, result)
    const visibility = result.kind === 'synced' ? shareAccess(result.cloud) : requested === 'keep' ? 'private' : requested
    const line = describeShareResult(result, visibility)
    const url = result.kind !== 'synced' ? null
      : visibility === 'public' ? result.cloud.public_url
      : visibility === 'team' ? result.cloud.team_url : null
    finish(url ? line.replace(url, createHyperlink(url)) : line)
    if (visibility === 'private' && result.kind === 'synced') show('  Page for your team or anyone? /share team · /share public')
  } catch (error) {
    ctx.commitSystem('sys-share-error', `Share failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
