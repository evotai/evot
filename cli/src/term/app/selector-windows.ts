import type { ConfigInfo } from '../../native/contracts/config-info.js'
import type { Hint } from '../design/key-hints.js'
import {
  selectorFocusOn,
  type SelectorEffort,
  type SelectorItem,
  type SelectorState,
} from '../selector.js'
import { createAppSelectorState } from './selector-identity.js'
import { currentModelSpec, modelOptions, modelSelectorItems } from './provider.js'
import { RESUME_SELECTOR_TITLE } from './resume.js'
import { browseWindow } from './browse-window.js'

/** One factory for preview and explicitly opened model windows. */
/** Enter uses a model for this session; Space only saves the highlighted row
 *  as the account default (the picker stays open, the live model stays put). */
export const MODEL_WINDOW_HINTS: Hint[] = [
  { keys: ['up', 'down'], action: 'move' },
  { keys: 'enter', action: 'use' },
  { keys: 'space', action: 'set default' },
  { keys: 'type', action: 'filter' },
  { keys: 'escape', action: 'close' },
]

export function createModelWindow(config: ConfigInfo | undefined, model: string, listFocused = false): SelectorState {
  const models = modelOptions(config, model)
  const activeSpec = currentModelSpec(config, model)
  return selectorFocusOn({
    ...createAppSelectorState('model', 'Models', modelSelectorItems(models, activeSpec, config?.thinkingLevel, config?.defaultModel)),
    presentation: 'model',
    circularNavigation: true,
    listFocused,
    hints: MODEL_WINDOW_HINTS,
  }, item => item.id === activeSpec)
}

/**
 * Carry already-adjusted tiers onto a freshly built row set.
 *
 * The catalog refreshes on a timer while the picker is open. Rebuilding rows
 * from the addon would silently reset a tier the user just moved, so an
 * adjusted row keeps its choice — but only when the incoming ladder is
 * identical. A changed ladder means the model's own capabilities moved, and the
 * server's ordering then wins over a stale index.
 */
export function carryModelEfforts(previous: SelectorItem[], next: SelectorItem[]): SelectorItem[] {
  const adjusted = new Map<string, SelectorEffort>()
  for (const item of previous) {
    if (item.effort && item.id !== undefined) adjusted.set(item.id, item.effort)
  }
  if (adjusted.size === 0) return next
  return next.map(item => {
    const carried = item.id === undefined ? undefined : adjusted.get(item.id)
    if (!carried || !item.effort) return item
    const sameLadder = carried.levels.length === item.effort.levels.length
      && carried.levels.every((level, at) => level === item.effort!.levels[at])
    return sameLadder ? { ...item, effort: carried } : item
  })
}

/**
 * Resume list window.
 *
 * `listFocused` mirrors `createModelWindow`'s flag for the same reason: the
 * command preview is driven by the composer's text, while Enter/↑ opens a list
 * that owns its own letters. Only the focused list treats `e`/`d` as actions;
 * the preview keeps typing as search.
 */
export function createResumeWindow(
  items: SelectorItem[],
  initialQuery?: string,
  listFocused = false,
): SelectorState {
  const state = createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items, items, initialQuery)
  return {
    ...browseWindow(state, listFocused),
    ...(state.query.length === 0 && state.items.length === 0 && state.allItems.some(item => !item.header)
      ? { emptyMessage: listFocused
        ? 'No sessions in current cwd · press / to search all sessions'
        : 'No sessions in current cwd · type to search all sessions' }
      : {}),
  }
}
