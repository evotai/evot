import type { SessionMeta } from '../../../native/index.js'
import type { SelectorState } from '../../../ui/selector.js'
import { selectorExpandItems, selectorFocusOn } from '../../../ui/selector.js'
import { formatSessionItems } from '../../../session/resume.js'
import { ResumeSessionCache } from './resume-cache.js'
import type { SessionRenameState } from './session-rename-editor.js'

export interface SessionRenameHost {
  renameSession(id: string, title: string): Promise<SessionMeta>
  current(): SelectorState | undefined
  publish(state: SelectorState): void
  cache: ResumeSessionCache
  cwd: string
}

/** Effects boundary. Token identity prevents a late completion from reopening a
 * closed/replaced selector; the cache still learns about successful writes. */
export async function saveSessionRename(host: SessionRenameHost, token: SessionRenameState, title: string): Promise<void> {
  try {
    const session = await host.renameSession(token.sessionId, title)
    host.cache.rename(session)
    const rows = await (host.current()?.query.trim() ? host.cache.text() : host.cache.all())
      .catch(() => host.cache.metadata ?? [session])
    const text = await host.cache.loadSessionText(session.session_id)
    const current = host.current()
    if (current?.rename !== token) return
    const items = formatSessionItems(rows, host.cwd, id => id === session.session_id ? text ?? undefined : host.cache.sessionText(id))
    const next = selectorExpandItems({ ...current, rename: undefined }, items)
    const focused = selectorFocusOn(next, item => item.id === session.session_id)
    host.publish({ ...focused, subtitle: 'Session renamed' })
  } catch (error) {
    const current = host.current()
    if (current?.rename !== token) return
    host.publish({ ...current, rename: { ...token, saving: false, error: error instanceof Error ? error.message : 'Rename failed' } })
  }
}
