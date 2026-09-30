import { relativeTime } from '../../render/format.js'
import { selectorExpandItems, selectorRemoveItem, type SelectorItem, type SelectorState } from '../selector.js'
import { createAppSelectorState } from './selector-identity.js'
import { browseWindow } from './browse-window.js'

/** One published link. Sessions and tasks share the table, the quota and the
 *  revocation gesture; `kind` tells them apart and an absent kind is a session
 *  from a server that predates task shares. */
export interface SharedSession {
  id: string
  url: string
  title?: string | null
  created_at?: number | null
  size_bytes?: number | null
  kind?: string
  source_id?: string
  summary?: unknown
}

export type ShareKind = 'session' | 'task'

export function shareKind(share: SharedSession): ShareKind {
  return share.kind === 'task' ? 'task' : 'session'
}

/** The same gestures as `/sessions` and `/task`: letters are actions while the
 *  list owns the input, `d d` deletes, `/` searches. */
const HINTS = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'details' },
  { keys: 'enter', action: 'open' },
  { keys: '/', action: 'search' },
  { keys: 'd', action: 'delete' },
  { keys: 'escape', action: 'close' },
]

function taskFacts(summary: unknown): string[] {
  if (!summary || typeof summary !== 'object') return []
  const facts = summary as Record<string, unknown>
  const str = (key: string) => typeof facts[key] === 'string' ? (facts[key] as string) : ''
  const lines: string[] = []
  if (str('cron')) lines.push(`Schedule: ${[str('cron'), str('timezone')].filter(Boolean).join(' · ')}`)
  const model = facts.model_policy === 'default'
    ? 'Device default at run time'
    : [str('model'), str('thinking_level')].filter(Boolean).join(' · ')
  if (model) lines.push(`Model: ${model}`)
  if (typeof facts.source_task_revision === 'number') lines.push(`Task revision: ${facts.source_task_revision}`)
  return lines
}

function preview(share: SharedSession): string[] {
  const head = [share.title || '(untitled)', share.url, '', ...created(share.created_at)]
  if (shareKind(share) === 'task') {
    return [...head, ...source(share.source_id, 'Task'), ...taskFacts(share.summary), '',
      'Anyone with the link can read the instruction.',
      'Deleting revokes this link, not the task.']
  }
  return [...head, ...source(share.source_id, 'Session'), ...size(share.size_bytes),
    'Anyone with the link can read this snapshot.',
    'Deleting revokes this link, not the local session.']
}

function row(share: SharedSession): SelectorItem {
  const kind = shareKind(share)
  return {
    id: share.id,
    label: share.title || '(untitled)',
    status: { text: age(share.created_at), tone: 'muted' },
    detail: `${kind} · ${share.id.slice(0, 8)}`,
    group: kind === 'task' ? 'Tasks' : 'Sessions',
    searchText: `${kind} ${share.title ?? ''} ${share.id} ${share.url} ${share.source_id ?? ''}`,
    preview: preview(share),
    hints: HINTS,
  }
}

/** Tasks first, then sessions, each under a header when both kinds exist;
 *  a list of one kind stays flat so nothing changes for people who only
 *  ever shared sessions. */
export function shareSelectorState(shares: SharedSession[]): SelectorState {
  const tasks = shares.filter(share => shareKind(share) === 'task').map(row)
  const sessions = shares.filter(share => shareKind(share) === 'session').map(row)
  const mixed = tasks.length > 0 && sessions.length > 0
  const header = (label: string): SelectorItem => ({ label, header: true, focusable: false, group: label })
  const items = mixed
    ? [header('Tasks'), ...tasks, header('Sessions'), ...sessions]
    : [...tasks, ...sessions]
  const state = createAppSelectorState('shares', 'Shared links', items)
  return {
    ...browseWindow(state, true),
    searchHint: 'titles, ids and links',
    ...(shares.length ? {} : { emptyMessage: 'No shared links yet · /share publishes a session, s in /task publishes a task' }),
  }
}

export interface ShareSelectorDeps {
  list(): Promise<SharedSession[]>
  delete(id: string): Promise<void>
  open(url: string): Promise<void>
  current(): SelectorState | undefined
  publish(state: SelectorState): void
}

/** Each opening is a separate controller: stale requests cannot replace another list. */
export class ShareSelector {
  private shares: SharedSession[] = []
  private deleting = new Set<string>()

  constructor(private readonly deps: ShareSelectorDeps) {}

  async load(): Promise<void> {
    const loading = { ...shareSelectorState([]), emptyMessage: 'Loading shared links…' }
    this.deps.publish(loading)
    try {
      this.shares = await this.deps.list()
      const current = this.deps.current()
      if (current) {
        const loaded = shareSelectorState(this.shares)
        this.deps.publish({
          ...selectorExpandItems(current, loaded.allItems),
          subtitle: loaded.subtitle,
          emptyMessage: loaded.emptyMessage,
        })
      }
    } catch (error) {
      const current = this.deps.current()
      if (current) this.deps.publish({ ...current, emptyMessage: 'Could not load shared links', subtitle: message(error) })
    }
  }

  async open(id: string): Promise<void> {
    const share = this.shares.find(share => share.id === id)
    if (!share) return
    try { await this.deps.open(share.url) } catch (error) {
      const current = this.deps.current()
      if (current) this.deps.publish({ ...current, subtitle: message(error) })
    }
  }

  async delete(id: string): Promise<void> {
    if (this.deleting.has(id)) return
    this.deleting.add(id)
    try {
      await this.deps.delete(id)
      this.shares = this.shares.filter(share => share.id !== id)
      const current = this.deps.current()
      if (current) {
        const index = current.items.findIndex(item => item.id === id)
        // Remove by id even when a search/movement occurred during the request.
        const pool = current.allItems.filter(item => item.id !== id)
        const next = index >= 0 ? selectorRemoveItem(current, index) : { ...current, allItems: pool }
        this.deps.publish({ ...next, allItems: pool, pendingDeleteId: undefined, subtitle: 'Share deleted.' })
      }
    } catch (error) {
      const current = this.deps.current()
      if (current) this.deps.publish({ ...current, pendingDeleteId: undefined, subtitle: message(error) })
    } finally { this.deleting.delete(id) }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function age(createdAt: number | null | undefined): string {
  return typeof createdAt === 'number' ? relativeTime(new Date(createdAt).toISOString()) : ''
}

function created(createdAt: number | null | undefined): string[] {
  return typeof createdAt === 'number' ? [`Created: ${new Date(createdAt).toLocaleString()}`] : []
}

function source(sourceId: string | undefined, label: string): string[] {
  return sourceId ? [`${label}: ${sourceId}`] : []
}

function size(sizeBytes: number | null | undefined): string[] {
  return typeof sizeBytes === 'number' ? [`Size: ${(sizeBytes / 1024).toFixed(1)} KiB`] : []
}
