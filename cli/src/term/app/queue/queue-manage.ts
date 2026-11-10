import type { KeyEvent } from '../../../ui/keys.js'
import type { SelectorItem } from '../../../ui/selector.js'
import type { SelectorState } from '../../../ui/selector.js'
import { createAppSelectorState } from '../../../ui/selector-identity.js'

export const QUEUE_SELECTOR_TITLE = 'Prompt queue'
export const QUEUE_MANAGE_SHORTCUT_HINT = 'ctrl+g'

/**
 * Queue-pane toggle key.
 *
 * Moved off ctrl+b, which is the conventional "run in background" chord and is
 * now bound to that. Ctrl+G is likewise a portable C0 control character and is
 * otherwise unclaimed here.
 */
export function isQueueManageShortcut(event: KeyEvent): boolean {
  return event.type === 'ctrl' && event.key === 'g'
}

export type PromptQueueKind = 'steering' | 'follow_up'

export type ManagedQueuedPrompt = {
  queue: PromptQueueKind
  id: string
  version: number
  text: string
}

export type QueueManageAction =
  | { kind: 'edit'; entry: ManagedQueuedPrompt }
  | { kind: 'remove'; entry: ManagedQueuedPrompt }
  | { kind: 'none' }

/** Collapse whitespace and truncate for selector labels. */
export function formatQueuePreview(text: string, maxChars = 80): string {
  const lines = text.split('\n')
  const first = lines.map(line => line.trim()).find(Boolean) ?? '(empty)'
  const extra = Math.max(0, lines.length - 1)
  const suffix = extra > 0 ? ` (+${extra} ${extra === 1 ? 'line' : 'lines'})` : ''
  const available = Math.max(1, maxChars - suffix.length)
  if (first.length <= available) return `${first}${suffix}`
  return `${first.slice(0, Math.max(1, available - 1))}…${suffix}`
}

function encodeEntryId(entry: ManagedQueuedPrompt): string {
  return `${entry.queue}|${entry.id}|${entry.version}`
}

/** Parse a selector item back into a managed queue entry. */
export function parseQueueSelectorItem(item: SelectorItem): ManagedQueuedPrompt | null {
  const raw = item.id
  if (!raw) return null
  const parts = raw.split('|')
  if (parts.length !== 3) return null
  const [queue, id, versionRaw] = parts
  if (queue !== 'steering' && queue !== 'follow_up') return null
  if (!id) return null
  const version = Number(versionRaw)
  if (!Number.isFinite(version) || version < 0) return null
  return {
    queue,
    id,
    version,
    text: item.searchText ?? item.label,
  }
}

/** Build selector items for the current run queue. */
export function formatQueueSelectorItems(entries: ManagedQueuedPrompt[]): SelectorItem[] {
  return entries.map((entry, index) => ({
    label: `#${index + 1} ${formatQueuePreview(entry.text)}`,
    id: encodeEntryId(entry),
    searchText: entry.text,
  }))
}

/** Open the queue manager selector for the given entries. */
export function createQueueSelectorState(entries: ManagedQueuedPrompt[]): SelectorState {
  const items = formatQueueSelectorItems(entries)
  return {
    ...createAppSelectorState('queue', QUEUE_SELECTOR_TITLE, items),
    subtitle: entries.length === 0 ? 'No queued prompts' : `${entries.length} queued`,
  }
}

/** Decide the management action for enter/delete on the focused item. */
export function decideQueueSelectorAction(
  item: SelectorItem | null,
  event: 'enter' | 'delete',
): QueueManageAction {
  if (!item) return { kind: 'none' }
  const entry = parseQueueSelectorItem(item)
  if (!entry) return { kind: 'none' }
  if (event === 'enter') return { kind: 'edit', entry }
  return { kind: 'remove', entry }
}
